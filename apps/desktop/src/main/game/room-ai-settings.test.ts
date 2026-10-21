import { it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ChatService } from "@jointarp/core/node/game/chat-service";
import { readRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import { createSession } from "@jointarp/core/node/sessions/session-store";
import { waitFor } from "@jointarp/module/testing/async";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";

import { LocalGameSettings } from "./local-settings";
import { RoomAiSettingsStore } from "./room-ai-settings";

it("房间独立选择并持久化模型，聊天使用各自模型，应用默认选择不影响房间", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-room-ai-"));
  let chat: ChatService | undefined;
  try {
    const module = join(root, "module");
    await mkdir(join(module, ".types"), { recursive: true });
    await writeFile(join(module, ".types", "规则.fields.json"), "{}");
    await writeFile(join(module, "规则/开始.md"), "冒险从这里开始");
    await writeFile(
      join(module, "module.json"),
      JSON.stringify({ name: "测试", description: "房间模型测试" }),
    );
    const sessions = join(root, "sessions");
    const a = await createSession(sessions, module, "房间 A");
    const b = await createSession(sessions, module, "房间 B");
    const settings = new LocalGameSettings(root);
    const models = builtinProviders()
      .find((provider) => provider.id === "openai")!
      .getModels();
    await settings.connect({ provider: "openai", custom: false, apiKey: "private-room-key" });
    const provider = "openai";
    const store = new RoomAiSettingsStore(sessions, settings);
    assert.deepEqual(await store.get(a.id), { selection: null, ready: false });
    await assert.rejects(store.credentials(a.id));
    await settings.setDefaultModel(provider, models[0].id, "low");
    const c = await createSession(sessions, module, "房间 C", await settings.defaults());
    assert.equal((await store.get(c.id)).selection?.model, models[0].id);
    assert.equal((await store.get(c.id)).ready, true);
    assert.equal((await store.credentials(c.id)).config.thinkingLevel, "low");
    assert.equal((await store.get(a.id)).selection, null);
    assert.equal((await new LocalGameSettings(root).get()).defaultModel?.model, models[0].id);
    await store.select(a.id, provider, models[0].id, "high");
    await store.select(b.id, provider, models[1].id);
    assert.equal((await store.credentials(a.id)).config.model, models[0].id);
    assert.equal((await store.credentials(b.id)).config.model, models[1].id);
    assert.equal(
      (await settings.get()).providers.filter((value) => value.id === "openai").length,
      1,
    );
    assert.deepEqual(await store.compaction(a.id), {
      host: { thresholdTokens: null },
      companion: { thresholdTokens: null },
    });
    await store.saveCompaction(a.id, "host", { thresholdTokens: 64000 });
    await store.saveCompaction(a.id, "companion", { thresholdTokens: 16000 });
    assert.equal((await store.compaction(b.id)).host.thresholdTokens, null);
    await assert.rejects(store.saveCompaction(a.id, "host", { thresholdTokens: -1 }));
    const reopened = new RoomAiSettingsStore(sessions, settings);
    assert.deepEqual(await reopened.compaction(a.id), {
      host: { thresholdTokens: 64000 },
      companion: { thresholdTokens: 16000 },
    });
    await reopened.saveCompaction(a.id, "host", { thresholdTokens: null });
    assert.deepEqual(await store.compaction(a.id), {
      host: { thresholdTokens: null },
      companion: { thresholdTokens: 16000 },
    });
    assert.equal((await reopened.get(b.id)).selection?.model, models[1].id);
    const stored = readRoomSettings(join(sessions, a.id));
    assert.equal(stored.ai?.model, models[0].id);
    assert.equal(stored.ai?.thinkingLevel, "high");
    assert.deepEqual(stored.compaction, {
      host: { thresholdTokens: null },
      companion: { thresholdTokens: 16000 },
    });
    await settings.setDefaultModel(provider, models[1].id);
    assert.equal((await store.credentials(a.id)).config.model, models[0].id);
    let failedOnce = false;
    const seen: { room: string; model: string }[] = [];
    chat = new ChatService(
      sessions,
      {
        run: async (args) => {
          if (args.inputBatch)
            args.onInputReceived?.({
              batchId: args.inputBatch.id,
              messageId: args.messageId,
              reference: { sessionId: randomUUID(), beforeEntryId: null, afterEntryId: "input" },
            });
          if (seen.length < 2)
            assert.equal(
              args.config.thinkingLevel,
              args.roomDirectory === join(sessions, a.id) ? "high" : undefined,
            );
          seen.push({ room: args.roomDirectory, model: args.config.model });
          if (args.roomDirectory === join(sessions, a.id) && !failedOnce) {
            failedOnce = true;
            throw new Error("模拟模型失败");
          }
        },
      },
      (roomId) => store.credentials(roomId),
    );
    const player = { id: randomUUID(), nickname: "玩家" };
    for (const roomId of [a.id, b.id])
      await chat.send(
        { roomId, clientMessageId: randomUUID(), text: "开始", chatOnly: false },
        player,
      );
    await waitFor(() =>
      assert.deepEqual(
        seen.map((item) => item.model),
        [models[0].id, models[1].id],
      ),
    );
    assert.equal(
      (await (await settings.modelRuntime()).getAuth("openai"))?.auth.apiKey,
      "private-room-key",
    );
    assert.ok(!JSON.stringify(await store.get(a.id)).includes("private-room-key"));
    assert.equal(
      (await readFile(join(sessions, a.id, "session.sqlite"))).includes(
        Buffer.from("private-room-key"),
      ),
      false,
    );
    await waitFor(async () => {
      const history = await chat!.history({ roomId: a.id, limit: 50 });
      assert.ok(history.messages.find((message) => message.status === "failed")?.id);
    });
    await store.select(a.id, provider, models[1].id);
    await chat.send(
      { roomId: a.id, clientMessageId: randomUUID(), text: "继续", chatOnly: false },
      player,
    );
    await waitFor(() =>
      assert.deepEqual(seen[2], { room: join(sessions, a.id), model: models[1].id }),
    );
    await settings.disconnect(provider);
    assert.equal((await settings.get()).defaultModel?.model, models[1].id);
    assert.equal((await store.get(a.id)).ready, false);
    assert.equal((await store.get(b.id)).selection?.model, models[1].id);
    await assert.rejects(store.credentials(a.id));
    await assert.rejects(store.select(b.id, provider, models[0].id));
  } finally {
    await chat?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("新冒险复制完整默认配置，按字段并发保存不丢值，失效服务引用仍保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-game-defaults-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const module = join(root, "module");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(join(module, ".types/规则.fields.json"), "{}");
  await writeFile(join(module, "规则/开始.md"), "默认配置测试");
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "测试", description: "快照" }),
  );
  const settings = new LocalGameSettings(root);
  const model = {
    provider: "missing",
    model: "test",
    name: "已失效模型",
    providerName: "测试服务",
  };
  await settings.updateDefaults({
    ai: model,
    contextSubscriptionsEnabled: true,
    hostSystemPrompt: "创建时的主持指令",
    companionRoleplayPrompt: "创建时的队友扮演指导",
    chat: { submissionMode: "manual", steeringEnabled: true },
    display: { showReasoning: true, showAllDocuments: true },
    compaction: { host: { thresholdTokens: 64000 }, companion: { thresholdTokens: 16000 } },
    tts: {
      enabled: false,
      automatic: true,
      config: { provider: "deleted", model: "voice-model", voice: "voice", instructions: "慢慢讲" },
    },
    companion: {
      model,
      initiative: { level: "custom", prompt: "先讨论，再行动。" },
      documentAccess: true,
      voice: { mode: "preset", voice: "苏打", instructions: "自然" },
    },
  });
  await Promise.all([
    settings.updateDefaults({ chat: { submissionMode: "auto" } }),
    settings.updateDefaults({ tts: { config: { instructions: "清晰讲述" } } }),
    settings.updateDefaults({ companion: { initiative: { level: "reserved" } } }),
  ]);
  const before = await settings.defaults();
  assert.deepEqual(before.ai, model);
  assert.equal(before.chat.steeringEnabled, true);
  assert.equal(before.tts.enabled, false);
  assert.equal(before.tts.automatic, true);
  assert.equal(before.tts.config.provider, "deleted");
  assert.equal(before.companion.initiative.prompt, "先讨论，再行动。");
  assert.equal(before.companion.documentAccess, true);
  assert.equal(before.contextSubscriptionsEnabled, true);
  const sessions = join(root, "sessions");
  const a = await createSession(sessions, module, "旧冒险", before);
  await settings.updateDefaults({
    ai: null,
    contextSubscriptionsEnabled: false,
    hostSystemPrompt: "新的指令",
    companionRoleplayPrompt: "新的队友扮演指导",
    chat: { steeringEnabled: false },
    tts: { automatic: false },
    companion: { model: null, documentAccess: false },
  });
  const b = await createSession(sessions, module, "新冒险", await settings.defaults());
  const snapshot = readRoomSettings(join(sessions, a.id));
  const { host, ...tts } = snapshot.tts;
  const { submissionModeRevision, ...chat } = snapshot.chat;
  assert.deepEqual({ ...snapshot, chat, tts }, before);
  assert.equal(submissionModeRevision, 0);
  assert.equal(host, null);
  assert.equal(readRoomSettings(join(sessions, b.id)).hostSystemPrompt, "新的指令");
  assert.equal(
    readRoomSettings(join(sessions, a.id)).companionRoleplayPrompt,
    "创建时的队友扮演指导",
  );
  assert.equal(readRoomSettings(join(sessions, b.id)).companionRoleplayPrompt, "新的队友扮演指导");
  assert.equal(
    (await new LocalGameSettings(root).defaults()).companionRoleplayPrompt,
    "新的队友扮演指导",
  );
  await settings.updateDefaults({ companionRoleplayPrompt: null });
  assert.equal((await new LocalGameSettings(root).defaults()).companionRoleplayPrompt, null);
  assert.equal(readRoomSettings(join(sessions, b.id)).companionRoleplayPrompt, "新的队友扮演指导");
  assert.equal(readRoomSettings(join(sessions, b.id)).ai, null);
  assert.equal(readRoomSettings(join(sessions, b.id)).companion.documentAccess, false);
  assert.equal(readRoomSettings(join(sessions, a.id)).companion.documentAccess, true);
  assert.equal(readRoomSettings(join(sessions, a.id)).contextSubscriptionsEnabled, true);
  assert.equal(readRoomSettings(join(sessions, b.id)).contextSubscriptionsEnabled, false);
  assert.equal((await new LocalGameSettings(root).defaults()).hostSystemPrompt, "新的指令");
  assert.ok(!(await readFile(join(sessions, a.id, "settings.json"), "utf8")).includes("apiKey"));
  const store = new RoomAiSettingsStore(sessions, settings);
  assert.deepEqual(await store.get(a.id), { selection: model, ready: false });
});
