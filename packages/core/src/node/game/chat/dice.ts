import { randomInt, randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import { diceOptionsSchema, parseDice, type DiceOptions } from "../../../shared/dice";
import { messageSchema } from "../../../shared/game";
import type { ChatMessage, Player } from "../../../shared/game";
import { assertSessionActive } from "../../sessions/session-store";
import { chatField } from "../../storage/session-database";
import { readCompanions } from "../companion";
import type { ChatContext, RoomState } from "./types";
type DiceContext = Pick<ChatContext, "state" | "store">;

/** 权威掷骰、超时结算与运行等待。 */
export class ChatDice {
  constructor(private readonly context: DiceContext) {}
  private rooms = new WeakMap<RoomState, Map<string, ReturnType<typeof setTimeout>>>();
  private timers(state: RoomState) {
    let timers = this.rooms.get(state);
    if (!timers) this.rooms.set(state, (timers = new Map()));
    return timers;
  }
  closeRoom(state: RoomState) {
    for (const timer of this.timers(state).values()) clearTimeout(timer);
    this.rooms.delete(state);
  }

  failPending(state: RoomState, runId?: string) {
    const pending = this.context.store.runningMessages(state, "dice").filter((message) => {
      if (message.kind !== "dice") return false;
      if (!runId) return !this.timers(state).has(message.id);
      if (!message.dice.sourceMessageId) return false;
      const source = this.context.store.message(state, message.dice.sourceMessageId);
      return (source.runId ?? source.id) === runId;
    });
    if (!pending.length) return;
    this.context.store.transaction(state, () => {
      for (const message of pending) {
        // 只更新仍未结算的消息；已提交的结果永远保留。
        const latest = this.context.store.message(state, message.id);
        if (latest.status !== "running") continue;
        this.context.store.save(state, {
          ...latest,
          status: "failed",
          error: "所属主持运行已结束，掷骰请求已失效。",
        });
      }
    });
    for (const message of pending) {
      clearTimeout(this.timers(state).get(message.id));
      this.timers(state).delete(message.id);
    }
  }

  async requestAndWaitForDice(
    state: RoomState,
    message: ChatMessage,
    latest: ChatMessage,
    options: DiceOptions,
    abort: AbortController,
  ): Promise<ChatMessage> {
    abort.signal.throwIfAborted();
    // AI 队友没有真人点击入口，即使主持误指定了它，也应立即结算。
    if (readCompanions(state.db).some((item) => item.id === options.targetPlayerId))
      options = { ...options, targetPlayerId: undefined };
    const requested = await this.requestAgentDice(
      { ...options, roomId: message.roomId, requestId: randomUUID() },
      {
        sourceMessageId: latest.id,
        sourceAttemptId: latest.attemptId,
        afterMessageIndex: latest.kind === "assistant" ? latest.agentMessages.length - 1 : -1,
      },
    );
    if (abort.signal.aborted) this.failPending(state, message.runId ?? message.id);
    while (true) {
      abort.signal.throwIfAborted();
      const result = this.context.store.message(state, requested.id);
      if (result.status === "complete") return result;
      if (result.status !== "running") throw new Error("掷骰请求已失效");
      await new Promise<void>((resolve) => {
        const done = () => {
          state.events.off("change", done);
          abort.signal.removeEventListener("abort", done);
          resolve();
        };
        state.events.once("change", done);
        abort.signal.addEventListener("abort", done, { once: true });
        if (abort.signal.aborted) done();
      });
    }
  }

  scheduleDice(state: RoomState, message: Extract<ChatMessage, { kind: "dice" }>) {
    if (this.timers(state).has(message.id)) return;
    if (message.dice.deadline <= Date.now()) {
      this.resolveDice(state, message.id, message.dice.targetPlayerId ? "timeout" : "immediate");
      return;
    }
    const timer = setTimeout(
      () => {
        this.timers(state).delete(message.id);
        try {
          this.resolveDice(state, message.id, "timeout");
        } catch {
          /* 未提交不广播，下次访问房间时重新恢复。 */
        }
      },
      Math.max(0, message.dice.deadline - Date.now()),
    );
    this.timers(state).set(message.id, timer);
  }

  private resolveDice(
    state: RoomState,
    id: string,
    source: "click" | "timeout" | "immediate",
    player?: Player,
  ): ChatMessage {
    assertSessionActive(state.db);
    return this.context.store.transaction(state, () => {
      const message = this.context.store.message(state, id);
      if (message.kind !== "dice")
        throw new ORPCError("BAD_REQUEST", { message: "这不是掷骰请求" });
      if (
        source === "click" &&
        message.dice.targetPlayerId &&
        message.dice.targetPlayerId !== player?.id
      )
        throw new ORPCError("FORBIDDEN", { message: "请由指定玩家掷骰" });
      if (message.status === "complete") return message;
      if (message.status !== "running")
        throw new ORPCError("CONFLICT", { message: "掷骰请求已失效" });
      const { count, sides, modifier } = parseDice(message.dice.expression);
      const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
      const result = this.context.store.save(state, {
        ...message,
        status: "complete",
        dice: {
          ...message.dice,
          rolls,
          total: rolls.reduce((sum, value) => sum + value, modifier),
          resolvedAt: Date.now(),
          resolvedBy:
            source === "click" && Date.now() >= message.dice.deadline ? "timeout" : source,
        },
      });
      clearTimeout(this.timers(state).get(id));
      this.timers(state).delete(id);
      return result;
    });
  }

  async requestAgentDice(
    input: DiceOptions & { roomId: string; requestId: string },
    origin?: { sourceMessageId: string; sourceAttemptId?: string; afterMessageIndex: number },
  ) {
    const options = diceOptionsSchema.parse(input);
    const state = await this.context.state(input.roomId);
    const existing = state.db.get(
      state.db.query.selectFrom("chat_messages").select("data").where("id", "=", input.requestId),
    );
    const expression = parseDice(options.expression).expression;
    if (existing) {
      const message = messageSchema.parse(JSON.parse(String(existing.data)));
      if (
        message.kind !== "dice" ||
        message.senderId !== "agent" ||
        message.dice.expression !== expression ||
        message.dice.reason !== options.reason ||
        message.dice.targetPlayerId !== options.targetPlayerId
      )
        throw new ORPCError("CONFLICT", { message: "重复的掷骰请求内容不同" });
      return message;
    }
    let targetNickname: string | undefined;
    if (options.targetPlayerId) {
      const target = state.db.get(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("kind"), "=", "player")
          .where(chatField("senderId"), "=", options.targetPlayerId)
          .orderBy("sequence", "desc")
          .limit(1),
      );
      targetNickname = target
        ? messageSchema.parse(JSON.parse(String(target.data))).nickname
        : undefined;
      if (!targetNickname)
        throw new ORPCError("BAD_REQUEST", { message: "指定玩家尚未加入该房间" });
    }
    const source = origin && this.context.store.message(state, origin.sourceMessageId);
    const expired =
      source && (source.status !== "running" || source.attemptId !== origin?.sourceAttemptId);
    const message = this.context.store.transaction(state, () =>
      this.context.store.save(state, {
        id: input.requestId,
        roomId: input.roomId,
        sequence: 0,
        revision: 0,
        senderId: "agent",
        nickname: "主持人",
        kind: "dice",
        createdAt: new Date().toISOString(),
        status: expired ? "failed" : "running",
        ...(expired ? { error: "所属主持运行已结束，掷骰请求已失效。" } : {}),
        dice: {
          ...options,
          ...origin,
          expression,
          targetNickname,
          deadline: Date.now() + (options.targetPlayerId ? 30_000 : 0),
        },
      }),
    );
    if (message.kind !== "dice") throw new Error("掷骰消息无效");
    if (message.status !== "running") return message;
    if (!options.targetPlayerId) return this.resolveDice(state, message.id, "immediate");
    this.scheduleDice(state, message);
    return message;
  }

  async rollDice(input: { roomId: string; messageId: string }, player: Player) {
    return this.resolveDice(
      await this.context.state(input.roomId),
      input.messageId,
      "click",
      player,
    );
  }
}
