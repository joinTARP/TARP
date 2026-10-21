import { expect, test, onTestFinished } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTestModule } from "@tarp/module/testing/test-module";

import type { CompactionRole } from "../../shared/compaction-settings";
import { initializeRoomSettings } from "../sessions/room-settings";
import { createSession, openSessionDatabase } from "../sessions/session-store";
import { inputBatchCustomType } from "./input-batch";
import { createPiRuntime, roomResources } from "./pi-runtime";

async function fixture(
  role: CompactionRole = "host",
  seed?: (manager: SessionManager) => void,
  contextWindow = 8192,
) {
  const directory = await mkdtemp(join(tmpdir(), "tarp-game-memory-"));
  initializeRoomSettings(directory);
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: `memory-${randomUUID()}`,
    api: `memory-${randomUUID()}`,
    models: [{ id: "memory", contextWindow, maxTokens: 2048 }],
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const errors: Error[] = [];
  const resources = roomResources(directory, "", "", undefined, role, (error) =>
    errors.push(error),
  );
  await resources.reload();
  const manager = SessionManager.create(directory, directory);
  seed?.(manager);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model: provider.getModel(),
    resourceLoader: resources,
    sessionManager: manager,
    tools: [],
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 100 },
      retry: { enabled: false },
    }),
  });
  onTestFinished(async () => {
    await session.abort();
    session.dispose();
  });
  return { provider, manager, session, errors, directory, modelRuntime: runtime };
}

function addSplitTurn(manager: SessionManager, goal: string, contextTokens = 0) {
  manager.appendMessage({ role: "user", content: goal, timestamp: Date.now() });
  manager.appendMessage(
    fauxAssistantMessage(fauxToolCall("batch_update", { updates: [] }, { id: "save" }), {
      stopReason: "toolUse",
    }),
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "save",
    toolName: "batch_update",
    isError: true,
    content: [{ type: "text", text: "部分成功：已保存角色资料，场景资料未保存。" }],
    timestamp: Date.now(),
  });
  const latest = fauxAssistantMessage("保留最近回复，等待玩家决定。".repeat(100));
  latest.usage.input = contextTokens;
  latest.usage.totalTokens = contextTokens;
  return manager.appendMessage(latest);
}

function summaryInput(context: TranscriptContext) {
  const message = context.messages.find((message) => message.role === "user");
  if (!message || typeof message.content !== "string") throw new Error("摘要请求没有文本输入");
  return JSON.parse(message.content) as { previousSummary: string; conversation: string };
}

test("游戏记忆合并旧摘要和被切开的回合，恢复后保留最近消息与原始历史", async () => {
  const f = await fixture();
  f.manager.appendMessage({
    role: "user",
    content: "甲与乙结盟，玩家尚未得知密道。",
    timestamp: Date.now(),
  });
  f.manager.appendMessage(fauxAssistantMessage("主持承诺交信后介绍守卫；尚未交信。"));
  const firstKept = addSplitTurn(
    f.manager,
    "玩家计划交信，但还没有完成。角色路径 characters/甲.md",
  );
  const requests: TranscriptContext[] = [];
  f.provider.setResponses([
    (context, options) => {
      requests.push(context);
      expect(options?.cacheRetention).toBe("none");
      expect(options?.maxTokens).toBeLessThanOrEqual(819);
      return fauxAssistantMessage(
        "## 人物与关系\n甲与乙结盟。\n## 未完成事项\n交信后介绍守卫，尚未完成。",
      );
    },
    (context) => {
      requests.push(context);
      return fauxAssistantMessage(
        "## 未完成事项\n交信计划取消，改为询问守卫。\n## 当前进展与中断\n角色已保存，场景未保存。",
      );
    },
  ]);
  const first = await f.session.compact();
  const input = summaryInput(requests[0]!);
  expect(input.conversation).toContain("甲与乙结盟");
  expect(input.conversation).toContain("玩家计划交信");
  expect(input.conversation).toContain("batch_update，isError=true");
  expect(input.conversation).toContain("场景资料未保存");
  expect(input.conversation).not.toContain("保留最近回复");
  expect(first.firstKeptEntryId).toBe(firstKept);
  expect(first.summary).toContain("当前游戏存档");
  const nextKept = addSplitTurn(f.manager, "取消交信，改为询问守卫。");
  const second = await f.session.compact();
  expect(summaryInput(requests[1]!).previousSummary).toBe(first.summary);
  expect(summaryInput(requests[1]!).conversation).toContain("取消交信");
  expect(second.firstKeptEntryId).toBe(nextKept);
  expect(f.errors).toEqual([]);

  const reopened = SessionManager.open(f.manager.getSessionFile()!, f.directory, f.directory);
  const summaries = reopened.getEntries().filter((entry) => entry.type === "compaction");
  expect(summaries).toHaveLength(2);
  expect(summaries[1]?.fromHook).toBe(true);
  expect(summaries[1]?.summary).toBe(second.summary);
  expect(summaries[1]?.usage).toBeDefined();
  expect(reopened.getEntry(firstKept)).toBeDefined();
  const projected = JSON.stringify(reopened.buildSessionContext().messages);
  expect(projected).toContain("交信计划取消");
  expect(projected).toContain("保留最近回复");
  expect(projected).not.toContain("主持承诺交信后介绍守卫");
});

test("主持与队友使用自己的会话输入和知情约束，队友摘要不引入主持历史", async () => {
  const host = await fixture();
  const companion = await fixture("companion");
  addSplitTurn(host.manager, "主持秘密：密道通向地窖。");
  addSplitTurn(companion.manager, "队友只看见一扇锁住的门。");
  for (const [f, role] of [
    [host, "host"],
    [companion, "companion"],
  ] as const) {
    f.provider.setResponses([
      (context) => {
        const prompt = JSON.stringify(
          context.messages.filter((message) => message.role === "system"),
        );
        expect(prompt).toContain("已知线索");
        expect(prompt).toContain("未完成事项");
        expect(prompt).toContain("主持承诺与裁定");
        if (role === "host") {
          expect(prompt).toContain("幕后信息（未公开）");
          expect(summaryInput(context).conversation).toContain("密道通向地窖");
        } else {
          expect(prompt).toContain("不能推断幕后真相");
          expect(summaryInput(context).conversation).toContain("锁住的门");
          expect(summaryInput(context).conversation).not.toContain("密道通向地窖");
        }
        return fauxAssistantMessage("## 未完成事项\n等待玩家决定。");
      },
    ]);
    const result = await f.session.compact();
    expect(result.summary).toContain(role === "host" ? "当前游戏存档" : "本轮公开事件");
  }
});

test("截断、空摘要、工具调用、模型失败和取消都不生成检查点或回退到代码摘要", async () => {
  const f = await fixture();
  addSplitTurn(f.manager, "原始任务与主持承诺必须保留。");
  const cases = [
    fauxAssistantMessage("只生成了一半", { stopReason: "length" }),
    fauxAssistantMessage(" "),
    fauxAssistantMessage(fauxToolCall("write", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "认证过期" }),
    fauxAssistantMessage("", { stopReason: "aborted" }),
  ];
  const originalProjection = f.manager.buildSessionContext().messages;
  for (const response of cases) {
    f.provider.setResponses([response]);
    await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
    expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
    expect(f.manager.buildSessionContext().messages).toEqual(originalProjection);
    expect(f.provider.getPendingResponseCount()).toBe(0);
  }
  expect(f.errors).toHaveLength(cases.length);
  expect(f.errors[0]?.message).toContain("摘要被截断");
  expect(f.errors[3]?.message).toContain("认证过期");
  f.provider.setResponses([
    () => {
      f.session.abortCompaction();
      return fauxAssistantMessage("取消后返回的摘要不能保存");
    },
  ]);
  await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
  expect(f.errors).toHaveLength(cases.length);
  expect(f.manager.buildSessionContext().messages).toEqual(originalProjection);
  expect(f.provider.state.callCount).toBe(cases.length + 1);
});

test("达到阈值自动使用游戏摘要继续回复，压缩失败或取消时停止新一轮生成", async () => {
  for (const outcome of ["success", "failure", "cancel"]) {
    const succeeds = outcome === "success";
    const f = await fixture("companion", (manager) => {
      manager.appendMessage({
        role: "user",
        content: "较早线索与关系。".repeat(2000),
        timestamp: Date.now(),
      });
      addSplitTurn(manager, "下一步查证线索。", 8000);
    });
    f.provider.setResponses([
      (context) => {
        expect(summaryInput(context).conversation).toContain("较早线索与关系");
        if (outcome === "cancel") f.session.abortCompaction();
        return succeeds
          ? fauxAssistantMessage("## 已知线索\n已有线索待查证。")
          : fauxAssistantMessage("不完整的游戏摘要", { stopReason: "length" });
      },
      (context) => {
        expect(JSON.stringify(context)).toContain("已有线索待查证");
        return fauxAssistantMessage("下一轮回复。");
      },
    ]);
    await f.session.prompt("继续查证。", { expandPromptTemplates: false });
    const compactions = f.manager.getEntries().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(succeeds ? 1 : 0);
    expect(f.provider.state.callCount).toBe(succeeds ? 2 : 1);
    expect(f.errors).toHaveLength(outcome === "failure" ? 1 : 0);
  }
});

test.each([undefined, "compact"] as const)(
  "游戏运行向调用方返回具体压缩错误，取消不覆盖原因（%s）",
  async (operation) => {
    const f = await fixture("companion");
    const agentDirectory = join(f.directory, "agent");
    await mkdir(agentDirectory);
    await mkdir(join(f.directory, "game"));
    const companionId = randomUUID();
    const path = join(agentDirectory, `companion-${companionId}.jsonl`);
    const manager = SessionManager.open(path, agentDirectory, f.directory);
    manager.appendMessage({
      role: "user",
      content: "尚未完成的主持承诺。".repeat(2000),
      timestamp: Date.now(),
    });
    addSplitTurn(manager, "等待查证。", 8000);
    manager.appendMessage(fauxAssistantMessage("最近回复。".repeat(1000)));
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "服务商拒绝摘要请求" }),
    ]);
    const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
    await expect(
      runtime.run({
        operation,
        roomDirectory: f.directory,
        messageId: randomUUID(),
        text: "继续冒险。",
        config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
        companion: { id: companionId, personality: "谨慎的队友" },
        compaction: { thresholdTokens: 1024 },
        signal: new AbortController().signal,
        onAgentEvent: () => {},
      }),
    ).rejects.toThrow("游戏记忆压缩失败：服务商拒绝摘要请求");
    expect(f.provider.state.callCount).toBe(1);
    const restored = SessionManager.open(path, agentDirectory, f.directory);
    expect(restored.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
    expect(JSON.stringify(restored.buildSessionContext().messages)).toContain("尚未完成的主持承诺");
  },
);

test("运行时手动压缩只生成摘要，保留历史并在重新打开后等待新的上下文读数", async () => {
  const f = await fixture("companion");
  const agentDirectory = join(f.directory, "agent");
  await mkdir(agentDirectory);
  await mkdir(join(f.directory, "game"));
  const companionId = randomUUID();
  const path = join(agentDirectory, `companion-${companionId}.jsonl`);
  const manager = SessionManager.open(path, agentDirectory, f.directory);
  manager.appendMessage({
    role: "user",
    content: "未完成的约定。".repeat(2000),
    timestamp: Date.now(),
  });
  addSplitTurn(manager, "等待查证。", 8000);
  manager.appendMessage(fauxAssistantMessage("最近回复。".repeat(1000)));
  const before = manager.getEntries().length;
  f.provider.setResponses([fauxAssistantMessage("## 未完成事项\n等待查证约定。")]);
  const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
  const args = {
    operation: "compact" as const,
    roomDirectory: f.directory,
    messageId: randomUUID(),
    text: "",
    config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
    companion: { id: companionId, personality: "谨慎的队友" },
    compaction: { thresholdTokens: 1024 },
    signal: new AbortController().signal,
    onAgentEvent: () => {
      throw new Error("压缩不能生成聊天消息");
    },
  };
  await runtime.run(args);
  expect(f.provider.state.callCount).toBe(1);
  const restored = SessionManager.open(path, agentDirectory, f.directory);
  expect(restored.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(restored.getEntries().length).toBeGreaterThan(before);
  expect(
    restored
      .getEntries()
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          String(entry.message.content).includes("未完成的约定"),
      ),
  ).toBe(true);
  expect(await runtime.history!.contextTokens(f.directory, companionId)).toBeNull();
  await runtime.closeRoom!(f.directory);
  expect(await runtime.history!.contextTokens(f.directory, companionId)).toBeNull();
  await expect(runtime.run(args)).rejects.toThrow("已经压缩");
  expect(f.provider.state.callCount).toBe(1);
});

test("主持配置损坏时在调用模型前报错，修复后同一运行器可重试", async () => {
  const f = await fixture();
  const source = await createTestModule();
  onTestFinished(source.cleanup);
  const room = await createSession(source.sessions, source.modulePath, "提示词修复测试");
  const roomDirectory = join(source.sessions, room.id);
  const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
  const args = {
    roomDirectory,
    messageId: randomUUID(),
    text: "继续冒险。",
    config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
    signal: new AbortController().signal,
    onAgentEvent: () => {},
  };
  const metadataPath = join(roomDirectory, "module", "module.json");
  const metadata = await readFile(metadataPath, "utf8");
  // 保持已加载的房间连接，验证本轮提示词读取失败，不能依赖重新打开模组时的校验。
  const db = await openSessionDatabase(source.sessions, room.id);
  try {
    await chmod(metadataPath, 0o600);
    await writeFile(metadataPath, "{");
    await expect(runtime.run(args)).rejects.toThrow("JSON 格式无效");
    expect(f.provider.state.callCount).toBe(0);

    await writeFile(metadataPath, metadata);
    await chmod(metadataPath, 0o444);
    f.provider.setResponses([fauxAssistantMessage("修复后继续冒险。")]);
    await runtime.run(args);
    expect(f.provider.state.callCount).toBe(1);
  } finally {
    db.close();
  }
});

test("主持会话在行动与场外聊天间切换，聊天只暴露查阅工具，下一次行动恢复裁定能力", async () => {
  const f = await fixture("host", undefined, 100_000);
  const source = await createTestModule();
  onTestFinished(source.cleanup);
  const room = await createSession(source.sessions, source.modulePath, "主持聊天测试");
  const roomDirectory = join(source.sessions, room.id);
  const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
  onTestFinished(() => runtime.closeRoom!(roomDirectory));
  f.provider.setResponses(
    [false, true, false].map((chat) => (context: TranscriptContext) => {
      const tools = new Map<string, { description?: string }>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
      }
      expect(tools.has("read")).toBe(true);
      for (const name of [
        "write",
        "update",
        "batch_update",
        "end_adventure",
        "roll_dice",
        "codemode",
      ])
        expect(tools.has(name), name).toBe(!chat);
      const prompt = getCurrentSystemPrompt(context.messages);
      expect(prompt.includes("本轮是点名主持的场外聊天")).toBe(chat);
      expect(prompt).not.toMatch(/真人玩家|AI 队友|独立 AI|队友席位|排队回应/);
      if (!chat) {
        expect(tools.get("roll_dice")?.description).toContain("playerId 作为 targetPlayerId");
        expect(tools.get("roll_dice")?.description).not.toMatch(/真人|AI|点击|立即结算|调度/);
      }
      expect(prompt).toContain("主动在旁白或 NPC 发言正文中使用 [@名称](#mention/玩家ID) 点名");
      expect(prompt).toContain("已明确的行动直接裁定，不为点名重复确认");
      return fauxAssistantMessage(chat ? "这是规则解释，不改变游戏状态。" : "等待玩家行动。");
    }),
  );
  for (const hostChat of [false, true, false]) {
    await runtime.run({
      roomDirectory,
      messageId: randomUUID(),
      hostChat,
      text: hostChat ? "这个规则怎么理解？" : "我观察门口",
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      signal: new AbortController().signal,
      rollDice: async () => {
        throw new Error("本次不应掷骰");
      },
      onAgentEvent: () => {},
    });
  }
  expect(f.provider.state.callCount).toBe(3);
});

test("主持输入原文与接收标记同条落盘，连续请求保持已有历史前缀", async () => {
  const f = await fixture();
  const source = await createTestModule();
  onTestFinished(source.cleanup);
  const room = await createSession(source.sessions, source.modulePath, "接收测试");
  const roomDirectory = join(source.sessions, room.id);
  const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
  const requests: TranscriptContext["messages"][] = [];
  f.provider.setResponses(
    ["第一次结果", "第二次结果"].map((result) => (context: TranscriptContext) => {
      requests.push(structuredClone(context.messages));
      return fauxAssistantMessage(result);
    }),
  );
  const receipts: string[] = [];
  const invoke = async (text: string) => {
    const messageId = randomUUID();
    const id = randomUUID();
    await runtime.run({
      roomDirectory,
      messageId,
      text,
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      inputBatch: {
        id,
        state: "prepared",
        sourceIds: [randomUUID()],
        turns: [{ playerId: randomUUID(), text }],
      },
      signal: new AbortController().signal,
      onInputReceived: (receipt) => {
        expect(receipt.batchId).toBe(id);
        receipts.push(id);
      },
      onAgentEvent: () => {},
    });
  };
  await invoke("第一次行动");
  const path = join(roomDirectory, "agent/session.jsonl");
  const first = await readFile(path, "utf8");
  const messagesBefore = JSON.stringify((await runtime.history!.context(roomDirectory)).groups);
  await invoke("第二次行动");
  const second = await readFile(path, "utf8");
  expect(second.startsWith(first)).toBe(true);
  expect(receipts).toHaveLength(2);
  expect(requests[1]!.slice(0, requests[0]!.length)).toEqual(requests[0]);
  for (const id of receipts) expect(JSON.stringify(requests)).not.toContain(id);

  const restored = SessionManager.open(path);
  const entries = restored
    .getBranch()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === inputBatchCustomType,
    );
  expect(entries).toHaveLength(2);
  expect(JSON.stringify(entries[0])).toContain("第一次行动");
  expect(JSON.stringify(entries[0])).toContain(receipts[0]);
  const context = await runtime.history!.context(roomDirectory);
  expect(JSON.stringify(context.groups.slice(0, JSON.parse(messagesBefore).length))).toBe(
    messagesBefore,
  );
  expect(await runtime.history!.inputBatches(roomDirectory)).toHaveLength(2);
  const failedId = randomUUID();
  await expect(
    runtime.run({
      roomDirectory,
      messageId: randomUUID(),
      text: "确认失败但已写入的行动",
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      inputBatch: {
        id: failedId,
        state: "prepared",
        sourceIds: [randomUUID()],
        turns: [{ playerId: randomUUID(), text: "确认失败但已写入的行动" }],
      },
      signal: new AbortController().signal,
      onInputReceived: () => {
        throw new Error("应用确认失败");
      },
      onAgentEvent: () => {},
    }),
  ).rejects.toThrow("应用确认失败");
  expect(f.provider.state.callCount).toBe(2);
  expect(
    (await runtime.history!.inputBatches(roomDirectory)).map((receipt) => receipt.batchId),
  ).toContain(failedId);
});

for (const tool of [
  "companion_silent",
  "companion_request_ruling",
  "companion_perform",
  "companion_withdraw_action",
] as const) {
  test(`队友 ${tool} 保存结果后按工具语义结束或继续模型请求`, async () => {
    const f = await fixture("companion");
    await mkdir(join(f.directory, "game"));
    const companionId = randomUUID();
    const pendingId = randomUUID();
    const withdrawn: string[] = [];
    const terminal = tool !== "companion_perform";
    f.provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          tool,
          tool === "companion_silent"
            ? {}
            : tool === "companion_withdraw_action"
              ? { messageId: pendingId }
              : tool === "companion_request_ruling"
                ? { intent: "点燃火把并跟上" }
                : { text: "我准备好了" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("收尾"),
    ]);
    const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
    const signal = new AbortController().signal;
    await runtime.run({
      roomDirectory: f.directory,
      messageId: randomUUID(),
      text: "判断是否行动",
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      companion: { id: companionId, personality: "谨慎的队友" },
      requireResponse: tool === "companion_withdraw_action",
      withdrawAction: async (messageId) => {
        withdrawn.push(messageId);
        return {
          id: messageId,
          roomId: randomUUID(),
          sequence: 1,
          revision: 1,
          kind: "assistant",
          senderId: companionId,
          companionId,
          nickname: "队友",
          createdAt: new Date().toISOString(),
          status: "complete",
          chatOnly: true,
          agentMessages: [],
        };
      },
      signal,
      onAgentEvent: () => {},
    });
    expect(signal.aborted).toBe(false);
    expect(withdrawn).toEqual(tool === "companion_withdraw_action" ? [pendingId] : []);
    expect(f.provider.state.callCount).toBe(terminal ? 1 : 2);
    const manager = SessionManager.open(
      join(f.directory, "agent", `companion-${companionId}.jsonl`),
    );
    expect(
      manager
        .buildSessionContext()
        .messages.some(
          (message) =>
            message.role === "toolResult" && message.toolName === tool && !message.isError,
        ),
    ).toBe(true);
  });
}

for (const mode of ["invalid", "mention", "withdraw"] as const) {
  test(`行动工具${mode === "invalid" ? "失败" : mode === "mention" ? "转为点名聊天" : "撤回失败"}不会提前结束队友回合`, async () => {
    const f = await fixture("companion");
    await mkdir(join(f.directory, "game"));
    f.provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          mode === "withdraw" ? "companion_withdraw_action" : "companion_request_ruling",
          mode === "withdraw"
            ? { messageId: randomUUID() }
            : mode === "invalid"
              ? { intent: "" }
              : { intent: "[@玩家](#mention/player) 你先走吗？" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("companion_perform", { text: "我先等你的决定。" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(""),
    ]);
    const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
    await runtime.run({
      roomDirectory: f.directory,
      messageId: randomUUID(),
      text: "判断是否行动",
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      companion: { id: randomUUID(), personality: "谨慎的队友" },
      mentionTargets: [{ id: "player", kind: "player", nickname: "玩家", label: "玩家" }],
      withdrawAction: async () => {
        throw new Error("该行动已开始提交");
      },
      signal: new AbortController().signal,
      onAgentEvent: () => {},
    });
    expect(f.provider.state.callCount).toBe(3);
  });
}

test("队友增量输入跨重开和压缩保留接收记录，事件更新重送，取消不吞掉新事件", async () => {
  const f = await fixture("companion");
  await mkdir(join(f.directory, "game"));
  const companionId = randomUUID();
  const runtime = createPiRuntime({ modelRuntime: async () => f.modelRuntime });
  const path = join(f.directory, "agent", `companion-${companionId}.jsonl`);
  const event = (id: string, pendingAgent = false) => ({ id, text: `事件 ${id}`, pendingAgent });
  let expected: ReturnType<typeof event>[] = [];
  const invoke = async (events: ReturnType<typeof event>[], cancel = false) => {
    const controller = new AbortController();
    f.provider.setResponses([
      (context) => {
        const last = context.messages.at(-1)!;
        const content = last.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        const input = JSON.parse(text.split("\n")[0]);
        expect(input.events).toEqual(expected);
        expect(input.scene).toEqual({ id: "door" });
        if (cancel) controller.abort();
        return fauxAssistantMessage(fauxToolCall("companion_silent", {}), {
          stopReason: "toolUse",
        });
      },
    ]);
    const result = runtime.run({
      roomDirectory: f.directory,
      messageId: randomUUID(),
      text:
        JSON.stringify({ character: { id: companionId }, scene: { id: "door" }, events }) +
        "\n请判断。",
      config: { provider: f.provider.provider.id, model: f.provider.getModel().id },
      companion: { id: companionId, personality: "谨慎的队友" },
      signal: controller.signal,
      onAgentEvent: () => {},
    });
    if (cancel) await expect(result).rejects.toThrow();
    else await result;
  };
  expected = [event("a", true)];
  await invoke(expected);
  expected = [event("b")];
  await invoke([event("a", true), event("b")]);
  await runtime.closeRoom?.(f.directory);
  expected = [event("a")];
  await invoke([event("a"), event("b")]);
  await runtime.closeRoom?.(f.directory);
  const manager = SessionManager.open(path);
  manager.appendCompaction("已知 a、b；行动已经裁定。", manager.getLeafId()!, 1000);
  expected = [];
  await invoke([event("a"), event("b")]);
  expected = [event("c")];
  await invoke([event("a"), event("b"), event("c")], true);
  await invoke([event("a"), event("b"), event("c")]);
  expected = [];
  await invoke([event("a"), event("b"), event("c")]);
  const restored = SessionManager.open(path);
  expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain(
    "companion_event_receipt",
  );
});
