import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { createTestModule } from "@jointarp/module/testing/test-module";
import { ChatService } from "@tarp/core/node/game/chat-service";
import { advanceLaunch, launchState } from "@tarp/core/node/sessions/launch-store";
import { createSession } from "@tarp/core/node/sessions/session-store";

test("模组预设角色可作为 AI 队友入队，真人角色不可重复占用", async () => {
  const fixture = await createTestModule();
  const { sessions, modulePath } = fixture;
  const chat = new ChatService(sessions, { run: async () => {} }, async () => ({
    config: { provider: "test", model: "test" },
  }));
  const player = { id: randomUUID(), nickname: "测试玩家" };
  try {
    const room = await createSession(sessions, modulePath, "测试小队");
    const act = async (
      action: "next" | "start" | "select" | "confirm" | "beginAdventure",
      extra = {},
    ) => {
      const state = (await launchState(sessions, room.id, player.id))!;
      return advanceLaunch(
        sessions,
        {
          roomId: room.id,
          revision: state.progress.revision,
          roomRevision: state.room.revision,
          action,
          ...extra,
        },
        player.id,
      );
    };
    await act("next");
    await act("start", { startId: "arrival" });
    const launch = (await launchState(sessions, room.id, player.id))!;
    const human = launch.characters.find((item) => item.name === "向导")!;
    await act("select", { characterId: human.id });
    await act("confirm");
    await act("beginAdventure");
    await chat.openLaunch(room.id, player);

    const settings = await chat.companionSettings(room.id);
    assert.equal(settings.characters.length, 4);
    assert.ok(settings.characters.every((item) => item.playable && item.aiConfigured));
    const candidates = settings.characters.filter((item) => !item.controllerId && !item.reservedBy);
    assert.deepEqual(candidates.map((item) => item.name).sort(), ["工匠", "学者", "旅人"].sort());
    await assert.rejects(chat.selectCompanion(room.id, human.id), /占用/);

    const metadata = await loadModuleMetadata(modulePath);
    const presets = metadata.gameStarts![0].aiCompanions!;
    for (const candidate of candidates) {
      const selected = await chat.selectCompanion(room.id, candidate.id);
      const seat = selected.seats.find((item) => item.reservedCharacterId === candidate.id)!;
      const saved = await chat.saveCompanion(
        room.id,
        seat.id,
        { characterId: candidate.id },
        player,
      );
      const companion = saved.seats.find((item) => item.id === seat.id)!.companion!;
      assert.equal(companion.personality, presets[`角色/${candidate.name}`]);
      assert.equal(
        saved.characters.find((item) => item.id === candidate.id)!.controllerId,
        seat.id,
      );
      await assert.rejects(chat.selectCompanion(room.id, candidate.id), /占用/);
    }

    await chat.closeRoom(room.id);
    const restored = await chat.companionSettings(room.id);
    assert.equal(restored.seats.filter((item) => item.companion).length, 3);
    assert.ok(restored.characters.every((item) => item.aiConfigured));
  } finally {
    await chat.close();
    await fixture.cleanup();
  }
});
