import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import {
  steeringEntrySchema,
  type ChatMessage,
  type Player,
  type SteeringSnapshot,
} from "../../../shared/game";
import { parseMentionRefs, resolveMentionRefs } from "../../../shared/mentions";
import { type ReceivedSteering, type SteeringBatch } from "../../agent/steering-batch";
import { assertPlayerReady, readCharacters } from "../../sessions/character-db";
import { readRoomSettings, updateRoomSettings } from "../../sessions/room-settings";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { publicMentionTargets } from "../companion";
import { playerTurnPrompt } from "../player-turn";
import type { ChatRuns } from "./runs";
import type { ChatContext, RoomState, Runtime } from "./types";

export function assertHost(isHost: boolean) {
  if (!isHost) throw new ORPCError("FORBIDDEN", { message: "只有房主可以执行此操作" });
}

type SteeringContext = ChatContext & { runtime: Runtime };
const queuedStates = ["pending", "manual", "claimed"];

/** SQLite 队列保留到 Pi 落盘确认；所有选取与权限裁定均在主机完成。 */
export class ChatSteering {
  constructor(private readonly context: SteeringContext) {}
  private runs?: ChatRuns;
  attachRuns(runs: ChatRuns) {
    this.runs = runs;
  }

  snapshot(state: RoomState): SteeringSnapshot {
    return {
      enabled: readRoomSettings(roomDirectoryForDatabase(state.db)).chat.steeringEnabled,
      revision: state.db.get(state.db.query.selectFrom("steering_meta").select("revision"))!
        .revision,
      entries: state.db
        .all(
          state.db.query
            .selectFrom("steering_requests")
            .selectAll()
            .where("state", "in", queuedStates)
            .orderBy("sequence", "asc"),
        )
        .map((row) =>
          steeringEntrySchema.parse({
            ...JSON.parse(row.data),
            sequence: row.sequence,
            state: row.state,
          }),
        ),
    };
  }
  private changed(state: RoomState) {
    state.db.run(
      state.db.query
        .updateTable("steering_meta")
        .set((eb) => ({ revision: eb("revision", "+", 1) }))
        .where("id", "=", 1),
    );
    this.context.store.event(state, { type: "steering", snapshot: this.snapshot(state) });
  }
  private hasClaim(state: RoomState) {
    return Boolean(
      state.db.get(
        state.db.query
          .selectFrom("steering_requests")
          .select("id")
          .where("state", "=", "claimed")
          .limit(1),
      ),
    );
  }
  async get(roomId: string) {
    return this.snapshot(await this.context.state(roomId, true));
  }

  async enqueue(input: { roomId: string; clientRequestId: string; text: string }, player: Player) {
    const state = await this.context.state(input.roomId);
    const text = input.text.trim();
    if (!text || text.length > 4000)
      throw new ORPCError("BAD_REQUEST", { message: "插话应为 1 至 4000 个字符" });
    if (
      resolveMentionRefs(
        parseMentionRefs(text),
        (
          await publicMentionTargets(state.db, [...this.context.activity.players(state), player])
        ).filter((target) => target.id !== player.id),
      ).length
    )
      throw new ORPCError("BAD_REQUEST", {
        message: "点名交流属于聊天，请通过聊天发送，输入已保留。",
      });
    const prior = () =>
      state.db.get(
        state.db.query
          .selectFrom("steering_requests")
          .selectAll()
          .where("player_id", "=", player.id)
          .where("request_id", "=", input.clientRequestId),
      );
    const existing = prior();
    if (existing) {
      if (JSON.parse(existing.data).text !== text)
        throw new ORPCError("CONFLICT", { message: "重复请求的插话内容不同" });
      return this.snapshot(state);
    }
    try {
      assertPlayerReady(state.db, player.id);
    } catch (error) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: error instanceof Error ? error.message : "请先确认角色并完成开场",
      });
    }
    return this.context.store.transaction(state, () => {
      const repeated = prior();
      if (repeated) {
        if (JSON.parse(repeated.data).text !== text)
          throw new ORPCError("CONFLICT", { message: "重复请求的插话内容不同" });
        return this.snapshot(state);
      }
      const snapshot = this.snapshot(state);
      const running = this.context.activity.running(state);
      const active = running && this.context.store.message(state, running.messageId);
      if (
        !snapshot.enabled ||
        !running ||
        active?.kind !== "assistant" ||
        active.companionId ||
        active.chatOnly ||
        running.abort.signal.aborted ||
        state.closed ||
        this.context.isClosing()
      )
        throw new ORPCError("CONFLICT", {
          message: "主持插话未开启或当前主持运行已结束，输入已保留",
        });
      if (snapshot.entries.length >= 5)
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "房间最多保留 5 条插话，请等待接收或先删除",
        });
      if (snapshot.entries.filter((item) => item.playerId === player.id).length >= 2)
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "每名玩家最多保留 2 条插话，请等待接收或先删除",
        });
      const entry = {
        id: randomUUID(),
        playerId: player.id,
        nickname: player.nickname,
        text,
        createdAt: new Date().toISOString(),
      };
      state.db.run(
        state.db.query.insertInto("steering_requests").values({
          id: entry.id,
          request_id: input.clientRequestId,
          player_id: player.id,
          state: "pending",
          run_id: running.runId,
          batch_id: null,
          data: JSON.stringify(entry),
        }),
      );
      this.changed(state);
      return this.snapshot(state);
    });
  }

  async remove(roomId: string, entryId: string, player: Player, isHost: boolean) {
    const state = await this.context.state(roomId);
    return this.context.store.transaction(state, () => {
      const entry = state.db.get(
        state.db.query.selectFrom("steering_requests").selectAll().where("id", "=", entryId),
      );
      if (!entry) throw new ORPCError("NOT_FOUND", { message: "插话不存在" });
      if (entry.player_id !== player.id) assertHost(isHost);
      if (entry.state === "revoked") return this.snapshot(state);
      if (entry.state !== "pending" && entry.state !== "manual")
        throw new ORPCError("CONFLICT", { message: "插话正在接收或已接收，不能撤回，请刷新队列" });
      state.db.run(
        state.db.query
          .updateTable("steering_requests")
          .set({ state: "revoked" })
          .where("id", "=", entryId),
      );
      this.changed(state);
      return this.snapshot(state);
    });
  }

  async setEnabled(roomId: string, enabled: boolean, isHost: boolean) {
    assertHost(isHost);
    const state = await this.context.state(roomId);
    if (this.hasClaim(state))
      throw new ORPCError("CONFLICT", { message: "正在接收插话，请稍后切换" });
    // 先持久保留旧队列，再写独立设置文件；即使后者失败也不会在重开后自动消费旧输入。
    if (!enabled || !this.snapshot(state).enabled) this.hold(state);
    return this.context.store.transaction(state, () => {
      updateRoomSettings(roomDirectoryForDatabase(state.db), (settings) => ({
        ...settings,
        chat: { ...settings.chat, steeringEnabled: enabled },
      }));
      this.changed(state);
      return this.snapshot(state);
    });
  }

  /** 同步锁定批次，随后只允许 Pi 落盘确认或恢复释放。 */
  claim(
    state: RoomState,
    runId: string,
    previous: ChatMessage | null,
    next: ChatMessage,
    requestKey?: string,
  ): SteeringBatch | undefined {
    if (state.closed || this.context.isClosing() || this.hasClaim(state)) return;
    const snapshot = this.snapshot(state);
    const entries = snapshot.entries.filter(
      (entry) => requestKey || (snapshot.enabled && entry.state === "pending"),
    );
    const selected = requestKey
      ? entries
      : entries.filter(
          (entry) =>
            state.db.get(
              state.db.query
                .selectFrom("steering_requests")
                .select("run_id")
                .where("id", "=", entry.id),
            )?.run_id === runId,
        );
    if (!selected.length) return;
    const characters = readCharacters(state.db);
    const batch: SteeringBatch = {
      id: randomUUID(),
      runId,
      previousMessageId: previous?.id ?? null,
      entries: selected,
      nextMessage: next,
      prompt: `玩家在主持生成期间补充了以下行动或问题，请结合已发生的结果继续，不重复结算：\n${playerTurnPrompt(selected.map((entry) => ({ playerId: entry.playerId, text: entry.text, characterName: characters.find((c) => c.playerId === entry.playerId)?.name })))}`,
    };
    this.context.store.transaction(state, () => {
      state.db.run(
        state.db.query.insertInto("steering_batches").values({
          id: batch.id,
          request_key: requestKey ?? null,
          data: JSON.stringify(batch),
          received: 0,
        }),
      );
      state.db.run(
        state.db.query
          .updateTable("steering_requests")
          .set({ state: "claimed", batch_id: batch.id })
          .where(
            "id",
            "in",
            selected.map((e) => e.id),
          ),
      );
      this.changed(state);
    });
    return batch;
  }

  /** Pi 标记是接收凭据；聊天投影与队列终态在一个 SQLite 事务中补齐。 */
  receive(state: RoomState, received: ReceivedSteering, live = true): ChatMessage {
    const { batch, reference } = received;
    const record = state.db.get(
      state.db.query.selectFrom("steering_batches").selectAll().where("id", "=", batch.id),
    );
    if (record?.received) return this.context.store.message(state, batch.nextMessage.id);
    return this.context.store.transaction(state, () => {
      if (batch.previousMessageId) {
        const previous = this.context.store.message(state, batch.previousMessageId);
        this.context.store.save(state, { ...previous, status: "complete", error: undefined });
      }
      for (const entry of batch.entries) {
        if (
          !state.db.get(
            state.db.query.selectFrom("chat_messages").select("id").where("id", "=", entry.id),
          )
        )
          this.context.store.save(state, {
            id: entry.id,
            sequence: 0,
            revision: 0,
            roomId: batch.nextMessage.roomId,
            senderId: entry.playerId,
            nickname: entry.nickname,
            createdAt: entry.createdAt,
            kind: "player",
            text: entry.text,
            chatOnly: false,
            status: "complete",
          });
      }
      const placeholder = state.db.get(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where("id", "=", batch.nextMessage.id),
      );
      const next = placeholder ? (JSON.parse(placeholder.data) as ChatMessage) : batch.nextMessage;
      // 手动提交的内部占位消息要排在玩家消息之后；id 与 revision 保持稳定。
      if (placeholder)
        state.db.run(state.db.query.deleteFrom("chat_messages").where("id", "=", next.id));
      const message = this.context.store.save(state, {
        ...next,
        sequence: 0,
        internal: false,
        pi: reference,
        status: live ? "running" : "interrupted",
        ...(live ? {} : { error: "上次生成已中断，请从当前状态继续。" }),
      } as ChatMessage);
      state.db.run(
        state.db.query
          .updateTable("steering_requests")
          .set({ state: "received" })
          .where(
            "id",
            "in",
            batch.entries.map((e) => e.id),
          ),
      );
      if (record)
        state.db.run(
          state.db.query
            .updateTable("steering_batches")
            .set({ received: 1 })
            .where("id", "=", batch.id),
        );
      else
        state.db.run(
          state.db.query
            .insertInto("steering_batches")
            .values({ id: batch.id, request_key: null, data: JSON.stringify(batch), received: 1 }),
        );
      this.changed(state);
      return message;
    });
  }

  hold(state: RoomState, runId?: string) {
    let query = state.db.query
      .updateTable("steering_requests")
      .set({ state: "manual" })
      .where("state", "=", "pending");
    if (runId) query = query.where("run_id", "=", runId);
    if (
      !state.db.get(
        state.db.query
          .selectFrom("steering_requests")
          .select("id")
          .where("state", "=", "pending")
          .limit(1),
      )
    )
      return;
    this.context.store.transaction(state, () => {
      if (state.db.run(query).changes) this.changed(state);
    });
  }

  async recover(state: RoomState) {
    if (this.context.activity.running(state)) return;
    const prepared = state.db.all(
      state.db.query.selectFrom("steering_batches").selectAll().where("received", "=", 0),
    );
    if (prepared.length) {
      const markers =
        (await this.context.runtime.history?.steeringBatches(roomDirectoryForDatabase(state.db))) ??
        [];
      for (const marker of markers)
        if (prepared.some((row) => row.id === marker.batch.id)) this.receive(state, marker, false);
      this.context.store.transaction(state, () => {
        state.db.run(
          state.db.query
            .updateTable("steering_requests")
            .set({ state: "manual", batch_id: null })
            .where("state", "=", "claimed"),
        );
        // 未落盘的批次允许以同一请求重新提交；已落盘的请求记录永久去重。
        state.db.run(state.db.query.deleteFrom("steering_batches").where("received", "=", 0));
        this.changed(state);
      });
    }
    this.hold(state);
  }

  async submit(
    input: { roomId: string; clientRequestId: string; interrupt: boolean },
    player: Player,
    isHost: boolean,
  ) {
    assertHost(isHost);
    const state = await this.context.state(input.roomId);
    const requestKey = JSON.stringify([player.id, input.clientRequestId]);
    if (
      state.db.get(
        state.db.query
          .selectFrom("steering_batches")
          .select("id")
          .where("request_key", "=", requestKey)
          .where("received", "=", 1),
      )
    )
      return this.snapshot(state);
    if (!this.snapshot(state).entries.length)
      throw new ORPCError("PRECONDITION_FAILED", { message: "没有待提交的插话" });
    const running = this.context.activity.running(state);
    if (
      running &&
      (!input.interrupt ||
        this.context.store.message(state, running.messageId).senderId !== "agent")
    )
      throw new ORPCError("CONFLICT", { message: "请等待主持生成结束，或选择直接打断" });
    if (this.hasClaim(state) || this.context.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "正在交接插话，请稍后重试" });
    const release = this.context.activity.beginHandoff(state);
    try {
      if (running) {
        running.abort.abort();
        await running.done;
      }
      const auth = await this.context.credentials(input.roomId);
      if (state.closed || this.context.isClosing())
        throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭" });
      await this.recover(state);
      const id = randomUUID();
      const message: ChatMessage = {
        id,
        runId: id,
        attemptId: randomUUID(),
        sequence: 0,
        revision: 0,
        roomId: input.roomId,
        senderId: "agent",
        nickname: "主持人",
        kind: "assistant",
        agentMessages: [],
        internal: true,
        createdAt: new Date().toISOString(),
        status: "running",
      };
      const batch = this.claim(state, id, null, message, requestKey);
      if (!batch) throw new ORPCError("CONFLICT", { message: "队列已变化，请重新查看" });
      // 内部占位不出现在正文中；接收成功后才移动到玩家消息后并公开。
      const saved = this.context.store.transaction(state, () =>
        this.context.store.save(state, message),
      );
      this.runs!.start(state, saved, "请处理刚刚接收的玩家补充。", auth, {
        steeringBatch: batch,
        react: true,
      });
      return this.snapshot(state);
    } finally {
      release();
    }
  }
}
