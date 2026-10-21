import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { emptyFlowRun } from "@tarp/module/flow";

import type { Player } from "../../../shared/game";
import type { LaunchAction } from "../../../shared/launch";
import { readCharacters } from "../../sessions/character-db";
import {
  readLaunchConfig,
  allLaunchProgress,
  hasLaunchProgress,
  readLaunchProgress,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "../../sessions/launch-db";
import { launchStart, launchState, advanceLaunch } from "../../sessions/launch-store";
import { isSessionActive } from "../../sessions/session-store";
import { chatField } from "../../storage/session-database";
import { projectLaunch } from "../room-state-projection";
import type { ChatLaunchCards } from "./launch-cards";
import type { ChatNarration } from "./narration";
import type { ChatRuns } from "./runs";
import type { ChatContext } from "./types";
type LaunchContext = Pick<ChatContext, "root" | "state" | "store" | "activity" | "credentials"> & {
  readonly liveNarration: boolean;
  runs: Pick<ChatRuns, "start">;
  cards: ChatLaunchCards;
  narration: ChatNarration;
};

/** 开局进度与聊天流程卡片。 */
export class ChatLaunch {
  constructor(private readonly context: LaunchContext) {}

  async openLaunch(roomId: string, player: Player): Promise<void> {
    const state = await this.context.state(roomId);
    if (!readLaunchProgress(state.db, player.id).confirmed) throw new Error("请先确认角色");
    const setup = readLaunchRoom(state.db).companionSetup;
    if (setup && setup.stage !== "complete") throw new Error("请先完成 AI 队友选择");
    if (state.closed) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭，请稍后重试" });
    let room = readLaunchRoom(state.db);
    if (
      room.opening === "complete" ||
      (room.openingMessageId &&
        this.context.activity.running(state)?.messageId === room.openingMessageId)
    )
      return;
    if (this.context.activity.running(state)) throw new Error("主持人正在运行");
    const start = launchStart(state.db);
    if (start.opening.mode === "scripted" && !start.opening.instructions.trim()) {
      this.context.store.transaction(state, () => {
        if (!this.context.liveNarration) {
          this.context.narration.completeOpening(state, roomId);
          return;
        }
        const current = readLaunchRoom(state.db);
        if (current.opening !== "pending") return;
        current.opening = "running";
        current.revision++;
        saveLaunchRoom(state.db, current);
      });
      this.context.narration.kickNarration(state, roomId);
      return;
    }
    const auth = await this.context.credentials(roomId);
    if (state.closed) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭，请稍后重试" });
    room = readLaunchRoom(state.db);
    if (room.opening === "complete" || this.context.activity.running(state)) return;
    const openingTask = room.openingMessageId
      ? `上次开场运行中断。先读取当前游戏文件，核对已完成的初始化与状态变化；只完成尚未完成的部分，不重复写入或重播已完成的内容。\n初始化要求：${start.opening.instructions || "无"}\n${start.opening.mode === "ai" ? `开场要求：${start.opening.prompt}` : "仅完成初始化，之后系统播放预写开场。"}`
      : `执行一次性开局。\n已确认角色：${JSON.stringify(readCharacters(state.db).filter((c) => c.playerId))}\n初始化要求：${start.opening.instructions || "无"}\n${start.opening.mode === "ai" ? `开场要求：${start.opening.prompt}` : "仅执行初始化，不讲述剧情。完成后只简短确认初始化完成，之后系统播放预写开场。"}\n使用 read/write/update 检查并保存角色与世界状态；工具成功后才能声称修改完成。`;
    const prompt = `开局方案：${start.name}\n开局背景：${start.description || "无"}\n${openingTask}`;
    const message = this.context.store.transaction(state, () => {
      const message = this.context.store.save(state, {
        id: randomUUID(),
        sequence: 0,
        revision: 0,
        roomId,
        senderId: "agent",
        nickname: "主持人",
        createdAt: new Date().toISOString(),
        kind: "assistant",
        agentMessages: [],
        status: "running",
        attemptId: randomUUID(),
        ...(start.opening.mode === "scripted" ? { internal: true } : {}),
      });
      room.openingMessageId = message.id;
      room.opening = "running";
      room.revision++;
      saveLaunchRoom(state.db, room);
      return message;
    });
    this.context.runs.start(state, message, prompt, auth, { requestId: `opening:${start.id}` });
  }

  async syncLaunch(roomId: string, player: Player): Promise<void> {
    const state = await this.context.state(roomId);
    if (!readLaunchConfig(state.db)) return;
    this.context.store.transaction(state, () => {
      this.context.cards.materializeLaunch(state, roomId, player);
      this.context.cards.materializeCompanionSetup(state, roomId);
    });
    this.context.narration.kickNarration(state, roomId);
    const room = readLaunchRoom(state.db);
    const progress = readLaunchProgress(state.db, player.id);
    if (
      progress.confirmed &&
      room.opening === "pending" &&
      (!room.companionSetup || room.companionSetup.stage === "complete") &&
      !room.openingMessageId &&
      !this.context.activity.running(state)
    ) {
      try {
        await this.openLaunch(roomId, player);
      } catch {
        const current = readLaunchRoom(state.db);
        if (current.opening !== "pending" || current.openingMessageId) return;
        const noted = state.db.get(
          state.db.query
            .selectFrom("chat_messages")
            .select("id")
            .where(chatField("kind"), "=", "assistant")
            .where(chatField("attemptId"), "is", null)
            .where(chatField("status"), "=", "failed"),
        );
        if (noted) return;
        this.context.store.transaction(state, () =>
          this.context.store.save(state, {
            id: randomUUID(),
            sequence: 0,
            revision: 0,
            roomId,
            senderId: "agent",
            nickname: "主持人",
            createdAt: new Date().toISOString(),
            kind: "assistant",
            agentMessages: [],
            status: "failed",
            error: "开场没有开始，请检查模型配置后继续开场。",
          }),
        );
      }
    }
  }

  async chooseStart(roomId: string, player: Player, messageId: string, startId: string) {
    const state = await this.context.state(roomId);
    this.context.store.transaction(state, () => {
      const message = this.context.store.message(state, messageId);
      if (message.kind !== "card" || message.card.type !== "start" || message.status !== "running")
        throw new ORPCError("CONFLICT", { message: "开局选择已结束" });
      const config = readLaunchConfig(state.db);
      if (!config?.gameStarts.some((start) => start.id === startId))
        throw new ORPCError("BAD_REQUEST", { message: "请选择有效开局方案" });
      const room = readLaunchRoom(state.db);
      if (room.locked) throw new ORPCError("CONFLICT", { message: "开局方案已锁定" });
      room.startId = startId;
      room.revision++;
      saveLaunchRoom(state.db, room);
      for (const [otherId, other] of allLaunchProgress(state.db)) {
        other.revision++;
        delete other.draft;
        delete other.typeId;
        delete other.characterId;
        other.prelude = emptyFlowRun();
        if (other.stage === "start" || other.stage === "prelude") other.stage = "character";
        saveLaunchProgress(state.db, otherId, other);
      }
      const progress = readLaunchProgress(state.db, player.id);
      if (!hasLaunchProgress(state.db, player.id)) {
        progress.stage = "character";
        progress.revision++;
        saveLaunchProgress(state.db, player.id, progress);
      }
      this.context.store.save(state, {
        ...message,
        status: "complete",
        card: { ...message.card, selectedId: startId },
      });
      this.context.cards.insertCharacterCard(state, roomId, player.id);
    });
    return this.context.store.message(state, messageId);
  }

  async confirmReady(roomId: string, player: Player, messageId: string) {
    const state = await this.context.state(roomId);
    this.context.store.transaction(state, () => {
      const message = this.context.store.message(state, messageId);
      if (message.kind !== "card" || message.card.type !== "ready")
        throw new ORPCError("BAD_REQUEST", { message: "这不是准备确认" });
      if (message.status !== "running") return;
      const players = message.card.players.map((item) =>
        item.id === player.id ? { ...item, nickname: player.nickname, confirmed: true } : item,
      );
      if (!players.some((item) => item.id === player.id))
        players.push({ id: player.id, nickname: player.nickname, confirmed: true });
      const ready = players.every((item) => item.confirmed);
      this.context.store.save(state, {
        ...message,
        status: ready ? "complete" : "running",
        card: { type: "ready", players },
      });
      this.context.cards.ensurePlayerRow(state, player.id);
      if (!ready) return;
      const room = readLaunchRoom(state.db);
      if (room.intro !== "ready") return;
      room.intro = "telling";
      room.introIndex ??= 0;
      room.revision++;
      saveLaunchRoom(state.db, room);
    });
    this.context.narration.kickNarration(state, roomId);
    return this.context.store.message(state, messageId);
  }

  async launchState(roomId: string, player: Player) {
    const state = await this.context.state(roomId, true);
    if (isSessionActive(state.db)) await this.syncLaunch(roomId, player);
    return projectLaunch(
      (await this.context.state(roomId, true)).db,
      await launchState(this.context.root, roomId, player.id, { raw: true }),
    );
  }

  async advanceLaunch(input: LaunchAction, player: Player) {
    await advanceLaunch(this.context.root, input, player.id);
    await this.syncLaunch(input.roomId, player);
    return projectLaunch(
      (await this.context.state(input.roomId, true)).db,
      await launchState(this.context.root, input.roomId, player.id, { raw: true }),
    );
  }
}
