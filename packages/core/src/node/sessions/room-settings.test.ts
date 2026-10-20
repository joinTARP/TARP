import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { companionRoleplayInstructions } from "../../shared/companion-roleplay";
import { roomConfiguration } from "../../shared/game-defaults";
import { defaultHostSystemPrompt } from "../../shared/host-system-prompt";
import {
  initializeRoomSettings,
  readRoomSettings,
  updateRoomSettings,
  patchRoomSettings,
} from "./room-settings";
import { initializeAdventure, readAdventure, updateAdventure } from "./room-storage";

test("冒险使用 JSON，空值往返、人工修改及不同设置连续保存不丢失", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-settings-"));
  try {
    initializeRoomSettings(root);
    initializeAdventure(root, {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "测试冒险",
      moduleName: "测试",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(readRoomSettings(root).ai, null);
    assert.equal(readRoomSettings(root).tts.enabled, true);
    assert.equal(readRoomSettings(root).chat.submissionMode, "auto");
    assert.equal(readRoomSettings(root).chat.submissionModeRevision, 0);
    updateRoomSettings(root, (settings) => ({
      ...settings,
      chat: {
        ...settings.chat,
        submissionMode: "manual",
        steeringEnabled: false,
        mentionReplyLimit: 8,
      },
    }));
    assert.equal(readRoomSettings(root).chat.submissionModeRevision, 1);
    patchRoomSettings(root, { chat: { submissionMode: "manual", steeringEnabled: true } });
    assert.equal(readRoomSettings(root).chat.submissionModeRevision, 1);
    updateRoomSettings(root, (settings) => ({
      ...settings,
      ai: {
        provider: "openai-codex",
        model: "test",
        name: "测试",
        providerName: "订阅",
      },
    }));
    updateRoomSettings(root, (settings) => ({
      ...settings,
      compaction: { ...settings.compaction, host: { thresholdTokens: 64000 } },
    }));
    updateRoomSettings(root, (settings) => ({
      ...settings,
      display: { ...settings.display, showReasoning: true },
    }));
    const path = join(root, "settings.json");
    const source = await readFile(path, "utf8");
    assert.ok(source.includes("null"));
    assert.equal(readRoomSettings(root).ai?.provider, "openai-codex");
    assert.equal(readRoomSettings(root).display.showReasoning, true);
    assert.equal(readRoomSettings(root).chat.submissionMode, "manual");
    assert.equal(readRoomSettings(root).chat.submissionModeRevision, 1);
    patchRoomSettings(root, { chat: { submissionMode: "auto" } });
    assert.deepEqual(readRoomSettings(root).chat, {
      submissionMode: "auto",
      submissionModeRevision: 2,
      steeringEnabled: true,
      mentionReplyLimit: 8,
    });
    assert.equal(readRoomSettings(root).compaction.host.thresholdTokens, 64000);
    await writeFile(path, source.replace("64000", "32000"));
    assert.equal(readRoomSettings(root).compaction.host.thresholdTokens, 32000);
    updateRoomSettings(root, (settings) => ({
      ...settings,
      compaction: { ...settings.compaction, host: { thresholdTokens: null } },
    }));
    assert.equal(readRoomSettings(root).compaction.host.thresholdTokens, null);
    const hostVoice = { mode: "preset" as const, voice: "苏打" as const, instructions: "自然" };
    updateRoomSettings(root, (settings) => ({
      ...settings,
      hostSystemPrompt: "本局指令",
      companionRoleplayPrompt: "本局以角色台词为主。",
      tts: { ...settings.tts, host: hostVoice },
    }));
    const beforePatch = readRoomSettings(root);
    patchRoomSettings(root, { tts: { config: { instructions: "清晰讲述" } } });
    const patched = readRoomSettings(root);
    assert.deepEqual(patched.tts, {
      ...beforePatch.tts,
      config: { ...beforePatch.tts.config, instructions: "清晰讲述" },
    });
    assert.equal(patched.hostSystemPrompt, "本局指令");
    assert.equal(patched.companionRoleplayPrompt, "本局以角色台词为主。");
    assert.deepEqual(patched.chat, beforePatch.chat);
    const configuration = roomConfiguration(patched);
    assert.ok(!("host" in configuration.tts));
    assert.ok(!("submissionModeRevision" in configuration.chat));
    assert.equal(configuration.tts.config.instructions, "清晰讲述");
    patchRoomSettings(root, { hostSystemPrompt: null });
    assert.equal(readRoomSettings(root).hostSystemPrompt, defaultHostSystemPrompt);
    assert.deepEqual(readRoomSettings(root).tts.host, hostVoice);
    patchRoomSettings(root, { companionRoleplayPrompt: null });
    assert.equal(readRoomSettings(root).companionRoleplayPrompt, companionRoleplayInstructions);
    assert.throws(() => patchRoomSettings(root, { companionRoleplayPrompt: "   " }));
    assert.equal(readRoomSettings(root).companionRoleplayPrompt, companionRoleplayInstructions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("设置与进度独立读写，拒绝缺失、损坏和链接文件且不覆盖原文", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-settings-"));
  try {
    assert.throws(() => readRoomSettings(root), { code: "ENOENT" });
    assert.throws(() => updateRoomSettings(root, (settings) => settings), { code: "ENOENT" });
    initializeRoomSettings(root);
    initializeAdventure(root, {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "测试冒险",
      moduleName: "测试",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const settingsPath = join(root, "settings.json");
    const adventurePath = join(root, "adventure.json");
    const originalAdventure = await readFile(adventurePath, "utf8");
    for (const damaged of ["", "{", '{"chat":{"submissionMode":"bad"}}', '{"extra":true}']) {
      await writeFile(settingsPath, damaged);
      assert.throws(() => readRoomSettings(root));
      assert.throws(() => updateRoomSettings(root, (settings) => settings));
      assert.equal(await readFile(settingsPath, "utf8"), damaged);
      assert.equal(readAdventure(root).room.name, "测试冒险");
      updateAdventure(root, (current) => ({ ...current, notes: { player: "可独立保存" } }));
      assert.equal(readAdventure(root).notes.player, "可独立保存");
    }
    initializeRoomSettings(root);
    const settings = readRoomSettings(root);
    await writeFile(adventurePath, '{"room":"损坏"}');
    assert.throws(() => readAdventure(root));
    updateRoomSettings(root, (current) => ({
      ...current,
      chat: {
        ...current.chat,
        submissionMode: "manual",
        steeringEnabled: false,
        mentionReplyLimit: 8,
      },
    }));
    assert.equal(readRoomSettings(root).chat.submissionMode, "manual");
    assert.equal(await readFile(adventurePath, "utf8"), '{"room":"损坏"}');
    // 设置文件不能借助符号链接改写冒险。
    await writeFile(adventurePath, originalAdventure);
    await rm(settingsPath);
    await symlink(adventurePath, settingsPath);
    assert.throws(() => readRoomSettings(root), /路径/);
    assert.throws(() => updateRoomSettings(root, () => settings), /路径/);
    assert.equal(await readFile(adventurePath, "utf8"), originalAdventure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
