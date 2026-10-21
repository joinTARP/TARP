import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createGameTools } from "@jointarp/core/node/agent/game-tools";
import { ChatService } from "@jointarp/core/node/game/chat-service";
import {
  gameDocumentViews,
  gameFolderIndex,
  readGamePath,
  updateGameDocument,
} from "@jointarp/core/node/sessions/game-state";
import { advanceLaunch, launchState } from "@jointarp/core/node/sessions/launch-store";
import {
  createSession,
  gameDirectoryForDatabase,
  openSessionDatabase,
  roomDirectory,
} from "@jointarp/core/node/sessions/session-store";
import { createTestModule, type TestComputedCharacter } from "@jointarp/module/testing/test-module";

test("模组选角与开场隔离秘密，主持可读取资料，字段揭示与结算持久化且失败不写入", async () => {
  const f = await createTestModule();
  const chat = new ChatService(f.sessions, { run: async () => {} }, async () => ({
    config: { provider: "test", model: "test" },
  }));
  try {
    const room = await createSession(f.sessions, f.modulePath, "平台集成验证");
    const player = { id: randomUUID(), nickname: "测试玩家" };
    const act = async (action: "select" | "confirm" | "beginAdventure", extra = {}) => {
      const state = (await launchState(f.sessions, room.id, player.id))!;
      return advanceLaunch(
        f.sessions,
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
    const initial = (await launchState(f.sessions, room.id, player.id))!;
    assert.equal(initial.progress.stage, "prelude");
    await assert.rejects(act("select", { characterId: initial.characters[0]?.id }), /序章/);
    const arrived = await chat.history({ roomId: room.id, limit: 100 }, player);
    const ready = arrived.messages.find(
      (message) => message.kind === "card" && message.card.type === "ready",
    );
    assert.ok(ready);
    await chat.confirmReady(room.id, player, ready.id);
    const told = await chat.history({ roomId: room.id, limit: 100 }, player);
    const characterIndex = told.messages.findIndex(
      (message) => message.kind === "card" && message.card.type === "character",
    );
    assert.ok(characterIndex > 0);
    const prelude = told.messages
      .slice(0, characterIndex)
      .filter((message) => message.kind === "scripted")
      .map((message) => message.text)
      .join("\n");
    assert.ok(prelude.includes("前置步骤测试文本。"));
    assert.ok(!prelude.includes("GM_ONLY_TEST_VALUE"));
    assert.deepEqual(
      (await chat.history({ roomId: room.id, limit: 100 }, player)).messages.map(
        (message) => message.id,
      ),
      told.messages.map((message) => message.id),
    );
    const selection = (await launchState(f.sessions, room.id, player.id))!;
    assert.ok(!JSON.stringify(selection.references).includes("GM_ONLY_TEST_VALUE"));
    assert.ok(
      selection.references.every(
        (document) => document.valid && !Object.hasOwn(document.values ?? {}, "gmText"),
      ),
    );
    const human = selection.characters.find((character) => character.name === "向导")!;
    assert.ok(human);
    await act("select", { characterId: human.id });
    await act("confirm");
    await act("beginAdventure");
    await chat.openLaunch(room.id, player);
    assert.equal((await launchState(f.sessions, room.id, player.id))!.room.opening, "complete");

    const characterPath = "角色/向导.json";
    let expectedAbilityCount = 0;
    const db = await openSessionDatabase(f.sessions, room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      const world = (await readGamePath(db, game, "世界状态/状态/当前世界")) as {
        content: { scenes: { location: string; members: string[] }[] };
      };
      assert.deepEqual(world.content.scenes, [], "平台不会自动创建场景或安排角色");
      assert.ok((await gameFolderIndex(game, db)).includes("测试约定"));
      const views = await gameDocumentViews(db, game);
      assert.ok(views.every((document) => document.valid));
      for (const view of views.filter((document) => document.docType === "事件")) {
        assert.equal(view.body ?? "", "");
        assert.deepEqual(view.values, { name: "测试事件", description: null, body: null });
      }
      assert.deepEqual(views.find((document) => document.docType === "人物")!.values, {});
      const secret = views.find((document) => document.path === "物品/密匣.json")!;
      assert.equal(secret.title, "未发现的物品");
      assert.deepEqual(secret.values, { name: "未发现的物品", description: null, body: null });
      const tools = await createGameTools(
        roomDirectory(f.sessions, room.id),
        new AbortController().signal,
      );
      const result = await tools
        .find((tool) => tool.name === "read")!
        .execute("scene", { path: "事件/到达" }, undefined, undefined, undefined as never);
      assert.match(
        JSON.parse((result.content[0] as { text: string }).text).content.gmText,
        /GM_ONLY_TEST_VALUE/,
      );
      await updateGameDocument(db, game, {
        path: secret.path,
        changes: [
          { op: "set", path: "/publicName", value: "更新后的公开名称" },
          { op: "set", path: "/publicText", value: "更新后的公开正文。" },
          { op: "set", path: "/discovered", value: true },
        ],
      });
      const visible = (await gameDocumentViews(db, game)).find(
        (document) => document.path === secret.path,
      )!;
      assert.equal(visible.title, "更新后的公开名称");
      assert.equal(visible.body, "更新后的公开正文。");
      assert.ok(!JSON.stringify(visible).includes("GM_ONLY_TEST_VALUE"));
      await updateGameDocument(db, game, {
        path: characterPath,
        changes: [
          { op: "set", path: "/hp", value: 9 },
          { op: "set", path: "/reserve", value: 2 },
          { op: "set", path: "/settlements", value: ["arrival:角色/向导"] },
        ],
      });
      const readCharacter = async () =>
        (await readGamePath(db, game, characterPath)) as {
          content: TestComputedCharacter;
          revision: number;
        };
      const stored = await readCharacter();
      await updateGameDocument(db, game, {
        path: characterPath,
        changes: [
          {
            op: "set",
            path: "/ability_records",
            value: [...stored.content.ability_records!, { document: "能力/修补", growth: 4 }],
          },
        ],
      });
      await assert.rejects(
        updateGameDocument(db, game, {
          path: characterPath,
          changes: [{ op: "set", path: "/abilities", value: [] }],
        }),
        /计算字段|不能修改|未标记为运行时可修改/,
      );
      const beforeSource = await readFile(join(game, characterPath), "utf8");
      const beforeInvalid = await readCharacter();
      await assert.rejects(
        updateGameDocument(db, game, {
          path: characterPath,
          changes: [
            {
              op: "set",
              path: "/ability_records",
              value: [
                ...beforeInvalid.content.ability_records!,
                beforeInvalid.content.ability_records![0],
              ],
            },
          ],
        }),
        /能力记录重复/,
      );
      assert.equal(await readFile(join(game, characterPath), "utf8"), beforeSource);
      const afterInvalid = await readCharacter();
      assert.equal(afterInvalid.revision, beforeInvalid.revision);
      assert.deepEqual(afterInvalid.content.abilities, beforeInvalid.content.abilities);
      const persisted = JSON.parse(await readFile(join(game, characterPath), "utf8"));
      assert.equal(Object.hasOwn(persisted.values, "abilities"), false);
      expectedAbilityCount = stored.content.ability_records!.length + 1;
      assert.equal(persisted.values.ability_records.length, expectedAbilityCount);
    } finally {
      db.close();
    }
    const reopened = await openSessionDatabase(f.sessions, room.id);
    try {
      const state = (await readGamePath(
        reopened,
        gameDirectoryForDatabase(reopened),
        characterPath,
      )) as { content: TestComputedCharacter };
      assert.equal(state.content.hp, 9);
      assert.equal(state.content.reserve, 2);
      assert.deepEqual(state.content.settlements, ["arrival:角色/向导"]);
      assert.equal(state.content.abilities.length, expectedAbilityCount);
      assert.equal(
        state.content.abilities.find((ability) => ability.document === "能力/修补")!.value,
        7,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await chat.close();
    await f.cleanup();
  }
});
