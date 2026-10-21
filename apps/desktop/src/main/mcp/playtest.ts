import { join, isAbsolute } from "node:path";

import type { ChatService } from "@jointarp/core/node";
import { readCharacters } from "@jointarp/core/node/sessions/character-db";
import { gameDocumentViews } from "@jointarp/core/node/sessions/game-state";
import {
  readLaunchConfig,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "@jointarp/core/node/sessions/launch-db";
import { patchRoomSettings, readRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import {
  createSession,
  deleteSession,
  openSessionDatabase,
  readRoomState,
  roomDirectory,
} from "@jointarp/core/node/sessions/session-store";
import { structuredFile } from "@jointarp/core/node/storage/structured-file";
import { chatText } from "@jointarp/core/shared/agent-message";
import { aiConfigSchema, type Player } from "@jointarp/core/shared/game";
import type { GameDefaults } from "@jointarp/core/shared/game-defaults";
import { sameDocumentIdentity } from "@jointarp/module/document-path";
import { emptyFlowRun } from "@jointarp/module/flow";
import { z } from "zod";

export const playtestCreateSchema = z.strictObject({
  modulePath: z.string().refine(isAbsolute, "模组路径必须为绝对路径"),
  name: z.string().trim().min(1).max(70).default("临时预演"),
  startId: z.string().min(1),
  model: aiConfigSchema.optional(),
  background: z.string().trim().min(1).max(16000),
  hostBackground: z.string().trim().max(16000).default(""),
  documents: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        values: z.record(z.string(), z.json()),
      }),
    )
    .max(100)
    .default([]),
  companions: z
    .array(z.strictObject({ path: z.string().min(1) }))
    .min(1)
    .max(6),
});
export type PlaytestCreate = z.infer<typeof playtestCreateSchema>;

const snapshotSchema = z.array(
  z.object({
    path: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
    valid: z.boolean(),
    error: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    fieldErrors: z.record(z.string(), z.string()).optional(),
  }),
);
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  roomId: z.string().uuid(),
  fixture: playtestCreateSchema,
  initial: snapshotSchema,
  steps: z.array(
    z.object({
      companionId: z.string(),
      acted: z.boolean(),
      messageId: z.string(),
      after: snapshotSchema,
    }),
  ),
});
type RecordData = z.infer<typeof recordSchema>;
type Run = {
  abort: AbortController;
  done: Promise<void>;
  status: string;
  active: boolean;
  error?: string;
};

/** 仅接受带专用标记的临时 session，绝不把普通冒险作为测试数据修改或删除。 */
export class PlaytestService {
  private runs = new Map<string, Run>();
  private closing = false;
  private creations = new Set<Promise<unknown>>();

  constructor(
    private options: {
      root: string;
      chat: ChatService;
      player: () => Promise<Player>;
      defaults: () => Promise<GameDefaults>;
      showRoom: (roomId: string | null) => void;
    },
  ) {}

  private file(id: string) {
    return structuredFile(join(roomDirectory(this.options.root, id), "playtest.json"), {
      validate: (value) => recordSchema.parse(value),
      fileMode: 0o600,
    });
  }
  private record(id: string): RecordData {
    const record = this.file(id).readSync();
    if (record.roomId !== id) throw new Error("不是有效的临时预演 session");
    return record;
  }
  private async snapshot(id: string) {
    const db = await openSessionDatabase(this.options.root, id);
    try {
      const documents = await gameDocumentViews(
        db,
        join(roomDirectory(this.options.root, id), "game"),
        true,
      );
      return documents.map(({ path, values, valid, error, title, body, fieldErrors }) => ({
        path,
        values,
        valid,
        error,
        title,
        body,
        fieldErrors,
      }));
    } finally {
      db.close();
    }
  }

  create(input: PlaytestCreate) {
    if (this.closing) throw new Error("预演服务正在关闭");
    const task = this.createSession(playtestCreateSchema.parse(input));
    this.creations.add(task);
    void task.finally(() => this.creations.delete(task)).catch(() => {});
    return task;
  }
  private async createSession(fixture: PlaytestCreate) {
    const { root, chat } = this.options;
    const player = await this.options.player();
    const defaults = await this.options.defaults();
    if (fixture.model)
      defaults.ai = {
        ...fixture.model,
        name: fixture.model.model,
        providerName: fixture.model.provider,
      };
    const room = await createSession(
      root,
      fixture.modulePath,
      `[预演] ${fixture.name}`,
      defaults,
      fixture.documents,
    );
    try {
      const db = await openSessionDatabase(root, room.id);
      try {
        const config = readLaunchConfig(db);
        if (!config?.gameStarts.some((start) => start.id === fixture.startId))
          throw new Error("预演开局不存在");
        saveLaunchRoom(db, {
          ...readLaunchRoom(db),
          startId: fixture.startId,
          locked: true,
          intro: "told",
          opening: "pending",
        });
        saveLaunchProgress(db, player.id, {
          revision: 1,
          stage: "opening",
          prelude: { ...emptyFlowRun(), done: true },
          confirmed: true,
        });
        saveLaunchRoom(db, { ...readLaunchRoom(db), opening: "complete" });
      } finally {
        db.close();
      }
      const directory = roomDirectory(root, room.id);
      const settings = readRoomSettings(directory);
      patchRoomSettings(directory, {
        chat: { submissionMode: "manual" },
        hostSystemPrompt: `${settings.hostSystemPrompt}\n\n预演前置背景（不重新执行开局）：\n${fixture.background}\n${fixture.hostBackground}`,
      });
      for (const selected of fixture.companions) {
        const db = await openSessionDatabase(root, room.id);
        let characterId: string;
        try {
          const character = readCharacters(db).find(
            (item) => item.sourcePath && sameDocumentIdentity(item.sourcePath, selected.path),
          );
          if (!character) throw new Error(`预演角色不存在：${selected.path}`);
          characterId = character.id;
        } finally {
          db.close();
        }
        const choice = await chat.selectCompanion(room.id, characterId);
        const seat = choice.seats.find((item) => item.reservedCharacterId === characterId)!;
        await chat.saveCompanion(room.id, seat.id, { characterId }, player);
        await chat.setCompanionInitiative(room.id, seat.id, { level: "eager", prompt: "" });
        await chat.setCompanionDocumentAccess(room.id, seat.id, true);
      }
      await chat.seedPlaytestBackground(room.id, fixture.background);
      const initial = await this.snapshot(room.id);
      if (initial.some((item) => !item.valid || Object.keys(item.fieldErrors ?? {}).length))
        throw new Error("预演状态计算失败");
      this.file(room.id).writeSync({
        schemaVersion: 1,
        roomId: room.id,
        fixture,
        initial,
        steps: [],
      });
      this.options.showRoom(room.id);
      return {
        roomId: room.id,
        status: "ready",
        companions: (await chat.companionSettings(room.id)).seats
          .map((item) => item.companion?.id)
          .filter(Boolean),
      };
    } catch (error) {
      await chat.closeRoom(room.id);
      await deleteSession(root, room.id);
      throw error;
    }
  }

  async run(id: string, maxTurns: number, timeoutSeconds: number) {
    if (this.closing) throw new Error("预演服务正在关闭");
    this.record(id);
    if (this.runs.get(id)?.active) throw new Error("预演正在运行");
    const seats = (await this.options.chat.companionSettings(id)).seats.flatMap((seat) =>
      seat.companion ? [seat.companion.id] : [],
    );
    if (!seats.length) throw new Error("预演没有可用队友");
    // 读取席位后重新检查，两个并发请求不能启动两条循环。
    if (this.closing) throw new Error("预演服务正在关闭");
    if (this.runs.get(id)?.active) throw new Error("预演正在运行");
    const offset = this.record(id).steps.length;
    const run: Run = {
      abort: new AbortController(),
      done: Promise.resolve(),
      status: "running",
      active: true,
    };
    this.runs.set(id, run);
    const timer = setTimeout(() => {
      run.status = "timeout";
      run.abort.abort();
    }, timeoutSeconds * 1000);
    run.done = (async () => {
      let silent = 0;
      for (let i = 0; i < maxTurns && !run.abort.signal.aborted; i++) {
        const { room } = (await readRoomState(this.options.root, id)).state;
        if (room.status !== "active") {
          run.status = "ended";
          break;
        }
        const companionId = seats[(offset + i) % seats.length];
        const result = await this.options.chat.playtestTurn(id, companionId, run.abort.signal);
        const after = await this.snapshot(id);
        this.file(id).updateSync((record) => ({
          ...record,
          steps: [...record.steps, { companionId, ...result, after }],
        }));
        silent = result.acted ? 0 : silent + 1;
        if (after.some((item) => !item.valid || Object.keys(item.fieldErrors ?? {}).length))
          throw new Error("游戏状态计算失败");
        if ((await readRoomState(this.options.root, id)).state.room.status !== "active") {
          run.status = "ended";
          break;
        }
        if (silent >= seats.length) {
          run.status = "waiting";
          break;
        }
      }
      if (run.status === "running") run.status = run.abort.signal.aborted ? "paused" : "limit";
    })()
      .catch((error: unknown) => {
        if (run.abort.signal.aborted) {
          if (run.status === "running") run.status = "paused";
        } else {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : "预演失败";
        }
      })
      .finally(() => {
        run.active = false;
        clearTimeout(timer);
      });
    return { roomId: id, status: "running", maxTurns };
  }

  async inspect(id: string, paths?: string[], beforeSequence?: number) {
    const record = this.record(id);
    const documents = await this.snapshot(id);
    const selectedPaths = paths ?? [
      ...record.fixture.documents.map((item) => item.path),
      ...record.fixture.companions.map((item) => item.path),
    ];
    const selected = (path: string) =>
      selectedPaths.some((item) => sameDocumentIdentity(item, path));
    const history = await this.options.chat.history({ roomId: id, limit: 100, beforeSequence });
    const projection = await this.options.chat.roomProjection(id, await this.options.player());
    const run = this.runs.get(id);
    return {
      roomId: id,
      status: run?.status ?? "idle",
      error: run?.error,
      roomStatus: projection.sections.room.status,
      activity: projection.sections.chatActivity,
      steps: record.steps.map(({ after, ...step }) => ({
        ...step,
        after: after.filter((item) => selected(item.path)),
      })),
      initial: record.initial.filter((item) => selected(item.path)),
      documents: documents.filter((item) => selected(item.path)),
      messages: history.messages.map((message) => ({
        id: message.id,
        sequence: message.sequence,
        nickname: message.nickname,
        kind: message.kind,
        status: message.status,
        text: chatText(message),
        error: message.error,
        ...(message.kind === "dice" ? { dice: message.dice } : {}),
        ...(message.kind === "assistant"
          ? { companionId: message.companionId, pendingAction: message.pendingAction }
          : {}),
      })),
      hasMore: history.hasMore,
      nextBeforeSequence: history.messages[0]?.sequence,
    };
  }

  async pause(id: string) {
    this.record(id);
    const run = this.runs.get(id);
    if (run) {
      run.abort.abort();
      await run.done;
    }
    return { roomId: id, status: run?.status ?? "idle" };
  }
  async dispose(id: string) {
    this.record(id);
    await this.pause(id);
    await this.options.chat.closeRoom(id);
    await deleteSession(this.options.root, id);
    this.runs.delete(id);
    this.options.showRoom(null);
    return { roomId: id, status: "disposed" };
  }
  async close() {
    this.closing = true;
    for (const run of this.runs.values()) run.abort.abort();
    await Promise.allSettled([
      ...this.creations,
      ...[...this.runs.values()].map((run) => run.done),
    ]);
  }
}
