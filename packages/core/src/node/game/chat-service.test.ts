import { describe, it, onTestFinished, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/message-port";
import { launchConfigSchema, type LaunchConfig } from "@tarp/module/flow";
import {
  advanceTimersByTime,
  advanceTimersByTimeAsync,
  useFakeTimers,
  useRealTimers,
  waitFor,
} from "@tarp/module/testing/async";
import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { chatText } from "../../shared/agent-message";
import type {
  ChatEvent,
  ChatMessage,
  PublicAgentEvent,
  RoomNotification,
  gameContract,
} from "../../shared/game";
import { narrationGapMs } from "../../shared/narration";
import { parseNarrative } from "../../shared/narrative";
import { ROOM_PROTOCOL_VERSION } from "../../shared/room-state";
import { createGameTools } from "../agent/game-tools";
import { inputBatchCustomType } from "../agent/input-batch";
import { PiHistory } from "../agent/pi-history";
import { createIdentityId } from "../identity";
import { updateGameDocument } from "../sessions/game-state";
import { roomDisplaySettings } from "../sessions/room-display-settings";
import { patchRoomSettings, readRoomSettings } from "../sessions/room-settings";
import { readAdventure } from "../sessions/room-storage";
import {
  createSession,
  openSessionDatabase,
  gameDirectoryForDatabase,
  loadSession,
  loadSessionModuleResources,
} from "../sessions/session-store";
import { withStateLock } from "../sessions/state-lock";
import { SessionDatabase } from "../storage/session-database";
import { ChatService, type Runtime } from "./chat-service";
import { ChatEvents, chatEvents as memoryChatEvents } from "./chat/events";
import { ChatRuns } from "./chat/runs";
import { ChatStore } from "./chat/store";
import { gameRouter } from "./game-router";
import { RoomMetrics } from "./room-metrics";

function emitText(onAgentEvent: (event: PublicAgentEvent) => void, text: string) {
  onAgentEvent({
    type: "message_start",
    messageIndex: 0,
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    },
  });
  onAgentEvent({ type: "text_start", messageIndex: 0, contentIndex: 0 });
  onAgentEvent({ type: "text_delta", messageIndex: 0, contentIndex: 0, delta: text });
}
async function persistPiFixture(
  sessions: string,
  roomId: string,
  messageId: string,
  thinking: string,
  result?: string,
) {
  const room = join(sessions, roomId);
  const agent = join(room, "agent");
  await mkdir(agent, { recursive: true });
  const path = join(agent, "session.jsonl");
  await writeFile(path, "", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const manager = SessionManager.open(path, agent, room);
  const beforeEntryId = manager.getLeafId();
  let afterEntryId = manager.appendMessage({
    role: "assistant",
    provider: "test",
    model: "test",
    api: "test",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      { type: "thinking", thinking },
      { type: "toolCall", id: "read", name: "read", arguments: { path: "/" } },
    ],
  });
  if (result)
    afterEntryId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: result }],
      isError: false,
      timestamp: Date.now(),
    });
  const db = new SessionDatabase(join(room, "session.sqlite"));
  try {
    const message = JSON.parse(
      String(
        db.sqlite
          .prepare<unknown[], Record<string, unknown>>("SELECT data FROM chat_messages WHERE id=?")
          .get(messageId)!.data,
      ),
    );
    assert.equal(message.kind, "assistant");
    const next = {
      ...message,
      pi: { sessionId: manager.getSessionId(), beforeEntryId, afterEntryId },
      modelInfo: { provider: "test", model: "test", contextWindow: 4096 },
    } as Extract<ChatMessage, { kind: "assistant" }>;
    db.sqlite
      .prepare<unknown[], Record<string, unknown>>("UPDATE chat_messages SET data=? WHERE id=?")
      .run(JSON.stringify(next), messageId);
    return next;
  } finally {
    db.close();
  }
}
const player = { id: createIdentityId(), nickname: "Luna" };
const credentials = async () => ({
  config: { provider: "test", model: "test" },
});
/** 通过正式房间流接收聊天；确认状态和聊天帧，避免测试绕过流控。 */
async function* chatEvents(
  stream: AsyncIterable<RoomNotification>,
  acknowledge: (delivery: { id: string; seq: number }) => void | Promise<void>,
): AsyncGenerator<ChatEvent> {
  for await (const notification of stream) {
    await acknowledge(notification.delivery);
    if (notification.type === "chat") yield notification.event;
  }
}
async function* roomChatEvents(
  sessions: string,
  service: ChatService,
  input: { roomId: string; afterCursor: number },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const { baseline } = await loadSessionModuleResources(sessions, input.roomId);
  const stream = service.subscribeRoom(
    {
      roomId: input.roomId,
      protocolVersion: ROOM_PROTOCOL_VERSION,
      baselineVersion: baseline.version,
      afterChatCursor: input.afterCursor,
      afterChatStreamId: (await service.history({ roomId: input.roomId, limit: 1 })).streamId,
    },
    player,
    signal,
  );
  yield* chatEvents(stream, (delivery) =>
    service.acknowledgeRoom(
      { roomId: input.roomId, subscriptionId: delivery.id, sequence: delivery.seq },
      player,
    ),
  );
}
async function fixture(
  runtime: Runtime = { run: async () => {} },
  options?: { narrationGap?: (text: string) => number; launch?: LaunchConfig; outcome?: boolean },
) {
  const root = await mkdtemp(join(tmpdir(), "tarp-chat-"));
  const module = join(root, "module");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(join(module, ".types", "规则.fields.json"), "{}");
  await writeFile(join(module, "规则/开始.md"), "冒险从这里开始");
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "测试", description: "聊天流程测试" }),
  );
  if (options?.launch) {
    await mkdir(join(module, "地点"));
    await writeFile(join(module, ".types", "地点.fields.json"), JSON.stringify({ fields: {} }));
    await writeFile(
      join(module, ".types", "角色.fields.json"),
      JSON.stringify({ designation: "character", fields: {} }),
    );
    await writeFile(join(module, "地点/墓门.json"), JSON.stringify({ name: "墓门" }));
    await writeFile(join(module, "地点/营地.json"), JSON.stringify({ name: "营地" }));
    await writeFile(join(module, "角色/向导.json"), JSON.stringify({ name: "向导" }));
    await writeFile(
      join(module, "module.json"),
      JSON.stringify({ name: "测试", description: "聊天流程测试", ...options.launch }),
    );
  }
  const sessions = join(root, "sessions");
  if (options?.outcome) {
    // 允许声明多个世界类型；结局应读取实际使用的那份文档。
    await writeFile(
      join(module, ".types", "AAA.fields.json"),
      JSON.stringify({ designation: "world_state", fields: {} }),
    );
    await writeFile(
      join(module, ".types", "角色.fields.json"),
      JSON.stringify({ designation: "character", fields: {} }),
    );
    await writeFile(
      join(module, ".types", "世界.fields.json"),
      JSON.stringify({
        designation: "world_state",
        fields: {
          ending: {
            type: "enum",
            options: ["playing", "won", "lost"],
            required: true,
            mutable: true,
          },
          scenes: {
            type: "list",
            required: true,
            mutable: true,
            item: {
              type: "object",
              fields: {
                id: { type: "text" },
                location: { type: "reference", targets: ["规则"] },
                members: { type: "list", item: { type: "reference", targets: ["角色"] } },
                activity: { type: "enum", options: ["explore"] },
              },
            },
          },
        },
      }),
    );
    await writeFile(
      join(module, "世界/状态.json"),
      JSON.stringify({ ending: "playing", scenes: [] }),
    );
  }
  const room = await createSession(sessions, module, "测试房间");
  const service = new ChatService(
    sessions,
    {
      ...runtime,
      run: async (args) => {
        if (args.inputBatch)
          args.onInputReceived?.({
            batchId: args.inputBatch.id,
            messageId: args.messageId,
            reference: { sessionId: randomUUID(), beforeEntryId: null, afterEntryId: "mock-input" },
          });
        return runtime.run(args);
      },
    },
    credentials,
    options,
  );
  return {
    root,
    module,
    sessions,
    room,
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const doorLaunch = launchConfigSchema.parse({
  preludeFlow: {
    steps: [
      {
        id: "door",
        type: "introduction",
        title: "石门",
        body: "门楣上挂着一只小铃。\n\n石门只裂开一条缝。",
      },
    ],
  },
  gameStarts: [
    {
      id: "door",
      name: "就从墓门进去",
      description: "石门就在眼前。",
      characterTypeIds: ["角色"],
      playablePaths: ["角色/向导.json"],
      allowCreate: false,
      opening: { mode: "scripted", beats: [{ text: "门。" }] },
    },
  ],
});

const multipleLaunch = launchConfigSchema.parse({
  gameStarts: [
    {
      id: "door",
      name: "墓门",
      description: "石门就在眼前。",
      characterTypeIds: ["角色"],
      playablePaths: ["角色/向导.json"],
      allowCreate: false,
      opening: { mode: "scripted", beats: [{ text: "门。" }] },
    },
    {
      id: "camp",
      name: "营地",
      description: "火还没灭。",
      characterTypeIds: ["角色"],
      playablePaths: ["角色/向导.json"],
      allowCreate: false,
      opening: { mode: "scripted", beats: [{ text: "营地。" }] },
    },
  ],
});

describe("模型请求重试", () => {
  async function piFixture() {
    const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { createPiRuntime } = await import("../agent/pi-runtime");
    const f = await fixture();
    let service: ChatService | undefined;
    onTestFinished(async () => {
      await service?.close();
      await f.close();
    });
    await f.service.close();
    const provider = fauxProvider({
      provider: `retry-${randomUUID()}`,
      api: `retry-${randomUUID()}`,
      models: [{ id: "host", contextWindow: 100_000, maxTokens: 4096 }],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(f.root, "models-cache.json"),
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    service = new ChatService(
      f.sessions,
      createPiRuntime({ modelRuntime: async () => modelRuntime }),
      async () => ({ config: { provider: provider.provider.id, model: "host" } }),
    );
    const chat = service;
    const history = () => chat.history({ roomId: f.room.id, limit: 100 });
    const send = () =>
      chat.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "观察入口", chatOnly: false },
        player,
      );
    return { ...f, service, provider, history, send };
  }

  it("真实 Pi 通过订阅工具选字段，下一轮自动带上最新值，关闭后不再提供工具或新快照", async () => {
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const f = await piFixture();
    const room = join(f.sessions, f.room.id);
    patchRoomSettings(room, { contextSubscriptionsEnabled: true });
    f.provider.setResponses([
      () =>
        fauxAssistantMessage(
          fauxToolCall("context_subscribe", {
            action: "set",
            document: "规则/开始.md",
            fields: ["/body"],
          }),
          { stopReason: "toolUse" },
        ),
      (context) => {
        assert.match(JSON.stringify(context.messages.at(-1)), /冒险从这里开始/);
        return fauxAssistantMessage("已经记下需要关注的内容。");
      },
    ]);
    await f.send();
    await waitFor(
      async () => assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
      { timeout: 5000 },
    );
    assert.equal(f.provider.state.callCount, 2);
    f.provider.setResponses([
      (context) => {
        const last = context.messages.at(-1)!;
        assert.equal(last.role, "user");
        assert.match(JSON.stringify(last), /本轮订阅字段/);
        assert.match(JSON.stringify(last), /冒险从这里开始/);
        return fauxAssistantMessage("继续冒险。");
      },
    ]);
    await f.send();
    await waitFor(
      async () => assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
      { timeout: 5000 },
    );
    patchRoomSettings(room, { contextSubscriptionsEnabled: false });
    f.provider.setResponses([
      (context) => {
        assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /本轮订阅字段/);
        const names = new Set<string>();
        for (const message of context.messages) {
          if (message.role !== "system") continue;
          for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
          for (const tool of message.toolsAdded ?? []) names.add(tool.name);
        }
        assert.equal(names.has("context_subscribe"), false);
        return fauxAssistantMessage("按需查阅。");
      },
    ]);
    await f.send();
    await waitFor(
      async () => assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
      { timeout: 5000 },
    );
  });

  it("工具完成后的网络失败在原消息中恢复，不重复掷骰或重送玩家输入", async () => {
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const f = await piFixture();
    f.provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("roll_dice", { expression: "1d6", reason: "观察入口" }, { id: "observe" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
      (context) => {
        assert.equal(context.messages.filter((message) => message.role === "user").length, 1);
        assert.equal(
          context.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "roll_dice",
          ).length,
          1,
        );
        return fauxAssistantMessage("你发现入口的脚印。");
      },
    ]);
    useFakeTimers();
    try {
      await f.send();
      await waitFor(async () => {
        const assistant = (await f.history()).messages.find(
          (message) => message.kind === "assistant",
        );
        assert(assistant?.kind === "assistant");
        assert.equal(assistant.agentMessages.at(-1)?.stopReason, "error");
        assert.equal(assistant.status, "running");
      });
      await advanceTimersByTimeAsync(2000);
      await waitFor(async () => {
        assert.equal(
          (await f.history()).messages.find((message) => message.kind === "assistant")?.status,
          "complete",
        );
      });
      const messages = (await f.history()).messages;
      assert.equal(f.provider.state.callCount, 3);
      assert.equal(messages.filter((message) => message.kind === "player").length, 1);
      assert.equal(messages.filter((message) => message.kind === "dice").length, 1);
      const assistants = messages.filter((message) => message.kind === "assistant");
      assert.equal(assistants.length, 1);
      assert.equal(assistants[0]!.error, undefined);
      assert.equal(chatText(assistants[0]!).trim(), "你发现入口的脚印。");
    } finally {
      useRealTimers();
    }
  });

  for (const { error, calls } of [
    { error: "fetch failed", calls: 4 },
    { error: "401 unauthorized secret-key", calls: 1 },
    { error: "429 insufficient_quota secret-key", calls: 1 },
  ]) {
    it(`${error} 最终失败时保留原消息，模型调用次数为 ${calls}`, async () => {
      const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
      const f = await piFixture();
      f.provider.setResponses(
        Array.from({ length: calls }, () =>
          fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
        ),
      );
      useFakeTimers();
      try {
        await f.send();
        for (let attempt = 1; attempt <= calls; attempt++) {
          await waitFor(async () => {
            const assistant = (await f.history()).messages.find(
              (message) => message.kind === "assistant",
            );
            assert(assistant?.kind === "assistant");
            assert.equal(assistant.agentMessages.length, attempt);
            assert.equal(assistant.agentMessages.at(-1)?.stopReason, "error");
          });
          if (attempt < calls) await advanceTimersByTimeAsync(2000 * 2 ** (attempt - 1));
        }
        await waitFor(async () => {
          assert.equal(
            (await f.history()).messages.find((message) => message.kind === "assistant")?.status,
            "failed",
          );
        });
        const messages = (await f.history()).messages;
        assert.equal(f.provider.state.callCount, calls);
        assert.equal(messages.length, 2);
        assert.equal(messages[1]!.status, "failed");
        assert(!messages[1]!.error?.includes(error));
      } finally {
        useRealTimers();
      }
    });
  }

  it("停止生成立即取消重试等待，不再发起模型请求", async () => {
    const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
    const f = await piFixture();
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage("不应继续生成。"),
    ]);
    useFakeTimers();
    try {
      await f.send();
      let messageId = "";
      await waitFor(async () => {
        const assistant = (await f.history()).messages.find(
          (message) => message.kind === "assistant",
        );
        assert(assistant?.kind === "assistant");
        assert.equal(assistant.agentMessages.at(-1)?.stopReason, "error");
        assert.equal(assistant.status, "running");
        messageId = assistant.id;
      });
      await f.service.cancel(f.room.id, messageId);
      await advanceTimersByTimeAsync(14_000);
      const messages = (await f.history()).messages;
      assert.equal(f.provider.state.callCount, 1);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]!.status, "cancelled");
      assert.equal(messages[1]!.error, undefined);
    } finally {
      useRealTimers();
    }
  });
});

describe("房间聊天业务", () => {
  it("关闭钩子失败仍释放数据库，房间可以重新打开", async () => {
    const closeError = new Error("关闭钩子失败");
    let fail = true;
    const f = await fixture({
      run: async () => {},
      closeRoom: async () => {
        if (fail) throw closeError;
      },
    });
    onTestFinished(() => f.close());
    await f.service.history({ roomId: f.room.id, limit: 1 });
    const close = spyOn(SessionDatabase.prototype, "close");
    try {
      await assert.rejects(
        f.service.closeRoom(f.room.id),
        (error: unknown) => error instanceof AggregateError && error.errors.includes(closeError),
      );
      assert.ok(close.mock.contexts.some((db) => db instanceof SessionDatabase && !db.sqlite.open));
      fail = false;
      assert.deepEqual((await f.service.history({ roomId: f.room.id, limit: 1 })).messages, []);
    } finally {
      fail = false;
      close.mockRestore();
    }
  });

  it("并发关闭共同等待资源释放，关闭期间不能重新访问房间", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture({
      run: async () => {},
      closeRoom: async () => {
        entered();
        await waiting;
      },
    });
    onTestFinished(async () => {
      release();
      await f.close();
    });
    await f.service.history({ roomId: f.room.id, limit: 1 });
    const first = f.service.closeRoom(f.room.id);
    await started;
    let finished = false;
    const second = f.service.closeRoom(f.room.id).then(() => {
      finished = true;
    });
    await assert.rejects(f.service.history({ roomId: f.room.id, limit: 1 }), /冒险正在关闭/);
    assert.equal(finished, false);
    release();
    await Promise.all([first, second]);
    assert.equal(finished, true);
    assert.deepEqual((await f.service.history({ roomId: f.room.id, limit: 1 })).messages, []);
  });

  it("异常退出恢复原生 Pi 边界，后续消息不串入先前回复的工具详情", async () => {
    const f = await fixture();
    let reopened: ChatService | undefined;
    try {
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "行动", chatOnly: false },
        player,
      );
      const assistant = await waitFor(async () => {
        const page = await f.service.history({ roomId: f.room.id, limit: 20 });
        const message = page.messages.find(
          (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
            message.kind === "assistant" && message.status === "complete",
        );
        assert.ok(message);
        return message;
      });
      const saved = await persistPiFixture(
        f.sessions,
        f.room.id,
        assistant.id,
        "第一次幕后推理",
        "第一次工具结果",
      );
      // 模拟 Pi 最后写入成功，SQLite 仍停留在调用开始时的边界。
      const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      db.sqlite
        .prepare<unknown[], Record<string, unknown>>("UPDATE chat_messages SET data=? WHERE id=?")
        .run(
          JSON.stringify({
            ...saved,
            status: "running",
            pi: { ...saved.pi!, afterEntryId: saved.pi!.beforeEntryId },
          }),
          saved.id,
        );
      db.close();
      await f.service.close();
      reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
      const restored = await reopened.get({ roomId: f.room.id, messageId: saved.id });
      assert.equal(restored.status, "interrupted");
      assert.equal(
        restored.kind === "assistant" && restored.pi?.afterEntryId,
        saved.pi?.afterEntryId,
      );
      assert.equal((await reopened.details(f.room.id, saved.id))[1].result, "第一次工具结果");
      const manager = SessionManager.open(
        join(f.sessions, f.room.id, "agent", "session.jsonl"),
        undefined,
        f.room.id,
      );
      manager.appendMessage({ role: "user", content: "后续行动", timestamp: Date.now() });
      assert.equal((await reopened.details(f.room.id, saved.id))[0].text, "第一次幕后推理");
      assert.equal((await reopened.metrics(f.room.id)).host.totals.toolCalls, 1);
    } finally {
      await reopened?.close();
      await f.close();
    }
  });
  it("幕后详情运行时留内存、历史从 Pi 会话读取，显示偏好按冒险保存", async () => {
    let attempt = 0;
    const f = await fixture({
      run: async (args) => {
        attempt++;
        args.onDetail?.({
          id: "thinking:0:0",
          kind: "thinking",
          text: `隐藏剧情-${attempt}`,
          status: "complete",
        });
        args.onDetail?.({ id: "tool:read", kind: "tool", text: "read", status: "complete" });
        emitText(args.onAgentEvent, "公开叙事");
        if (attempt === 1) throw new Error("模拟失败");
      },
    });
    let reopened: ChatService | undefined;
    try {
      assert.deepEqual(await roomDisplaySettings(f.sessions, f.room.id), {
        showReasoning: false,
        showAllDocuments: false,
      });
      await roomDisplaySettings(f.sessions, f.room.id, { showReasoning: true });
      assert.equal((await roomDisplaySettings(f.sessions, f.room.id)).showReasoning, true);
      await roomDisplaySettings(f.sessions, f.room.id, { showAllDocuments: true });
      assert.deepEqual(await roomDisplaySettings(f.sessions, f.room.id), {
        showReasoning: true,
        showAllDocuments: true,
      });
      const other = await createSession(f.sessions, f.module, "另一个冒险");
      assert.equal((await roomDisplaySettings(f.sessions, other.id)).showReasoning, false);
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
        player,
      );
      const finished = () =>
        waitFor(async () => {
          const history = await f.service.history({ roomId: f.room.id, limit: 50 });
          const assistant = history.messages.filter((item) => item.kind === "assistant").at(-1);
          assert.ok(assistant);
          assert.notEqual(assistant.status, "running");
          return assistant;
        });
      const first = await finished();
      assert.equal((await f.service.details(f.room.id, first.id))[0].text, "隐藏剧情-1");
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "继续", chatOnly: false },
        player,
      );
      const second = await finished();
      assert.equal(second.status, "complete");
      assert.notEqual(second.id, first.id);
      assert.notEqual(second.attemptId, first.attemptId);
      assert.deepEqual(
        (await f.service.details(f.room.id, second.id)).map((detail) => detail.text),
        ["隐藏剧情-2", "read"],
      );
      assert.ok(
        !JSON.stringify(await f.service.history({ roomId: f.room.id, limit: 50 })).includes(
          "隐藏剧情",
        ),
      );
      const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      try {
        assert.ok(
          !JSON.stringify(
            db.sqlite
              .prepare<unknown[], Record<string, unknown>>("SELECT data FROM chat_messages")
              .all(),
          ).includes("隐藏剧情"),
        );
      } finally {
        db.close();
      }
      await persistPiFixture(f.sessions, f.room.id, second.id, "隐藏剧情-2", "已读取");
      await f.service.close();
      reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
      const details = await reopened.details(f.room.id, second.id);
      assert.equal(details[0].text, "隐藏剧情-2");
      assert.equal(details[1].arguments, '{\n  "path": "/"\n}');
      assert.equal(details[1].result, "已读取");
      const metrics = await reopened.metrics(f.room.id);
      assert.equal(metrics.host.totals.toolCalls, 1);
      assert.equal(metrics.host.current.contextWindow, 4096);
      await roomDisplaySettings(f.sessions, f.room.id, { showReasoning: false });
      assert.equal((await roomDisplaySettings(f.sessions, f.room.id)).showReasoning, false);
    } finally {
      await reopened?.close();
      await f.close();
    }
  });
  it("提交失败不会留下请求或消息，重启将运行中回复标记为中断", async () => {
    const f = await fixture();
    let db: SessionDatabase | undefined;
    try {
      await f.service.history({ roomId: f.room.id, limit: 50 });
      db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      db.sqlite.exec(
        "CREATE TRIGGER fail_event BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(FAIL, 'disk failure'); END;",
      );
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "不能丢失",
        chatOnly: true,
      };
      await assert.rejects(f.service.send(input, player));
      assert.equal((await f.service.history({ roomId: f.room.id, limit: 50 })).messages.length, 0);
      db.sqlite.exec("DROP TRIGGER fail_event");
      const saved = await f.service.send(input, player);
      db.sqlite
        .prepare<unknown[], Record<string, unknown>>("UPDATE chat_messages SET data=? WHERE id=?")
        .run(
          JSON.stringify({ ...saved, kind: "assistant", agentMessages: [], status: "running" }),
          saved.id,
        );
      await f.service.close();
      const reopened = new ChatService(
        f.sessions,
        {
          run: async () => {
            throw new Error("不应自动调用模型");
          },
        },
        credentials,
      );
      try {
        const history = await reopened.history({ roomId: f.room.id, limit: 50 });
        assert.equal(history.messages[0].status, "interrupted");
        assert.ok(history.cursor > 0);
      } finally {
        await reopened.close();
      }
    } finally {
      db?.close();
      await f.close();
    }
  });
  it("重复发送幂等、内容冲突拒绝、分页和重启保持顺序", async () => {
    let calls = 0;
    const f = await fixture({
      run: async () => {
        calls++;
      },
    });
    try {
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "你好",
        chatOnly: true,
      };
      const [a, b] = await Promise.all([
        f.service.send(input, player),
        f.service.send(input, player),
      ]);
      assert.equal(a.id, b.id);
      await assert.rejects(f.service.send({ ...input, text: "不同" }, player), /不同/);
      await assert.rejects(f.service.send({ ...input, chatOnly: false }, player), /不同/);
      assert.equal(a.kind === "player" && a.chatOnly, true);
      await f.service.send({ ...input, clientMessageId: randomUUID(), text: "第二条" }, player);
      const page = await f.service.history({ roomId: f.room.id, limit: 1 });
      assert.equal(chatText(page.messages[0]), "第二条");
      assert.equal(page.hasMore, true);
      const older = await f.service.history({
        roomId: f.room.id,
        limit: 1,
        beforeSequence: page.messages[0].sequence,
      });
      assert.equal(older.messages[0].id, a.id);
      assert.equal(calls, 0);
      await f.service.close();
      const reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
      try {
        assert.equal((await reopened.history({ roomId: f.room.id, limit: 50 })).messages.length, 2);
        const resent = await reopened.send(input, player);
        assert.equal(resent.id, a.id);
        assert.equal((await reopened.send(input, player)).id, resent.id);
        assert.equal((await reopened.history({ roomId: f.room.id, limit: 50 })).messages.length, 2);
        await assert.rejects(reopened.send({ ...input, text: "重启后冲突" }, player), /不同/);
        await reopened.closeRoom(f.room.id);
        assert.equal((await reopened.send(input, player)).id, a.id);
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  });
  it("本人待提交行动可改为聊天，失败回滚、重复操作与已开始提交的保护均不影响其他人", async () => {
    const calls: string[] = [];
    const f = await fixture({
      run: async (args) => {
        calls.push(args.text);
        emitText(args.onAgentEvent, "主持回应");
      },
    });
    try {
      await f.service.setSubmissionMode(f.room.id, "manual");
      const own = await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "我尝试开门", chatOnly: false },
        player,
      );
      const other = { id: createIdentityId(), nickname: "同伴" };
      const peer = await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "同伴守门", chatOnly: false },
        other,
      );
      const input = { roomId: f.room.id, messageId: own.id };
      await assert.rejects(f.service.convertToChat(input, other), /只能将自己的/);
      const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      try {
        db.sqlite.exec(
          `CREATE TRIGGER fail_to_chat BEFORE UPDATE ON chat_messages WHEN new.id='${own.id}' AND json_extract(new.data,'$.chatOnly')=1 BEGIN SELECT RAISE(FAIL, 'convert failure'); END;`,
        );
        await assert.rejects(f.service.convertToChat(input, player), /convert failure/);
        await assert.rejects(
          f.service.send(
            { roomId: f.room.id, clientMessageId: randomUUID(), text: "改为观察", chatOnly: false },
            player,
          ),
          /convert failure/,
        );
        assert.deepEqual(
          (await f.service.history({ roomId: f.room.id, limit: 10 })).pendingMessageIds,
          [own.id, peer.id],
        );
        const unchanged = await f.service.get(input);
        assert(unchanged.kind === "player" && !unchanged.chatOnly && unchanged.pendingAgent);
        db.sqlite.exec("DROP TRIGGER fail_to_chat");
      } finally {
        db.close();
      }
      const chat = await f.service.convertToChat(input, player);
      assert(chat.kind === "player" && chat.chatOnly && !chat.pendingAgent);
      assert.equal(chat.text, "我尝试开门");
      assert.equal((await f.service.convertToChat(input, player)).revision, chat.revision);
      const next = await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "我观察门锁", chatOnly: false },
        player,
      );
      await f.service.convertToChat(input, player);
      assert.deepEqual(
        (await f.service.history({ roomId: f.room.id, limit: 10 })).pendingMessageIds,
        [peer.id, next.id],
      );
      await f.service.continue({ roomId: f.room.id, clientRequestId: randomUUID() }, player);
      await assert.rejects(
        f.service.convertToChat({ ...input, messageId: next.id }, player),
        /已开始提交/,
      );
      await waitFor(() => assert.equal(calls.length, 1));
      assert.ok(!calls[0].includes("我尝试开门"));
      assert.ok(calls[0].includes("我观察门锁") && calls[0].includes("同伴守门"));
    } finally {
      await f.close();
    }
  });

  it("手动提交每人只保留最新行动，跨重启保留队列并支持提交重试", async () => {
    const calls: string[] = [];
    const runtime: Runtime = {
      run: async (args) => {
        calls.push(args.text);
        emitText(args.onAgentEvent, "主持人回应");
      },
    };
    const f = await fixture(runtime);
    let reopened: ChatService | undefined;
    try {
      assert.deepEqual((await f.service.history({ roomId: f.room.id, limit: 50 })).submissionMode, {
        mode: "auto",
        revision: 0,
      });
      await f.service.setSubmissionMode(f.room.id, "manual");
      assert.equal(readRoomSettings(join(f.sessions, f.room.id)).chat.submissionMode, "manual");
      const firstInput = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "先观察门锁",
        chatOnly: false,
      };
      const first = await f.service.send(firstInput, player);
      const second = await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "再试着推门", chatOnly: false },
        player,
      );
      const peer = await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "守住门口", chatOnly: false },
        { id: createIdentityId(), nickname: "另一玩家" },
      );
      const replaced = await f.service.get({ roomId: f.room.id, messageId: first.id });
      assert(replaced.kind === "player" && replaced.chatOnly);
      assert.equal(replaced.pendingAgent, undefined);
      assert.deepEqual(await f.service.send(firstInput, player), replaced);
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "游戏外闲聊", chatOnly: true },
        player,
      );
      assert.equal(calls.length, 0);
      const queued = await f.service.history({ roomId: f.room.id, limit: 1 });
      assert.deepEqual(queued.submissionMode, { mode: "manual", revision: 1 });
      assert.deepEqual(queued.pendingMessageIds, [second.id, peer.id]);
      await f.service.close();
      reopened = new ChatService(f.sessions, runtime, credentials);
      const restored = await reopened.history({ roomId: f.room.id, limit: 1 });
      assert.deepEqual(restored.submissionMode, { mode: "manual", revision: 1 });
      assert.deepEqual(restored.pendingMessageIds, [second.id, peer.id]);
      const request = { roomId: f.room.id, clientRequestId: randomUUID() };
      const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      try {
        db.sqlite.exec(
          "CREATE TRIGGER fail_continue BEFORE INSERT ON chat_requests WHEN new.operation='continue' BEGIN SELECT RAISE(FAIL, 'continue failure'); END;",
        );
        await assert.rejects(reopened.continue(request, player), /continue failure/);
        assert.deepEqual(
          (await reopened.history({ roomId: f.room.id, limit: 1 })).pendingMessageIds,
          [second.id, peer.id],
        );
        assert.equal(calls.length, 0);
        db.sqlite.exec("DROP TRIGGER fail_continue");
      } finally {
        db.close();
      }
      const [host, duplicate] = await Promise.all([
        reopened.continue(request, player),
        reopened.continue(request, player),
      ]);
      assert.equal(duplicate.id, host.id);
      assert.equal((await reopened.continue(request, player)).id, host.id);
      await waitFor(() => assert.equal(calls.length, 1));
      assert.ok(!calls[0].includes("先观察门锁"));
      assert.ok(calls[0].indexOf("再试着推门") < calls[0].indexOf("守住门口"));
      assert.ok(!calls[0].includes("游戏外闲聊"));
      assert.deepEqual(
        (await reopened.history({ roomId: f.room.id, limit: 20 })).pendingMessageIds,
        [],
      );
      await waitFor(async () => {
        const result = await reopened!.get({ roomId: f.room.id, messageId: host.id });
        assert.equal(result.status, "complete");
      });
      await assert.rejects(
        reopened.continue({ ...request, clientRequestId: randomUUID() }, player),
        /没有待提交/,
      );
      await reopened.setSubmissionMode(f.room.id, "manual");
      const third = await reopened.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "收起火把", chatOnly: false },
        player,
      );
      await reopened.close();
      reopened = new ChatService(f.sessions, runtime, credentials);
      const repeated = await reopened.continue(request, player);
      assert.equal(repeated.id, host.id);
      assert.equal(repeated.status, "complete");
      assert.equal(calls.length, 1);
      assert.deepEqual(
        (await reopened.history({ roomId: f.room.id, limit: 1 })).pendingMessageIds,
        [third.id],
      );
      await reopened.setSubmissionMode(f.room.id, "auto");
      assert.equal(readRoomSettings(join(f.sessions, f.room.id)).chat.submissionMode, "auto");
      await reopened.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "走进大厅", chatOnly: false },
        player,
      );
      await waitFor(() => assert.equal(calls.length, 2));
      assert.ok(!calls[1].includes("收起火把"));
      assert.ok(calls[1].includes("走进大厅"));
      assert.deepEqual(
        (await reopened.history({ roomId: f.room.id, limit: 20 })).pendingMessageIds,
        [],
      );
    } finally {
      await reopened?.close();
      await f.close();
    }
  });
  it("凭据读取期间的并发重试共用执行，发送与继续的请求标识相互隔离", async () => {
    const f = await fixture();
    let calls = 0;
    let credentialReads = 0;
    let entered!: () => void;
    let release!: () => void;
    let waiting: Promise<void>;
    const gate = () => {
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Promise<void>((resolve) => {
        entered = resolve;
      });
    };
    const service = new ChatService(
      f.sessions,
      {
        run: async () => {
          calls++;
        },
      },
      async () => {
        credentialReads++;
        entered();
        await waiting;
        return credentials();
      },
    );
    try {
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "调查",
        chatOnly: false,
      };
      const firstGate = gate();
      const first = service.send(input, player);
      await firstGate;
      const second = service.send(input, player);
      await assert.rejects(service.send({ ...input, text: "不同输入" }, player), /不同/);
      release();
      const [sent, repeated] = await Promise.all([first, second]);
      assert.equal(sent.id, repeated.id);
      assert.equal(credentialReads, 1);
      const host = (await service.history({ roomId: f.room.id, limit: 50 })).messages.find(
        (message) => message.kind === "assistant",
      )!;
      await service.cancel(f.room.id, host.id);
      assert.equal(calls, 1);
      await service.setSubmissionMode(f.room.id, "manual");
      await service.send({ ...input, clientMessageId: randomUUID(), text: "接着调查" }, player);
      const request = { roomId: f.room.id, clientRequestId: input.clientMessageId };
      const secondGate = gate();
      const continuation = service.continue(request, player);
      await secondGate;
      const retry = service.continue(request, player);
      release();
      const [next, duplicate] = await Promise.all([continuation, retry]);
      assert.equal(next.id, duplicate.id);
      assert.notEqual(next.id, sent.id);
      assert.equal(credentialReads, 2);
      await service.cancel(f.room.id, next.id);
      assert.equal(calls, 2);
    } finally {
      release?.();
      await service.close();
      await f.close();
    }
  });
  for (const credentialFails of [false, true]) {
    it(`自动发送读取凭据${credentialFails ? "失败" : "成功"}前切到手动，只保存一次待提交行动`, async () => {
      const f = await fixture();
      await f.service.close();
      let calls = 0;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = new ChatService(
        f.sessions,
        {
          run: async () => {
            calls++;
          },
        },
        async () => {
          entered();
          await waiting;
          if (credentialFails) throw new Error("未配置主持模型");
          return credentials();
        },
      );
      onTestFinished(async () => {
        release();
        await service.close();
        await f.close();
      });
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "等待大家一起行动",
        chatOnly: false,
      };
      const first = service.send(input, player);
      await ready;
      const retry = service.send(input, player);
      await service.setSubmissionMode(f.room.id, "manual");
      release();
      const [saved, repeated] = await Promise.all([first, retry]);
      assert.equal(saved.id, repeated.id);
      const history = await service.history({ roomId: f.room.id, limit: 50 });
      assert.equal(history.messages.length, 1);
      assert.deepEqual(history.pendingMessageIds, [saved.id]);
      assert.equal(saved.kind === "player" && saved.pendingAgent, true);
      assert.equal(calls, 0);
      await service.setSubmissionMode(f.room.id, "auto");
      await service.closeRoom(f.room.id);
      assert.equal((await service.send(input, player)).id, saved.id);
      const restored = await service.history({ roomId: f.room.id, limit: 50 });
      assert.deepEqual(restored.pendingMessageIds, [saved.id]);
      assert.equal(restored.messages.length, 1);
      assert.equal(calls, 0);
    });
  }
  for (const closeApplication of [false, true]) {
    it(`发送等待凭据时${closeApplication ? "退出应用" : "关闭冒险"}，明确拒绝且不保存消息`, async () => {
      const f = await fixture();
      await f.service.close();
      let calls = 0;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const service = new ChatService(
        f.sessions,
        {
          run: async () => {
            calls++;
          },
        },
        async () => {
          entered();
          await waiting;
          return credentials();
        },
      );
      let reopened: ChatService | undefined;
      onTestFinished(async () => {
        release();
        await reopened?.close();
        await service.close();
        await f.close();
      });
      const rejected = assert.rejects(
        service.send(
          { roomId: f.room.id, clientMessageId: randomUUID(), text: "尚未提交", chatOnly: false },
          player,
        ),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "UNAVAILABLE",
      );
      await ready;
      await service.setSubmissionMode(f.room.id, "manual");
      if (closeApplication) await service.close();
      else await service.closeRoom(f.room.id);
      release();
      await rejected;
      reopened = new ChatService(
        f.sessions,
        {
          run: async () => {
            calls++;
          },
        },
        credentials,
      );
      assert.equal((await reopened.history({ roomId: f.room.id, limit: 50 })).messages.length, 0);
      assert.equal(calls, 0);
    });
  }
  it("发送等待凭据时另一条指令已启动主持，即使切到手动也不绕过运行冲突", async () => {
    const f = await fixture();
    await f.service.close();
    let reads = 0;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ChatService(
      f.sessions,
      {
        run: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      async () => {
        if (++reads === 1) {
          entered();
          await waiting;
        }
        return credentials();
      },
    );
    onTestFinished(async () => {
      release();
      await service.close();
      await f.close();
    });
    const input = {
      roomId: f.room.id,
      clientMessageId: randomUUID(),
      text: "晚到的行动",
      chatOnly: false,
    };
    const rejected = assert.rejects(
      service.send(input, player),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    await ready;
    const first = await service.send(
      { ...input, clientMessageId: randomUUID(), text: "先提交的行动" },
      player,
    );
    await service.setSubmissionMode(f.room.id, "manual");
    release();
    await rejected;
    const history = await service.history({ roomId: f.room.id, limit: 50 });
    assert.deepEqual(
      history.messages.filter((message) => message.kind === "player").map((message) => message.id),
      [first.id],
    );
    assert.deepEqual(history.pendingMessageIds, []);
    const host = history.messages.find((message) => message.kind === "assistant")!;
    await service.cancel(f.room.id, host.id);
    const retried = await service.send(input, player);
    assert.deepEqual((await service.history({ roomId: f.room.id, limit: 50 })).pendingMessageIds, [
      retried.id,
    ]);
  });
  it("重新打开房间使用新的聊天事件流，旧游标明确要求读取快照", async () => {
    const f = await fixture();
    try {
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "已保存", chatOnly: true },
        player,
      );
      const old = await f.service.history({ roomId: f.room.id, limit: 50 });
      await f.service.closeRoom(f.room.id);
      const current = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.deepEqual(current.messages, old.messages);
      assert.notEqual(current.streamId, old.streamId);
      assert.equal(current.cursor, 0);
      const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
      const stale = f.service.subscribeRoom(
        {
          roomId: f.room.id,
          protocolVersion: ROOM_PROTOCOL_VERSION,
          baselineVersion: baseline.version,
          afterChatCursor: old.cursor,
          afterChatStreamId: old.streamId,
        },
        player,
      );
      assert.equal((await stale.next()).value?.type, "state");
      await assert.rejects(
        stale.next(),
        (error: unknown) =>
          error instanceof Error &&
          "data" in error &&
          (error.data as { reason?: string })?.reason === "CHAT_RESYNC_REQUIRED",
      );
    } finally {
      await f.close();
    }
  });
  it("过大的事件回退快照，后续小通知仍可重放", () => {
    const events = new ChatEvents();
    events.publish([
      {
        type: "agent",
        messageId: randomUUID(),
        attemptId: randomUUID(),
        revision: 1,
        events: [
          {
            type: "text_delta",
            messageIndex: 0,
            contentIndex: 0,
            delta: "x".repeat(9 * 1024 * 1024),
          },
        ],
      },
    ]);
    assert.throws(() => events.after(events.streamId, 0, 32), /快照/);
    const cursor = events.cursor;
    events.publish([{ type: "mode", snapshot: { mode: "manual", revision: 1 } }]);
    assert.deepEqual(events.after(events.streamId, cursor, 32), [
      { type: "mode", snapshot: { mode: "manual", revision: 1 }, cursor: cursor + 1 },
    ]);
  });
  it("消息提交后启动失败，发送与继续重试仍返回已保存结果", async () => {
    const f = await fixture();
    const start = spyOn(ChatRuns.prototype, "start");
    try {
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "调查",
        chatOnly: false,
      };
      start.mockImplementationOnce(() => {
        throw new Error("start failure");
      });
      await assert.rejects(f.service.send(input, player), /start failure/);
      const saved = (await f.service.history({ roomId: f.room.id, limit: 50 })).messages;
      assert.equal(saved.length, 2);
      assert.equal(saved[1].status, "interrupted");
      assert.equal((await f.service.send(input, player)).id, saved[0].id);
      assert.equal((await f.service.history({ roomId: f.room.id, limit: 50 })).messages.length, 2);
      const failed = saved[1];
      assert(failed.kind === "assistant" && failed.inputBatch);
      await assert.rejects(
        f.service.send({ ...input, clientMessageId: randomUUID() }, player),
        /先重试或放弃/,
      );
      await f.service.resolveInput(
        {
          roomId: f.room.id,
          messageId: failed.id,
          batchId: failed.inputBatch.id,
          action: "abandon",
        },
        player,
      );
      await f.service.setSubmissionMode(f.room.id, "manual");
      await f.service.send({ ...input, clientMessageId: randomUUID(), text: "继续调查" }, player);
      const request = { roomId: f.room.id, clientRequestId: randomUUID() };
      start.mockImplementationOnce(() => {
        throw new Error("start failure");
      });
      await assert.rejects(f.service.continue(request, player), /start failure/);
      const history = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.equal(history.messages.length, 4);
      assert.deepEqual(history.pendingMessageIds, []);
      const repeated = await f.service.continue(request, player);
      assert.equal(repeated.id, history.messages.at(-1)!.id);
      assert.equal(repeated.status, "interrupted");
      assert.equal((await f.service.history({ roomId: f.room.id, limit: 50 })).messages.length, 4);
    } finally {
      start.mockRestore();
      await f.close();
    }
  });

  it("提交方式设置无效时拒绝保存，保留文件且不发布模式事件", async () => {
    const f = await fixture();
    try {
      assert.deepEqual(await f.service.setSubmissionMode(f.room.id, "manual"), {
        mode: "manual",
        revision: 1,
      });
      const changed = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.deepEqual(
        await f.service.setSubmissionMode(f.room.id, "manual"),
        changed.submissionMode,
      );
      assert.equal(
        (await f.service.history({ roomId: f.room.id, limit: 50 })).cursor,
        changed.cursor,
      );
      assert.deepEqual(await f.service.setSubmissionMode(f.room.id, "auto"), {
        mode: "auto",
        revision: 2,
      });
      const before = await f.service.history({ roomId: f.room.id, limit: 50 });
      const path = join(f.sessions, f.room.id, "settings.json");
      const source = await readFile(path, "utf8");
      const damaged = source.replace('"submissionMode": "auto"', '"submissionMode": "invalid"');
      assert.notEqual(damaged, source);
      await writeFile(path, damaged);
      await assert.rejects(f.service.setSubmissionMode(f.room.id, "manual"), /chat.submissionMode/);
      assert.equal(await readFile(path, "utf8"), damaged);
      await writeFile(
        path,
        source.replace('"submissionMode": "auto"', '"submissionMode": "manual"'),
      );
      const after = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.deepEqual(after.submissionMode, { mode: "manual", revision: 2 });
      assert.equal(after.cursor, before.cursor);
    } finally {
      await f.close();
    }
  });
  it("历史分页不隐藏主持运行状态，取消保留部分回复且重试不重跑", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      run: async ({ onAgentEvent, signal }) => {
        emitText(onAgentEvent, "你来到洞口。");
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    try {
      const input = {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "开始",
        chatOnly: false,
      };
      const source = await f.service.send(input, player);
      await ready;
      await assert.rejects(
        f.service.send({ ...input, clientMessageId: randomUUID() }, player),
        /正在回复/,
      );
      await f.service.send({ ...input, clientMessageId: randomUUID(), chatOnly: true }, player);
      const ai = (await f.service.history({ roomId: f.room.id, limit: 50 })).messages.find(
        (m) => m.kind === "assistant",
      )!;
      for (let i = 0; i < 55; i++)
        await f.service.send(
          { ...input, clientMessageId: randomUUID(), text: `闲聊 ${i}`, chatOnly: true },
          player,
        );
      const page = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.ok(page.messages.every((message) => message.kind === "player"));
      const activity = (await f.service.roomProjection(f.room.id, player)).sections.chatActivity;
      assert.equal(activity.running?.messageId, ai.id);
      assert.equal(activity.running?.runId, ai.id);
      assert.equal(activity.running?.companionId, undefined);
      await f.service.cancel(f.room.id, activity.running!.runId);
      const completed = await f.service.get({ roomId: f.room.id, messageId: ai.id });
      assert.equal(chatText(completed), "你来到洞口。");
      assert.equal(completed.status, "cancelled");
      assert.deepEqual((await f.service.roomProjection(f.room.id, player)).sections.chatActivity, {
        running: null,
        queued: null,
      });
      assert.equal((await f.service.send(input, player)).id, source.id);
      assert.deepEqual((await f.service.roomProjection(f.room.id, player)).sections.chatActivity, {
        running: null,
        queued: null,
      });
    } finally {
      await f.close();
    }
  });
  it("失败保留原消息，下一条玩家输入开启新回合", async () => {
    let attempt = 0;
    const f = await fixture({
      run: async ({ onAgentEvent }) => {
        if (attempt++ === 0) {
          throw new Error("secret-key");
        }
        emitText(onAgentEvent, "继续冒险");
      },
    });
    try {
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
        player,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ai = (await f.service.history({ roomId: f.room.id, limit: 50 })).messages[1];
      assert.equal(ai.status, "failed");
      assert.ok(!ai.error?.includes("secret-key"));
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "接着探索", chatOnly: false },
        player,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const history = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.equal(history.messages.length, 4);
      assert.equal(history.messages[1].status, "failed");
      assert.equal(chatText(history.messages[3]), "继续冒险");
      assert.notEqual(history.messages[3].id, ai.id);
    } finally {
      await f.close();
    }
  });
  it("同一 clientMessageId 在不同玩家身份下相互隔离", async () => {
    const f = await fixture();
    const input = {
      roomId: f.room.id,
      clientMessageId: randomUUID(),
      text: "各自发言",
      chatOnly: true,
    };
    try {
      const [luna, other] = await Promise.all([
        f.service.send(input, player),
        f.service.send(input, { id: randomUUID(), nickname: "另一位玩家" }),
      ]);
      assert.notEqual(luna.id, other.id);
      assert.equal((await f.service.history({ roomId: f.room.id, limit: 50 })).messages.length, 2);
    } finally {
      await f.close();
    }
  });
  it("流式提交失败中止运行，恢复存储后 history 无需重启即可修复中断状态", async () => {
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const wasAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const f = await fixture({
      run: async ({ onAgentEvent, signal }) => {
        emitText(onAgentEvent, "无法落盘的片段");
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted();
      },
    });
    let db: SessionDatabase | undefined;
    try {
      useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
        player,
      );
      await hasStarted;
      db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
      db.sqlite.exec(
        "CREATE TRIGGER fail_stream BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(FAIL, 'disk failure'); END;",
      );
      advanceTimersByTime(100);
      await wasAborted;
      // 让运行完成收尾，再恢复存储，避免 history 与失败处理竞争。
      await new Promise<void>((resolve) => setImmediate(resolve));
      db.sqlite.exec("DROP TRIGGER fail_stream");
      const history = await f.service.history({ roomId: f.room.id, limit: 50 });
      assert.equal(chatText(history.messages[1]), "");
      assert.equal(history.messages[1].status, "interrupted");
      assert.equal(history.messages[1].error, "上次生成已中断，请发送新消息从当前状态继续。");
    } finally {
      useRealTimers();
      db?.close();
      await f.close();
    }
  });
  it("独立 MessagePort 客户端通过房间流收发聊天、游标重放和取消", async () => {
    const f = await fixture();
    const channels: MessageChannel[] = [];
    function connect(nickname: string, isHost = false) {
      const channel = new MessageChannel();
      channels.push(channel);
      const handler = new RPCHandler(gameRouter);
      // Node 原生 MessagePort 的 addEventListener 与浏览器 MessagePort 协议一致。
      handler.upgrade(channel.port1 as unknown as MessagePort, {
        context: { chat: f.service, player: { id: randomUUID(), nickname }, isHost },
      });
      channel.port1.start();
      channel.port2.start();
      return createORPCClient<ContractRouterClient<typeof gameContract>>(
        new RPCLink({ port: channel.port2 as unknown as MessagePort }),
      );
    }
    const first = connect("甲"),
      second = connect("乙");
    const abort = new AbortController();
    try {
      assert.deepEqual((await first.chat.history({ roomId: f.room.id, limit: 50 })).messages, []);
      assert.equal((await first.steering.get({ roomId: f.room.id })).isHost, false);
      await assert.rejects(
        first.steering.setEnabled({ roomId: f.room.id, enabled: true }),
        /只有房主/,
      );
      await assert.rejects(
        first.chat.setSubmissionMode({ roomId: f.room.id, mode: "manual" }),
        /只有房主/,
      );
      await assert.rejects(
        first.chat.continue({ roomId: f.room.id, clientRequestId: randomUUID() }),
        /只有房主/,
      );
      await assert.rejects(
        first.agent.cancel({ roomId: f.room.id, messageId: randomUUID() }),
        /只有房主/,
      );
      await assert.rejects(
        first.steering.submit({
          roomId: f.room.id,
          clientRequestId: randomUUID(),
          interrupt: true,
        }),
        /只有房主/,
      );
      const host = connect("房主", true);
      assert.equal((await host.steering.get({ roomId: f.room.id })).isHost, true);
      assert.equal(
        (await host.steering.setEnabled({ roomId: f.room.id, enabled: true })).enabled,
        true,
      );
      const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
      const subscribe = async (
        client: ContractRouterClient<typeof gameContract>,
        afterChatCursor: number,
        signal: AbortSignal,
      ) =>
        chatEvents(
          await client.room.subscribe(
            {
              roomId: f.room.id,
              protocolVersion: ROOM_PROTOCOL_VERSION,
              baselineVersion: baseline.version,
              afterChatCursor,
              afterChatStreamId: (await client.chat.history({ roomId: f.room.id })).streamId,
            },
            { signal },
          ),
          (delivery) =>
            client.room.acknowledge({
              roomId: f.room.id,
              subscriptionId: delivery.id,
              sequence: delivery.seq,
            }),
        );
      const stream = await subscribe(second, 0, abort.signal);
      const settingEvent = (await stream.next()).value;
      assert.equal(settingEvent?.type, "steering");
      assert.equal(settingEvent?.type === "steering" && settingEvent.snapshot.enabled, true);
      const next = stream.next();
      const sent = await first.chat.send({
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "联通",
        chatOnly: true,
      });
      const received = await next;
      assert.equal(received.value?.type, "message");
      if (received.value?.type !== "message") throw new Error("期待消息快照");
      assert.equal(received.value.message.id, sent.id);
      assert.equal(received.value?.message.nickname, "甲");
      abort.abort();
      const after = await second.chat.send({
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        text: "已回复",
        chatOnly: true,
      });
      const resumedAbort = new AbortController();
      const resumed = await subscribe(first, received.value!.cursor, resumedAbort.signal);
      const resumedEvent = (await resumed.next()).value;
      assert.equal(
        resumedEvent?.type === "message" ? resumedEvent.message.id : undefined,
        after.id,
      );
      resumedAbort.abort();
      const otherRoom = await createSession(f.sessions, f.module, "另一个房间");
      assert.equal((await first.chat.history({ roomId: otherRoom.id })).messages.length, 0);
    } finally {
      abort.abort();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      await f.close();
    }
  });
});

it("NPC 标记跨增量恢复，台词未生成完即可展示，取消与重开保留说话人", async () => {
  let emit!: (event: PublicAgentEvent) => void;
  const f = await fixture({
    run: async ({ onAgentEvent, signal }) => {
      emit = onAgentEvent;
      emitText(emit, '<message narrator>\n门开了。\n</message>\n<message npc path="角色/卫兵"');
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
    },
  });
  const abort = new AbortController();
  let reopened: ChatService | undefined;
  try {
    const { applyChatEvent } = await import("../../shared/agent-message");
    let messages: import("../../shared/game").ChatMessage[] = [];
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "开门", chatOnly: false },
      player,
    );
    let cursor = 0;
    for await (const event of roomChatEvents(
      f.sessions,
      f.service,
      { roomId: f.room.id, afterCursor: 0 },
      abort.signal,
    )) {
      messages = applyChatEvent(messages, event);
      if (event.type === "agent") {
        cursor = event.cursor;
        break;
      }
    }
    assert.equal(chatText(messages[1]), "门开了。");
    const resumed = roomChatEvents(
      f.sessions,
      f.service,
      { roomId: f.room.id, afterCursor: cursor },
      abort.signal,
    );
    emit({ type: "text_delta", messageIndex: 0, contentIndex: 0, delta: ' name="卫兵">\n北' });
    messages = applyChatEvent(messages, (await resumed.next()).value!);
    const streamed = messages[1];
    assert.equal(streamed.status, "running");
    assert.equal(chatText(streamed), "门开了。\n\n卫兵：北");
    await f.service.cancel(f.room.id, streamed.id);
    abort.abort();
    await resumed.return(undefined);
    await f.service.close();
    reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
    const history = await reopened.history({ roomId: f.room.id, limit: 50 });
    const saved = history.messages[1];
    assert.equal(saved.status, "cancelled");
    assert.equal(chatText(saved), chatText(streamed));
    assert.equal(saved.kind, "assistant");
    if (saved.kind === "assistant") {
      const part = saved.agentMessages[0].content[0];
      assert.equal(part.type === "text" && parseNarrative(part.text).at(-1)?.path, "角色/卫兵");
    }
  } finally {
    abort.abort();
    await reopened?.close();
    await f.close();
  }
});

it("正文持久化为精简 delta，订阅重放可恢复，用量从公开消息汇总", async () => {
  let emit!: (event: PublicAgentEvent) => void;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await fixture({
    run: async ({ onAgentEvent, signal }) => {
      emit = onAgentEvent;
      emitText(onAgentEvent, "你");
      await Promise.race([
        completion,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    },
  });
  const abort = new AbortController();
  try {
    const stream = roomChatEvents(
      f.sessions,
      f.service,
      { roomId: f.room.id, afterCursor: 0 },
      abort.signal,
    );
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
      player,
    );
    const { applyChatEvent } = await import("../../shared/agent-message");
    let messages: import("../../shared/game").ChatMessage[] = [];
    let firstCursor = 0;
    for await (const event of stream) {
      messages = applyChatEvent(messages, event);
      if (event.type === "agent") {
        firstCursor = event.cursor;
        break;
      }
    }
    assert.equal(chatText(messages[1]), "你");
    const resumed = roomChatEvents(
      f.sessions,
      f.service,
      { roomId: f.room.id, afterCursor: firstCursor },
      abort.signal,
    );
    emit({ type: "text_delta", messageIndex: 0, contentIndex: 0, delta: "走进酒馆" });
    const update = (await resumed.next()).value!;
    assert.equal(update.type, "agent");
    if (update.type !== "agent") throw new Error("期待增量事件");
    assert.deepEqual(update.events, [
      { type: "text_delta", messageIndex: 0, contentIndex: 0, delta: "走进酒馆" },
    ]);
    assert.ok(!("message" in update));
    messages = applyChatEvent(messages, update);
    assert.equal(chatText(messages[1]), "你走进酒馆");
    assert.equal(applyChatEvent(messages, update), messages);
    finish();
    const final = (await resumed.next()).value!;
    assert.equal(final.type === "message" && final.message.status, "complete");
    const history = await f.service.history({ roomId: f.room.id, limit: 50 });
    assert.equal(chatText(history.messages[1]), "你走进酒馆");
    assert.equal((await f.service.metrics(f.room.id)).host.totals.completedAttempts, 1);
    await resumed.return(undefined);
  } finally {
    finish();
    abort.abort();
    await f.close();
  }
});

it("主持人掷骰：表达式校验、真实结果范围、请求幂等及指定玩家权限", async () => {
  const f = await fixture();
  try {
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "我在场", chatOnly: true },
      player,
    );
    const input = {
      roomId: f.room.id,
      requestId: randomUUID(),
      expression: "2d6+3",
      reason: "伤害",
    };
    const result = await f.service.requestAgentDice(input);
    assert.equal(result.kind, "dice");
    if (result.kind !== "dice") throw new Error("缺少骰子");
    assert.equal(result.senderId, "agent");
    assert.equal(result.nickname, "主持人");
    assert.equal(result.status, "complete");
    assert.equal(result.dice.rolls?.length, 2);
    assert.ok(result.dice.rolls!.every((n) => n >= 1 && n <= 6));
    assert.equal(
      result.dice.total,
      result.dice.rolls!.reduce((a, b) => a + b, 3),
    );
    assert.deepEqual(await f.service.requestAgentDice(input), result);
    await assert.rejects(f.service.requestAgentDice({ ...input, expression: "1d20" }), /不同/);
    await assert.rejects(
      f.service.requestAgentDice({ ...input, requestId: randomUUID(), expression: "100d6" }),
    );
    const pending = await f.service.requestAgentDice({
      ...input,
      requestId: randomUUID(),
      targetPlayerId: player.id,
    });
    assert.equal(pending.status, "running");
    if (pending.kind !== "dice") throw new Error("缺少骰子");
    assert.equal(pending.dice.targetNickname, player.nickname);
    assert.ok(pending.dice.deadline - Date.now() > 29_000);
    await assert.rejects(
      f.service.rollDice(
        { roomId: f.room.id, messageId: pending.id },
        { id: randomUUID(), nickname: "旁观者" },
      ),
      /指定玩家/,
    );
    const [one, two] = await Promise.all([
      f.service.rollDice({ roomId: f.room.id, messageId: pending.id }, player),
      f.service.rollDice({ roomId: f.room.id, messageId: pending.id }, player),
    ]);
    assert.deepEqual(one, two);
    assert.equal(one.kind === "dice" && one.dice.resolvedBy, "click");
    const page = await f.service.history({ roomId: f.room.id, limit: 50 });
    assert.equal(page.messages.length, 3);
  } finally {
    await f.close();
  }
});

it("掷骰：重开房间将孤儿请求置为失败，不再超时或接受点击", async () => {
  const f = await fixture();
  let resumed: ChatService | undefined;
  try {
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "我在场", chatOnly: true },
      player,
    );
    const pending = await f.service.requestAgentDice({
      roomId: f.room.id,
      requestId: randomUUID(),
      expression: "1d20",
      reason: "察觉",
      targetPlayerId: player.id,
    });
    await f.service.close();
    useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resumed = new ChatService(f.sessions, { run: async () => {} }, credentials);
    const history = await resumed.history({ roomId: f.room.id, limit: 50 });
    const failed = history.messages.find((message) => message.id === pending.id)!;
    assert.equal(failed.status, "failed");
    await assert.rejects(
      resumed.rollDice({ roomId: f.room.id, messageId: pending.id }, player),
      /失效/,
    );
    advanceTimersByTime(30_000);
    assert.deepEqual(
      (await resumed.history({ roomId: f.room.id, limit: 50 })).messages.find(
        (message) => message.id === pending.id,
      ),
      failed,
    );
  } finally {
    useRealTimers();
    await resumed?.close();
    await f.close();
  }
});

it("掷骰先完成后停止主持保留结果，存活请求仍可超时结算", async () => {
  const f = await fixture({
    run: async ({ rollDice, signal }) => {
      await rollDice!({ expression: "1d20", reason: "观察", targetPlayerId: player.id });
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
    },
  });
  try {
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "调查", chatOnly: false },
      player,
    );
    const pending = await waitFor(async () => {
      const page = await f.service.history({ roomId: f.room.id, limit: 50 });
      const dice = page.messages.find((message) => message.kind === "dice");
      const host = page.messages.find((message) => message.kind === "assistant");
      assert(dice && host);
      return { dice, host };
    });
    const complete = await f.service.rollDice(
      { roomId: f.room.id, messageId: pending.dice.id },
      player,
    );
    await f.service.cancel(f.room.id, pending.host.id);
    assert.deepEqual(
      await f.service.rollDice({ roomId: f.room.id, messageId: complete.id }, player),
      complete,
    );
    useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = await f.service.requestAgentDice({
      roomId: f.room.id,
      requestId: randomUUID(),
      expression: "1d6",
      reason: "超时检定",
      targetPlayerId: player.id,
    });
    advanceTimersByTime(30_000);
    const resolved = await f.service.rollDice({ roomId: f.room.id, messageId: timeout.id }, player);
    assert(
      resolved.kind === "dice" &&
        resolved.status === "complete" &&
        resolved.dice.resolvedBy === "timeout",
    );
  } finally {
    useRealTimers();
    await f.close();
  }
});

it.each(["cancel", "failure"] as const)(
  "主持%s时未结算骰子立即失效，不能点击或超时复活",
  async (mode) => {
    let rejectRun!: (error: Error) => void;
    let waitForDice!: Promise<ChatMessage>;
    const f = await fixture({
      run: async ({ rollDice }) => {
        waitForDice = rollDice!({ expression: "1d20", reason: "观察", targetPlayerId: player.id });
        // 故障可发生在并行工具等待期间。
        await Promise.race([
          waitForDice,
          new Promise<never>((_, reject) => {
            rejectRun = reject;
          }),
        ]);
      },
    });
    try {
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "调查", chatOnly: false },
        player,
      );
      const pending = await waitFor(async () => {
        const page = await f.service.history({ roomId: f.room.id, limit: 50 });
        const dice = page.messages.find((message) => message.kind === "dice");
        const host = page.messages.find((message) => message.kind === "assistant");
        assert(dice && host);
        return { dice, host };
      });
      useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      if (mode === "cancel") await f.service.cancel(f.room.id, pending.host.id);
      else {
        rejectRun(new Error("model failed"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await assert.rejects(waitForDice, /失效|abort/i);
      await assert.rejects(
        f.service.rollDice({ roomId: f.room.id, messageId: pending.dice.id }, player),
        /失效/,
      );
      advanceTimersByTime(30_000);
      const failed = (await f.service.history({ roomId: f.room.id, limit: 50 })).messages.find(
        (message) => message.id === pending.dice.id,
      )!;
      assert.equal(failed.status, "failed");
      assert(failed.kind === "dice" && failed.dice.total === undefined);
    } finally {
      useRealTimers();
      await f.close();
    }
  },
);

it("AI 工具等待玩家掷骰后拿到真实结果继续回复", async () => {
  let resultTotal: number | undefined;
  const f = await fixture({
    run: async ({ rollDice, onAgentEvent }) => {
      const result = await rollDice!({
        expression: "1d20",
        reason: "察觉",
        targetPlayerId: player.id,
      });
      if (result.kind !== "dice") throw new Error("掷骰结果无效");
      resultTotal = result.dice.total;
      emitText(onAgentEvent, `检定结果 ${resultTotal}`);
    },
  });
  try {
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "调查", chatOnly: false },
      player,
    );
    const pending = await waitFor(async () => {
      const message = (await f.service.history({ roomId: f.room.id, limit: 50 })).messages.find(
        (message) => message.kind === "dice",
      );
      assert.ok(message);
      return message;
    });
    assert.equal(resultTotal, undefined);
    const result = await f.service.rollDice({ roomId: f.room.id, messageId: pending.id }, player);
    assert.ok(result.kind === "dice");
    assert.ok(result.dice.total !== undefined);
    await waitFor(() => assert.equal(resultTotal, result.dice.total));
    assert.ok(result.dice.total >= 1 && result.dice.total <= 20);
  } finally {
    await f.close();
  }
});

it("序章写入聊天，重复打开不新增；只有一个开局时直接进入选角", async () => {
  const f = await fixture(undefined, { launch: doorLaunch });
  try {
    const first = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.deepEqual(
      first.messages
        .filter((message) => message.kind === "scripted")
        .map((message) => message.text),
      [],
    );
    const ready = first.messages.find((message) => message.kind === "card");
    assert.equal(ready?.card.type, "ready");
    assert.equal(ready?.status, "running");
    const second = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.deepEqual(
      second.messages.map((message) => message.id),
      first.messages.map((message) => message.id),
    );
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const told = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.deepEqual(
      told.messages.filter((message) => message.kind === "scripted").map((message) => message.text),
      ["门楣上挂着一只小铃。\n\n石门只裂开一条缝。"],
    );
    assert.equal(
      told.messages.find((message) => message.kind === "card" && message.card.type === "character")
        ?.status,
      "running",
    );
    const again = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.deepEqual(
      again.messages.map((message) => message.id),
      told.messages.map((message) => message.id),
    );
  } finally {
    await f.close();
  }
});

it("多个开局写入选择卡，点选后才出现选角卡", async () => {
  const f = await fixture(undefined, { launch: multipleLaunch });
  try {
    const arrived = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const ready = arrived.messages.find((message) => message.kind === "card");
    assert.equal(ready?.card.type, "ready");
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const first = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const start = first.messages
      .filter((message) => message.kind === "card")
      .find((message) => message.card.type === "start");
    assert.equal(start?.card.type, "start");
    assert.ok(
      first.messages.some(
        (message) => message.kind === "scripted" && message.text === "石门就在眼前。",
      ),
    );
    assert.equal(
      first.messages.filter(
        (message) => message.kind === "card" && message.card.type === "character",
      ).length,
      0,
    );
    assert.ok(start);
    await f.service.chooseStart(f.room.id, player, start.id, "door");
    const second = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.equal(
      second.messages.filter(
        (message) => message.kind === "scripted" && message.text === "石门就在眼前。",
      ).length,
      1,
    );
    const character = second.messages.find(
      (message) => message.kind === "card" && message.card.type === "character",
    );
    assert.equal(character?.status, "running");
    assert.equal(second.messages.find((message) => message.id === start.id)?.status, "complete");
  } finally {
    await f.close();
  }
});

it("要等当前在场的玩家都确认，才开始讲", async () => {
  const f = await fixture(undefined, { launch: doorLaunch });
  const other = { id: randomUUID(), nickname: "北星" };
  try {
    await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const joined = await f.service.history({ roomId: f.room.id, limit: 20 }, other);
    const ready = joined.messages.find((message) => message.kind === "card");
    assert.equal(ready?.card.type, "ready");
    assert.ok(ready?.kind === "card" && ready.card.type === "ready");
    if (ready?.kind !== "card" || ready.card.type !== "ready") return;
    assert.deepEqual(
      ready.card.players.map((item) => item.nickname),
      ["Luna", "北星"],
    );
    await f.service.confirmReady(f.room.id, player, ready.id);
    const waiting = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    assert.deepEqual(
      waiting.messages
        .filter((message) => message.kind === "scripted")
        .map((message) => message.text),
      [],
    );
    await f.service.confirmReady(f.room.id, other, ready.id);
    const told = await f.service.history({ roomId: f.room.id, limit: 20 }, other);
    assert.deepEqual(
      told.messages.filter((message) => message.kind === "scripted").map((message) => message.text),
      ["门楣上挂着一只小铃。\n\n石门只裂开一条缝。"],
    );
  } finally {
    await f.close();
  }
});

it("序章未完成时不出现选角卡，完成后只插入一次", async () => {
  const text = "风从门缝吹进来🐉。".repeat(20) + "\n\n石门只裂开一条缝。";
  const launch = launchConfigSchema.parse({
    ...doorLaunch,
    preludeFlow: {
      steps: [
        {
          id: "door",
          type: "introduction",
          title: "石门",
          body: `<message narrator>\n${text}\n</message>\n<message npc path="角色/向导" name="陌生人">\n跟我来。\n</message>`,
        },
      ],
    },
  });
  const f = await fixture(undefined, { narrationGap: narrationGapMs, launch });
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const arrived = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const ready = arrived.messages.find((message) => message.kind === "card");
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const mid = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const first = mid.messages.find((message) => message.kind === "scripted");
    assert.ok(first);
    assert.equal(first.status, "running");
    assert.ok(
      !mid.messages.some((message) => message.kind === "card" && message.card.type === "character"),
    );

    await advanceTimersByTimeAsync(10_000);
    const told = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const scripted = told.messages.filter((message) => message.kind === "scripted");
    assert.equal(scripted.length, 2);
    assert.equal(scripted[0].id, first.id);
    assert.equal(scripted[0].text, text);
    assert.equal(scripted[0].status, "complete");
    assert.equal(scripted[1].text, "跟我来。");
    assert.equal(scripted[1].speakerPath, "角色/向导");
    assert.equal(scripted[1].nickname, "陌生人");
    const card = told.messages.find(
      (message) => message.kind === "card" && message.card.type === "character",
    );
    assert.ok(card && card.sequence > scripted[1].sequence);
    assert.equal((await f.service.launchState(f.room.id, player))?.room.intro, "told");
  } finally {
    useRealTimers();
    await f.close();
  }
});

it("序章输出中关闭房间，重开沿用同一条消息继续未发送的正文", async () => {
  const f = await fixture(undefined, { narrationGap: narrationGapMs, launch: doorLaunch });
  let resumed: ChatService | undefined;
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const arrived = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const ready = arrived.messages.find((message) => message.kind === "card");
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const mid = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const first = mid.messages.find((message) => message.kind === "scripted");
    assert.ok(first);
    assert.equal(first.status, "running");
    await f.service.close();
    resumed = new ChatService(f.sessions, { run: async () => {} }, credentials, {
      narrationGap: narrationGapMs,
    });
    const recovered = await resumed.history({ roomId: f.room.id, limit: 20 }, player);
    const continuing = recovered.messages.filter((message) => message.kind === "scripted");
    assert.equal(continuing.length, 1);
    assert.equal(continuing[0].id, first.id);
    assert.equal(continuing[0].text, first.text);
    assert.ok(
      !recovered.messages.some(
        (message) => message.kind === "card" && message.card.type === "character",
      ),
    );

    await advanceTimersByTimeAsync(10_000);
    const told = await resumed.history({ roomId: f.room.id, limit: 20 }, player);
    const scripted = told.messages.filter((message) => message.kind === "scripted");
    assert.equal(scripted.length, 1);
    assert.equal(scripted[0].id, first.id);
    assert.equal(scripted[0].text, doorLaunch.preludeFlow!.steps[0].body);
    assert.equal(scripted[0].status, "complete");
    assert.equal(
      told.messages.filter(
        (message) => message.kind === "card" && message.card.type === "character",
      ).length,
      1,
    );
  } finally {
    useRealTimers();
    await resumed?.close();
    await f.close();
  }
});

it("非空初始化指令完成后，无需刷新自动播完预写开场", async () => {
  const texts = [
    "石门出现在眼前。",
    "向导举起灯。",
    "跟我来。",
    "门内传来脚步声。",
    "你准备怎么做？",
  ];
  const launch = launchConfigSchema.parse({
    gameStarts: [
      {
        ...doorLaunch.gameStarts[0],
        opening: {
          mode: "scripted",
          instructions: "保留已选角色和装备，检查初始状态。",
          beats: [
            { text: texts[0] },
            {
              text: `<message narrator>\n${texts[1]}\n</message>\n<message npc path="角色/向导" name="向导">\n${texts[2]}\n</message>`,
            },
            { text: texts[3] },
            { text: texts[4] },
          ],
        },
      },
    ],
  });
  let finishInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => {
    finishInitialization = resolve;
  });
  let calls = 0;
  const f = await fixture(
    {
      run: async ({ text, onAgentEvent }) => {
        calls++;
        assert.ok(text.includes("保留已选角色和装备，检查初始状态。"));
        await initialization;
        emitText(onAgentEvent, "初始化完成，已保留所选角色与装备。");
      },
    },
    { narrationGap: narrationGapMs, launch },
  );
  const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
  const messages = () =>
    db
      .all(db.query.selectFrom("chat_messages").select("data").orderBy("sequence"))
      .map((row) => JSON.parse(row.data) as ChatMessage);
  const opening = () => readAdventure(join(f.sessions, f.room.id)).launch.state!;
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const arrived = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const ready = arrived.messages.find((message) => message.kind === "card");
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const choosing = await f.service.launchState(f.room.id, player);
    assert.ok(choosing);
    const selected = await f.service.advanceLaunch(
      {
        roomId: f.room.id,
        revision: choosing.progress.revision,
        roomRevision: choosing.room.revision,
        action: "select",
        characterId: choosing.characterIds[0],
      },
      player,
    );
    assert.ok(selected);
    await f.service.advanceLaunch(
      {
        roomId: f.room.id,
        revision: selected.progress.revision,
        roomRevision: selected.room.revision,
        action: "confirm",
      },
      player,
    );

    // 后续只读存档，避免 history/launchState 同步开局时意外触发恢复。
    await waitFor(() => assert.equal(calls, 1));
    await advanceTimersByTimeAsync(10_000);
    const messageId = opening().openingMessageId;
    assert.ok(messageId);
    assert.equal(opening().opening, "running");
    const initializing = messages().find((message) => message.id === messageId);
    assert.ok(initializing?.kind === "assistant" && initializing.internal);
    assert.equal(initializing.status, "running");
    assert.equal(messages().filter((message) => message.kind === "scripted").length, 0);

    finishInitialization();
    await waitFor(() =>
      assert.equal(messages().find((message) => message.id === messageId)?.status, "complete"),
    );
    assert.equal(opening().opening, "running");
    await advanceTimersByTimeAsync(20_000);
    const scripted = messages().filter((message) => message.kind === "scripted");
    assert.deepEqual(
      scripted.map((message) => message.text),
      texts,
    );
    assert.ok(scripted.every((message) => message.status === "complete"));
    assert.equal(scripted[2].speakerPath, "角色/向导");
    assert.equal(opening().opening, "complete");
    assert.equal(opening().openingMessageId, messageId);
    assert.equal(calls, 1);
  } finally {
    finishInitialization();
    useRealTimers();
    db.close();
    await f.close();
  }
});

it("预写开场逐条流式输出，部分正文恢复后才完成开场且不会重复第一段", async () => {
  const firstText = "你站在石门前，风从缝隙里吹出来。".repeat(5);
  const secondText = "向导举起灯，示意你仔细听里面的脚步声。".repeat(5);
  const launch = launchConfigSchema.parse({
    gameStarts: [
      {
        ...doorLaunch.gameStarts[0],
        opening: {
          mode: "scripted",
          beats: [
            {
              text: `<message narrator>\n${firstText}\n</message>\n<message npc path="角色/向导" name="向导">\n${secondText}\n</message>`,
            },
          ],
        },
      },
    ],
  });
  const f = await fixture(undefined, { narrationGap: narrationGapMs, launch });
  let resumed: ChatService | undefined;
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const arrived = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const ready = arrived.messages.find((message) => message.kind === "card");
    assert.ok(ready);
    await f.service.confirmReady(f.room.id, player, ready.id);
    const choosing = await f.service.launchState(f.room.id, player);
    assert.ok(choosing);
    const selected = await f.service.advanceLaunch(
      {
        roomId: f.room.id,
        revision: choosing.progress.revision,
        roomRevision: choosing.room.revision,
        action: "select",
        characterId: choosing.characterIds[0],
      },
      player,
    );
    assert.ok(selected);
    await f.service.advanceLaunch(
      {
        roomId: f.room.id,
        revision: selected.progress.revision,
        roomRevision: selected.room.revision,
        action: "confirm",
      },
      player,
    );
    await advanceTimersByTimeAsync(1000);
    const mid = await f.service.history({ roomId: f.room.id, limit: 20 }, player);
    const first = mid.messages.find((message) => message.kind === "scripted");
    assert.ok(first);
    assert.equal(first.status, "running");
    assert.equal((await f.service.launchState(f.room.id, player))?.room.opening, "running");
    await f.service.close();
    resumed = new ChatService(f.sessions, { run: async () => {} }, credentials, {
      narrationGap: narrationGapMs,
    });
    const recovered = await resumed.history({ roomId: f.room.id, limit: 20 }, player);
    assert.equal(recovered.messages.filter((message) => message.kind === "scripted").length, 1);
    assert.equal(recovered.messages.find((message) => message.id === first.id)?.status, "running");
    await advanceTimersByTimeAsync(10_000);
    const complete = await resumed.history({ roomId: f.room.id, limit: 20 }, player);
    const scripted = complete.messages.filter((message) => message.kind === "scripted");
    assert.deepEqual(
      scripted.map((message) => message.text),
      [firstText, secondText],
    );
    assert.ok(scripted.every((message) => message.status === "complete"));
    assert.equal(scripted[0].id, first.id);
    assert.equal(scripted[1].speakerPath, "角色/向导");
    assert.equal(scripted[1].nickname, "向导");
    assert.equal((await resumed.launchState(f.room.id, player))?.room.opening, "complete");
  } finally {
    useRealTimers();
    await resumed?.close();
    await f.close();
  }
});

it("主持显式结束冒险，保留最终叙事与订阅重放，禁止新行动", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(
    {
      run: async ({ onAgentEvent }) => {
        const db = await openSessionDatabase(f.sessions, f.room.id);
        try {
          await updateGameDocument(db, gameDirectoryForDatabase(db), {
            path: "世界/状态.json",
            changes: [{ op: "set", path: "/ending", value: "won" }],
          });
        } finally {
          db.close();
        }
        assert.equal(
          (await loadSession(f.sessions, f.room.id)).room.status,
          "active",
          "模组结局值不隐式结束冒险",
        );
        const tools = await createGameTools(
          join(f.sessions, f.room.id),
          new AbortController().signal,
        );
        const end = tools.find((tool) => tool.name === "end_adventure")!;
        await end.execute("end", {}, undefined, undefined, undefined as never);
        const endedAt = (await loadSession(f.sessions, f.room.id)).room.endedAt;
        await end.execute("repeat", {}, undefined, undefined, undefined as never);
        assert.equal((await loadSession(f.sessions, f.room.id)).room.endedAt, endedAt);
        const endedDb = await openSessionDatabase(f.sessions, f.room.id);
        try {
          await assert.rejects(
            updateGameDocument(endedDb, gameDirectoryForDatabase(endedDb), {
              path: "世界/状态.json",
              changes: [{ op: "set", path: "/ending", value: "playing" }],
            }),
            /已经结束/,
          );
        } finally {
          endedDb.close();
        }
        emitText(onAgentEvent, "营救完成，本次冒险通关。村民把你们接回了家。");
      },
    },
    { outcome: true },
  );
  try {
    await f.service.send(
      { roomId: f.room.id, clientMessageId: "win", text: "救援", chatOnly: false },
      player,
    );
    let history = await f.service.history({ roomId: f.room.id, limit: 100 }, player);
    for (
      let attempt = 0;
      attempt < 100 &&
      !history.messages.some(
        (message) => message.kind === "assistant" && message.status === "complete",
      );
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      history = await f.service.history({ roomId: f.room.id, limit: 100 }, player);
    }
    const result = history.messages.find(
      (message) => message.kind === "assistant" && message.status === "complete",
    );
    assert.ok(result);
    assert.ok(chatText(result).includes("村民把你们接回了家"));
    assert.equal((await loadSession(f.sessions, f.room.id)).room.status, "ended");
    await assert.rejects(
      f.service.send(
        { roomId: f.room.id, clientMessageId: "more", text: "继续", chatOnly: false },
        player,
      ),
      /已经结束/,
    );
    const signal = new AbortController();
    const subscription = roomChatEvents(
      f.sessions,
      f.service,
      { roomId: f.room.id, afterCursor: 0 },
      signal.signal,
    );
    const event = await subscription.next();
    assert.equal(event.done, false);
    signal.abort();
    await subscription.return(undefined);
  } finally {
    await f.close();
  }
});

it("统计更新终态不重复累加，回滚和通知淘汰不改变结果", async () => {
  const f = await fixture();
  let db: SessionDatabase | undefined;
  try {
    await f.service.history({ roomId: f.room.id, limit: 50 });
    db = await openSessionDatabase(f.sessions, f.room.id);
    const store = new ChatStore();
    const state = { db, events: new EventEmitter(), closed: false };
    const persist = (message: Extract<ChatMessage, { kind: "assistant" }>) => {
      const saved = store.save(state, message);
      assert.ok(saved.kind === "assistant");
      return saved;
    };
    const create = (input: number): Extract<ChatMessage, { kind: "assistant" }> => ({
      id: randomUUID(),
      sequence: 0,
      revision: 1,
      roomId: f.room.id,
      senderId: "agent",
      nickname: "主持人",
      createdAt: new Date().toISOString(),
      kind: "assistant",
      status: "complete",
      attemptId: randomUUID(),
      agentMessages: [
        {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "test",
          content: [],
          timestamp: Date.now(),
          stopReason: "stop",
          usage: {
            input,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            reasoning: 1,
            totalTokens: input + 9,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
        },
      ],
    });
    store.transaction(state, () => {
      for (let i = 0; i < 3; i++) persist(create(1));
    });
    const metrics = new RoomMetrics(db, join(f.sessions, f.room.id), new PiHistory());
    const initial = await metrics.read();
    assert.equal(initial.host.totals.attempts, 3);
    assert.equal(initial.host.totals.totalTokens, 30);
    assert.deepEqual(await metrics.read(), initial);
    const running = store.transaction(state, () => persist({ ...create(10), status: "running" }));
    metrics.start(running, "test", "test");
    metrics.contextWindow(running, 4096);
    metrics.recordTool(running.id);
    const active = await metrics.read();
    assert.equal(active.host.current.status, "running");
    assert.equal(active.host.current.contextTokens, 13);
    assert.equal(active.host.current.contextWindow, 4096);
    assert.equal(active.host.totals.toolCalls, 1);
    assert.equal(active.host.totals.attempts, 4);
    metrics.recordTool(running.id);
    const toolUpdate = await metrics.read();
    assert.equal(toolUpdate.host.totals.toolCalls, 2);
    const failed = store.transaction(state, () =>
      persist({ ...running, revision: 2, status: "failed" }),
    );
    const final = await metrics.read();
    assert.equal(final.host.current.status, "failed");
    assert.equal(final.host.totals.totalTokens, 49);
    assert.equal(final.host.totals.completedAttempts, 3);
    assert.equal(final.host.totals.toolCalls, 2);
    assert.throws(
      () =>
        store.transaction(state, () => {
          persist(create(100));
          throw new Error("metrics rollback");
        }),
      /metrics rollback/,
    );
    assert.deepEqual(await metrics.read(), final);
    const notifications = memoryChatEvents(db);
    notifications.publish(
      Array.from({ length: 1100 }, (_, revision) => ({
        type: "mode" as const,
        snapshot: { mode: "auto" as const, revision },
      })),
    );
    assert.throws(
      () => notifications.after(notifications.streamId, 0, 32),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "PRECONDITION_FAILED",
    );
    assert.deepEqual(await metrics.read(), final);
    const restored = await new RoomMetrics(db, join(f.sessions, f.room.id), new PiHistory()).read();
    assert.equal(restored.host.totals.totalTokens, final.host.totals.totalTokens);
    assert.equal(restored.host.totals.completedAttempts, final.host.totals.completedAttempts);
    assert.equal(restored.host.current.status, failed.status);
    // 新请求尚未返回用量时保留上次读数；流式实测值更新累计，完成快照不重复累加。
    let streaming = store.transaction(state, () =>
      persist({ ...create(0), status: "running", agentMessages: [] }),
    );
    assert.equal((await metrics.read()).host.current.contextTokens, 13);
    const native = {
      ...create(0).agentMessages[0],
      usage: {
        ...create(0).agentMessages[0].usage,
        input: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite: 0,
        totalTokens: 0,
        reasoning: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    streaming = store.appendAgentEvents(state, streaming, [
      { type: "message_start", messageIndex: 0, message: native },
    ]) as typeof streaming;
    assert.equal((await metrics.read()).host.current.contextTokens, 13);
    const usage = { ...native.usage, input: 100, cacheRead: 20, output: 5, totalTokens: 125 };
    streaming = store.appendAgentEvents(state, streaming, [
      { type: "usage", messageIndex: 0, usage },
    ]) as typeof streaming;
    const partial = await metrics.read();
    assert.equal(partial.host.current.contextTokens, 120);
    assert.equal(partial.host.totals.totalTokens, 174);
    store.appendAgentEvents(state, streaming, [
      { type: "message_end", messageIndex: 0, message: { ...native, usage, stopReason: "stop" } },
    ]);
    assert.equal((await metrics.read()).host.totals.totalTokens, 174);
  } finally {
    db?.close();
    await f.close();
  }
});

it("详情回退按数量和字节淘汰，旧回合仍可从 Pi 历史读取，工具统计不丢失", async () => {
  let oversized = false;
  const f = await fixture({
    run: async (args) => {
      args.onDetail?.({
        id: "thinking:0:0",
        kind: "thinking",
        text: oversized ? "x".repeat(2 * 1024 * 1024) : "内存详情",
        status: "complete",
      });
      args.onDetail?.({ id: "tool:read", kind: "tool", text: "read", status: "complete" });
      args.onDetail?.({
        id: "tool:read",
        kind: "tool",
        text: "read",
        result: "完成",
        status: "complete",
      });
      emitText(args.onAgentEvent, "公开叙事");
    },
  });
  const completed: Extract<ChatMessage, { kind: "assistant" }>[] = [];
  try {
    for (let i = 0; i < 10; i++) {
      const { cursor } = await f.service.history({ roomId: f.room.id, limit: 50 });
      const stream = roomChatEvents(f.sessions, f.service, {
        roomId: f.room.id,
        afterCursor: cursor,
      });
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "继续", chatOnly: false },
        player,
      );
      for await (const event of stream) {
        if (
          event.type === "message" &&
          event.message.kind === "assistant" &&
          event.message.status === "complete"
        ) {
          completed.push(event.message);
          break;
        }
      }
    }
    assert.equal((await f.service.details(f.room.id, completed[0].id)).length, 0);
    assert.equal((await f.service.details(f.room.id, completed.at(-1)!.id)).length, 2);
    assert.equal((await f.service.metrics(f.room.id)).host.totals.toolCalls, 10);
    const persisted = await persistPiFixture(
      f.sessions,
      f.room.id,
      completed[0].id,
      "已持久化详情",
    );
    const history = new PiHistory();
    const summary = (await history.summary(join(f.sessions, f.room.id), persisted))!;
    assert.equal(summary.toolCalls, 1);
    assert.ok(!("details" in summary));
    assert.equal((await f.service.details(f.room.id, completed[0].id))[0].text, "已持久化详情");
    // 完整详情的大小也限制内存回退，不只限制回合数量。
    oversized = true;
    const { cursor } = await f.service.history({ roomId: f.room.id, limit: 50 });
    const stream = roomChatEvents(f.sessions, f.service, {
      roomId: f.room.id,
      afterCursor: cursor,
    });
    await f.service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "继续", chatOnly: false },
      player,
    );
    for await (const event of stream) {
      if (
        event.type === "message" &&
        event.message.kind === "assistant" &&
        event.message.status === "complete"
      ) {
        assert.deepEqual(await f.service.details(f.room.id, event.message.id), []);
        break;
      }
    }
    assert.equal((await f.service.metrics(f.room.id)).host.totals.toolCalls, 11);
  } finally {
    await f.close();
  }
});

it("Pi 统计读取等待期间不占用文档锁，同时请求投影和统计不会死锁", async () => {
  const f = await fixture();
  onTestFinished(() => f.close());
  await f.service.send(
    { roomId: f.room.id, clientMessageId: randomUUID(), text: "行动", chatOnly: false },
    player,
  );
  await waitFor(async () => {
    const page = await f.service.history({ roomId: f.room.id, limit: 20 });
    assert.ok(
      page.messages.some(
        (message) => message.kind === "assistant" && message.status === "complete",
      ),
    );
  });
  const original = PiHistory.prototype.summary;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let projection: Promise<unknown> | undefined;
  let stats: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    PiHistory.prototype.summary = async function (...args: Parameters<typeof original>) {
      entered();
      await gate;
      return original.apply(this, args);
    };
    projection = f.service.roomProjection(f.room.id, player);
    await entry;
    stats = f.service.metrics(f.room.id);
    await Promise.race([
      withStateLock(join(f.sessions, f.room.id, "game"), async () => true),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("统计读取阻塞了文档锁")), 1000);
      }),
    ]);
    release();
    await Promise.all([projection, stats]);
  } finally {
    clearTimeout(timer);
    release();
    PiHistory.prototype.summary = original;
    await Promise.allSettled([projection, stats]);
  }
});

describe("主持插话", () => {
  it("默认关闭；容量、作者撤销、请求重试与重启后的待提交队列保持一致", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      run: async (args) => {
        started();
        await new Promise<void>((resolve) =>
          args.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    let reopened: ChatService | undefined;
    try {
      assert.equal((await f.service.steering.get(f.room.id)).enabled, false);
      await assert.rejects(f.service.steering.setEnabled(f.room.id, true, false), /只有房主/);
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
        player,
      );
      await ready;
      const enqueue = (who: typeof player, text: string, id = randomUUID()) =>
        f.service.steering.enqueue({ roomId: f.room.id, clientRequestId: id, text: text }, who);
      await assert.rejects(enqueue(player, "尚未开启"), /未开启/);
      await f.service.steering.setEnabled(f.room.id, true, true);
      const requestId = randomUUID();
      const first = await enqueue(player, "  第一条  ", requestId);
      await enqueue(player, "第二条");
      await assert.rejects(enqueue(player, "第三条"), /每名玩家最多/);
      assert.equal((await enqueue(player, "第一条", requestId)).entries.length, 2);
      await assert.rejects(enqueue(player, "不同内容", requestId), /内容不同/);
      assert.equal(
        (
          await f.service.steering.enqueue(
            {
              roomId: f.room.id,
              clientRequestId: requestId,
              text: "第一条",
            },
            player,
          )
        ).entries.length,
        2,
      );
      const other = { id: randomUUID(), nickname: "另一位玩家" };
      await f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "我也在场", chatOnly: true },
        other,
      );
      await assert.rejects(
        f.service.steering.enqueue(
          {
            roomId: f.room.id,
            clientRequestId: requestId,
            text: `[@另一位玩家](#mention/${other.id}) 第一条`,
          },
          player,
        ),
        /属于聊天/,
      );
      await assert.rejects(
        f.service.steering.remove(f.room.id, first.entries[0]!.id, other, false),
        /只有房主/,
      );
      await f.service.steering.remove(f.room.id, first.entries[0]!.id, player, false);
      assert.equal((await enqueue(player, "第一条", requestId)).entries.length, 1);
      await enqueue(player, "新的第一条");
      await enqueue(other, "补充甲");
      await enqueue(other, "补充乙");
      const third = { id: randomUUID(), nickname: "第三位玩家" };
      await enqueue(third, "第五条");
      await assert.rejects(enqueue(third, "第六条"), /房间最多/);
      await assert.rejects(enqueue(third, "x".repeat(4001)), /4000/);
      const snapshot = await f.service.steering.setEnabled(f.room.id, false, true);
      assert(snapshot.entries.every((entry) => entry.state === "manual"));
      assert.equal(
        (await f.service.steering.setEnabled(f.room.id, true, true)).entries[0]!.state,
        "manual",
      );
      const before = await f.service.history({ roomId: f.room.id, limit: 100 });
      assert.equal(before.messages.filter((m) => m.kind === "player").length, 2);
      await f.service.close();
      reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
      const after = await reopened.steering.get(f.room.id);
      assert.equal(after.enabled, true);
      assert.equal(after.entries.length, 5);
      assert(after.entries.every((entry) => entry.state === "manual"));
      await assert.rejects(
        reopened.steering.submit(
          { roomId: f.room.id, clientRequestId: randomUUID(), interrupt: false },
          other,
          false,
        ),
        /只有房主/,
      );
    } finally {
      await reopened?.close();
      await f.close();
    }
  });

  it("通过真实 Pi 的轮末接收，整组骰子工具先结算，聊天、详情与原生范围切换到新主持消息", async () => {
    const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } =
      await import("@earendil-works/pi-ai");
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { createPiRuntime } = await import("../agent/pi-runtime");
    const provider = fauxProvider({
      provider: `steer-${randomUUID()}`,
      api: `steer-${randomUUID()}`,
      models: [{ id: "host", contextWindow: 100_000, maxTokens: 4096 }],
    });
    const f = await fixture();
    let service: ChatService | undefined;
    let finishContinuation = () => {};
    try {
      await f.service.close();
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: join(f.root, "models.json"),
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(provider.provider);
      const runtime = createPiRuntime({ modelRuntime: async () => modelRuntime });
      let nextReady!: () => void;
      const prepared = new Promise<void>((resolve) => {
        nextReady = resolve;
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const seen: string[] = [];
      let continuationStarted!: () => void;
      const continuationReady = new Promise<void>((resolve) => (continuationStarted = resolve));
      const continuationBarrier = new Promise<void>((resolve) => (finishContinuation = resolve));
      provider.setResponses([
        () => {
          nextReady();
          return fauxAssistantMessage(
            [
              fauxToolCall(
                "roll_dice",
                { expression: "1d6", reason: "第一次" },
                { id: "dice-one" },
              ),
              fauxToolCall(
                "roll_dice",
                { expression: "1d6", reason: "第二次" },
                { id: "dice-two" },
              ),
            ],
            { stopReason: "toolUse" },
          );
        },
        async (context) => {
          seen.push(JSON.stringify(context));
          continuationStarted();
          await continuationBarrier;
          return fauxAssistantMessage("根据补充继续。");
        },
      ]);
      // 阻塞第一轮工具，确保入队发生在整组工具结束之前。
      const actual: Runtime = {
        ...runtime,
        run: (args) =>
          runtime.run({
            ...args,
            rollDice: async (options) => {
              await barrier;
              return args.rollDice!(options);
            },
          }),
      };
      service = new ChatService(f.sessions, actual, async () => ({
        config: { provider: provider.provider.id, model: "host" },
      }));
      await service.steering.setEnabled(f.room.id, true, true);
      await service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "检查", chatOnly: false },
        player,
      );
      await prepared;
      await service.steering.enqueue(
        { roomId: f.room.id, clientRequestId: randomUUID(), text: "先不要开门" },
        player,
      );
      const other = { id: randomUUID(), nickname: "同伴" };
      await service.steering.enqueue(
        { roomId: f.room.id, clientRequestId: randomUUID(), text: "我来观察" },
        other,
      );
      assert.equal((await service.steering.get(f.room.id)).entries.length, 2);
      const firstActivity = (await service.roomProjection(f.room.id, player)).sections.chatActivity
        .running!;
      release();
      await continuationReady;
      const nextActivity = (await service.roomProjection(f.room.id, player)).sections.chatActivity
        .running!;
      assert.equal(nextActivity.runId, firstActivity.runId);
      assert.notEqual(nextActivity.messageId, firstActivity.messageId);
      assert.equal(
        (await service.get({ roomId: f.room.id, messageId: firstActivity.messageId })).status,
        "complete",
      );
      finishContinuation();
      await waitFor(async () => {
        assert.equal(
          (await service!.history({ roomId: f.room.id, limit: 100 })).messages.filter(
            (m) => m.kind === "assistant" && m.status === "running",
          ).length,
          0,
        );
      });
      const history = await service.history({ roomId: f.room.id, limit: 100 });
      const messages = history.messages;
      assert.deepEqual(
        messages.map((m) => m.kind),
        ["player", "assistant", "dice", "dice", "player", "player", "assistant"],
      );
      assert.equal(history.steering.entries.length, 0);
      assert.equal(messages[4]!.senderId, player.id);
      assert.equal(messages[5]!.senderId, other.id);
      assert.equal(chatText(messages[6]!), "根据补充继续。");
      assert.equal(messages[6]!.runId, messages[1]!.id);
      assert(seen[0]!.includes("先不要开门") && seen[0]!.includes(other.id));
      assert.equal((seen[0]!.match(/\"role\":\"toolResult\"/g) ?? []).length, 2);
      const firstDetails = await service.details(f.room.id, messages[1]!.id);
      const nextDetails = await service.details(f.room.id, messages[6]!.id);
      assert.equal(firstDetails.filter((d) => d.kind === "tool").length, 2);
      assert.equal(nextDetails.filter((d) => d.kind === "tool").length, 0);
      const markers = await runtime.history!.steeringBatches(join(f.sessions, f.room.id));
      assert.equal(markers.length, 1);
      assert.equal(markers[0]!.batch.entries.length, 2);

      // Pi 接收标记已保存而 SQLite 投影失败：重启后补齐一次，禁止重送。
      provider.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "roll_dice",
            { expression: "1d6", targetPlayerId: player.id },
            { id: "wait-before-failure" },
          ),
          { stopReason: "toolUse" },
        ),
      ]);
      await service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "再检查", chatOnly: false },
        player,
      );
      let waitingDice!: ChatMessage;
      await waitFor(async () => {
        waitingDice = (await service!.history({ roomId: f.room.id, limit: 100 })).messages.find(
          (m) => m.kind === "dice" && m.status === "running",
        )!;
        assert(waitingDice);
      });
      await service.steering.enqueue(
        { roomId: f.room.id, clientRequestId: randomUUID(), text: "故障补充" },
        player,
      );
      const db = await openSessionDatabase(f.sessions, f.room.id);
      try {
        db.sqlite
          .exec(`CREATE TRIGGER fail_steering_projection BEFORE UPDATE OF data ON chat_messages
          WHEN json_extract(new.data,'$.kind')='player' AND json_extract(new.data,'$.text')='故障补充'
          BEGIN SELECT RAISE(ABORT,'projection unavailable'); END`);
        await service.rollDice({ roomId: f.room.id, messageId: waitingDice.id }, player);
        await waitFor(() => assert.equal(provider.state.callCount, 3));
        // 等待运行故障处理完成，再关闭并重新打开主机。
        await new Promise<void>((resolve) => setImmediate(resolve));
        await service.close();
        db.sqlite.exec("DROP TRIGGER fail_steering_projection");
      } finally {
        db.close();
      }
      service = new ChatService(f.sessions, actual, async () => ({
        config: { provider: provider.provider.id, model: "host" },
      }));
      const restored = await service.history({ roomId: f.room.id, limit: 100 });
      assert.equal(
        restored.messages.filter((m) => m.kind === "player" && chatText(m) === "故障补充").length,
        1,
      );
      assert.equal(restored.steering.entries.length, 0);
      assert.equal(restored.messages.at(-1)!.status, "interrupted");
      assert.equal(
        (await service.history({ roomId: f.room.id, limit: 100 })).messages.length,
        restored.messages.length,
      );
      assert.equal(provider.state.callCount, 3);

      // 直接打断使未结算骰子失效，整个队列进入新的运行；收到的请求重试不再启动。
      provider.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "roll_dice",
            { expression: "1d6", targetPlayerId: player.id },
            { id: "wait-before-interrupt" },
          ),
          { stopReason: "toolUse" },
        ),
        (context) => {
          assert(JSON.stringify(context).includes("立即改变方向"));
          return fauxAssistantMessage("新方向的回应。");
        },
      ]);
      await service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "准备行动", chatOnly: false },
        player,
      );
      let oldHost!: ChatMessage;
      await waitFor(async () => {
        const page = await service!.history({ roomId: f.room.id, limit: 100 });
        oldHost = page.messages.find((m) => m.kind === "assistant" && m.status === "running")!;
        assert(oldHost && page.messages.some((m) => m.kind === "dice" && m.status === "running"));
      });
      await service.steering.enqueue(
        { roomId: f.room.id, clientRequestId: randomUUID(), text: "立即改变方向" },
        player,
      );
      await service.steering.enqueue(
        { roomId: f.room.id, clientRequestId: randomUUID(), text: "同伴也有补充" },
        other,
      );
      const submit = { roomId: f.room.id, clientRequestId: randomUUID(), interrupt: true };
      await service.steering.submit(submit, player, true);
      await waitFor(async () => {
        const page = await service!.history({ roomId: f.room.id, limit: 100 });
        assert.equal(page.steering.entries.length, 0);
        assert.equal(chatText(page.messages.at(-1)!), "新方向的回应。");
        assert.equal(page.messages.at(-1)!.status, "complete");
      });
      const interrupted = await service.history({ roomId: f.room.id, limit: 100 });
      assert.equal(interrupted.messages.find((m) => m.id === oldHost.id)!.status, "cancelled");
      assert.notEqual(interrupted.messages.at(-1)!.runId, oldHost.id);
      assert(!interrupted.messages.some((m) => m.kind === "dice" && m.status === "running"));
      const failedDice = interrupted.messages.find(
        (m) => m.kind === "dice" && m.status === "failed",
      )!;
      assert(failedDice);
      await assert.rejects(
        service.rollDice({ roomId: f.room.id, messageId: failedDice.id }, player),
        /失效/,
      );
      const calls = provider.state.callCount;
      await service.steering.submit(submit, player, true);
      assert.equal(provider.state.callCount, calls);
    } finally {
      finishContinuation();
      await service?.close();
      await f.close();
    }
  });
});

it("同步模组等待 AI 空闲，保留聊天并让下一轮使用新模组", async () => {
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const contents: string[] = [];
  let first = true;
  const runtime: Runtime = {
    run: async ({ roomDirectory, signal }) => {
      contents.push(await readFile(join(roomDirectory, "module/规则/开始.json"), "utf8"));
      if (!first) return;
      first = false;
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  const f = await fixture(runtime);
  onTestFinished(f.close);
  await f.service.send(
    { roomId: f.room.id, clientMessageId: randomUUID(), text: "第一轮行动", chatOnly: false },
    player,
  );
  await ready;
  await writeFile(join(f.module, "规则/开始.md"), "新版规则正文");
  await assert.rejects(f.service.syncModule(f.room.id), /等待 AI 回复/);
  assert.match(contents[0]!, /冒险从这里开始/);
  finish();
  await waitFor(async () => {
    const history = await f.service.history({ roomId: f.room.id, limit: 20 });
    assert.ok(
      !history.messages.some(
        (message) => message.kind === "assistant" && message.status === "running",
      ),
    );
  });
  const before = await f.service.history({ roomId: f.room.id, limit: 20 });
  assert.deepEqual(await f.service.syncModule(f.room.id), { changed: true });
  const after = await f.service.history({ roomId: f.room.id, limit: 20 });
  assert.deepEqual(
    after.messages.map((message) => message.id),
    before.messages.map((message) => message.id),
  );
  await f.service.send(
    { roomId: f.room.id, clientMessageId: randomUUID(), text: "第二轮行动", chatOnly: false },
    player,
  );
  await waitFor(() => {
    assert.equal(contents.length, 2);
  });
  assert.match(contents[1]!, /新版规则正文/);
});

it("同步维护期间拒绝新指令和此前等待凭据的提交", async () => {
  const f = await fixture();
  let releaseCredentials!: () => void;
  let releaseClose!: () => void;
  let credentialsEntered!: () => void;
  let closeEntered!: () => void;
  const credentialsReady = new Promise<void>((resolve) => {
    credentialsEntered = resolve;
  });
  const closeReady = new Promise<void>((resolve) => {
    closeEntered = resolve;
  });
  let runs = 0;
  let holdClose = true;
  const service = new ChatService(
    f.sessions,
    {
      run: async () => {
        runs++;
      },
      closeRoom: async () => {
        if (!holdClose) return;
        holdClose = false;
        closeEntered();
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
    },
    async () => {
      credentialsEntered();
      await new Promise<void>((resolve) => {
        releaseCredentials = resolve;
      });
      return credentials();
    },
  );
  onTestFinished(async () => {
    releaseCredentials?.();
    releaseClose?.();
    await service.close();
    await f.close();
  });
  const sending = service
    .send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "等待凭据的行动", chatOnly: false },
      player,
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  await credentialsReady;
  await writeFile(join(f.module, "规则/开始.md"), "维护后规则");
  const syncing = service.syncModule(f.room.id);
  await closeReady;
  await assert.rejects(
    service.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "维护中的新行动", chatOnly: false },
      player,
    ),
    /正在同步模组/,
  );
  releaseCredentials();
  assert.match(String(await sending), /冒险正在关闭/);
  releaseClose();
  assert.deepEqual(await syncing, { changed: true });
  assert.equal(runs, 0);
  assert.equal((await service.history({ roomId: f.room.id, limit: 20 })).messages.length, 0);
  await writeFile(join(f.module, "规则/开始.md"), "第二次同步规则");
  const simultaneous = await Promise.allSettled([
    service.syncModule(f.room.id),
    service.syncModule(f.room.id),
  ]);
  assert.equal(simultaneous.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(simultaneous.filter((result) => result.status === "rejected").length, 1);
});

it("手动压缩期间同步状态并阻止重复操作，失败可重试，关闭冒险会取消压缩", async () => {
  let started!: () => void;
  let finish!: () => void;
  let fail = false;
  let signal: AbortSignal | undefined;
  let ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture({
    run: async (args) => {
      assert.equal(args.operation, "compact");
      signal = args.signal;
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
        args.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      args.signal.throwIfAborted();
      if (fail) throw new Error("摘要请求失败");
    },
  });
  try {
    const initial = await f.service.history({ roomId: f.room.id, limit: 50 });
    const first = f.service.compact(f.room.id);
    await ready;
    assert.equal(
      (await f.service.roomProjection(f.room.id, player)).sections.metrics.compactingActorId,
      "host",
    );
    await assert.rejects(f.service.compact(f.room.id), /等待当前生成/);
    await assert.rejects(
      f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "继续", chatOnly: false },
        player,
      ),
    );
    fail = true;
    const failed = assert.rejects(first, /摘要请求失败/);
    finish();
    await failed;
    assert.equal((await f.service.metrics(f.room.id)).compactingActorId, undefined);
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const retry = f.service.compact(f.room.id);
    await ready;
    fail = false;
    finish();
    await retry;
    assert.equal(
      (await f.service.history({ roomId: f.room.id, limit: 50 })).messages.length,
      initial.messages.length,
    );
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelled = f.service.compact(f.room.id);
    const rejected = assert.rejects(cancelled);
    await ready;
    await f.service.closeRoom(f.room.id);
    await rejected;
    assert.equal(signal?.aborted, true);
  } finally {
    finish?.();
    await f.close();
  }
});

it("未接收批次重启后不自动运行，可重试或放弃；原生已接收但确认失败时不重投", async () => {
  const f = await fixture();
  const start = spyOn(ChatRuns.prototype, "start");
  let reopened: ChatService | undefined;
  try {
    start.mockImplementationOnce(() => {
      throw new Error("准备失败");
    });
    await assert.rejects(
      f.service.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "原始行动", chatOnly: false },
        player,
      ),
      /准备失败/,
    );
    const history = await f.service.history({ roomId: f.room.id, limit: 50 });
    const failed = history.messages.find((message) => message.kind === "assistant")!;
    assert(failed.kind === "assistant" && failed.inputBatch);
    const batchId = failed.inputBatch.id;
    assert.deepEqual(Object.keys(failed.inputBatch).sort(), ["id", "state"]);
    const privateDb = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
    try {
      assert.match(
        privateDb.sqlite
          .prepare<unknown[], { data: string }>("SELECT data FROM chat_input_batches WHERE id=?")
          .get(batchId)!.data,
        /原始行动/,
      );
    } finally {
      privateDb.close();
    }
    start.mockRestore();
    await f.service.close();
    let calls = 0;
    reopened = new ChatService(
      f.sessions,
      {
        history: new PiHistory(),
        run: async (args) => {
          calls++;
          assert.ok(args.text.includes("原始行动"));
          assert.equal(args.inputBatch?.id, batchId);
          args.onInputReceived?.({
            batchId,
            messageId: args.messageId,
            reference: { sessionId: randomUUID(), beforeEntryId: null, afterEntryId: "received" },
          });
          emitText(args.onAgentEvent, "完成");
        },
      },
      credentials,
    );
    const projection = await reopened.roomProjection(f.room.id, player);
    assert.equal(calls, 0);
    assert.equal(projection.sections.chatActivity.pendingInput?.batchId, batchId);
    await assert.rejects(
      reopened.send(
        { roomId: f.room.id, clientMessageId: randomUUID(), text: "新行动", chatOnly: false },
        player,
      ),
      /先重试或放弃/,
    );
    await reopened.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "仅聊天", chatOnly: true },
      player,
    );
    await reopened.resolveInput(
      { roomId: f.room.id, messageId: failed.id, batchId, action: "retry" },
      player,
    );
    await waitFor(async () =>
      assert.equal(
        (await reopened!.get({ roomId: f.room.id, messageId: failed.id })).status,
        "complete",
      ),
    );
    await reopened.resolveInput(
      { roomId: f.room.id, messageId: failed.id, batchId, action: "retry" },
      player,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      reopened.resolveInput(
        { roomId: f.room.id, messageId: failed.id, batchId, action: "abandon" },
        player,
      ),
      /已送达/,
    );
    await reopened.close();
    // 模拟原生输入落盘成功、应用接收确认尚未提交就退出。
    const db = new SessionDatabase(join(f.sessions, f.room.id, "session.sqlite"));
    const saved = JSON.parse(
      db.sqlite
        .prepare<unknown[], { data: string }>("SELECT data FROM chat_messages WHERE id=?")
        .get(failed.id)!.data,
    );
    saved.inputBatch.state = "prepared";
    saved.status = "running";
    db.sqlite
      .prepare("UPDATE chat_messages SET data=? WHERE id=?")
      .run(JSON.stringify(saved), failed.id);
    db.close();
    const agent = join(f.sessions, f.room.id, "agent");
    await mkdir(agent, { recursive: true });
    const path = join(agent, "session.jsonl");
    await writeFile(path, "");
    const manager = SessionManager.open(path, agent);
    manager.appendCustomMessageEntry(inputBatchCustomType, "原始行动", false, {
      batchId,
      messageId: failed.id,
    });
    reopened = new ChatService(
      f.sessions,
      {
        history: new PiHistory(),
        run: async () => {
          calls++;
        },
      },
      credentials,
    );
    const recovered = await reopened.roomProjection(f.room.id, player);
    assert.equal(recovered.sections.chatActivity.pendingInput, undefined);
    const received = await reopened.get({ roomId: f.room.id, messageId: failed.id });
    assert(received.kind === "assistant");
    assert.equal(received.inputBatch?.state, "received");
    assert.equal(calls, 1);
  } finally {
    start.mockRestore();
    await reopened?.close();
    await f.close();
  }
});
