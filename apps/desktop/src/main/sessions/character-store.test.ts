import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { readAdventureState } from "@tarp/core/node/sessions/adventure-state";
import { readCharacters } from "@tarp/core/node/sessions/character-db";
import {
  characterSnapshot,
  characterViews,
  validateCharacterDraft,
  withCharacters,
} from "@tarp/core/node/sessions/character-store";
import { publicGameDocuments } from "@tarp/core/node/sessions/game-state";
import { createSession } from "@tarp/core/node/sessions/session-store";

import { documentMediaUrl } from "../../shared/document-media";
import { resolveMediaRequestFile } from "../media-path";
import { registerRoomMedia } from "./local-room-resources";

async function fixture(options: { randomField?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tarp-characters-"));
  const module = join(root, "module"),
    sessions = join(root, "sessions");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(
    join(module, ".types", "人物.fields.json"),
    JSON.stringify({
      designation: "character",
      fields: {
        hp: { type: "number", required: true, mutable: true },
        status: { type: "text", compute: "$self.hp > 0 ? '行动' : '倒下'" },
        ...(options.randomField ? { sample: { type: "number", compute: "Math.random()" } } : {}),
        secret: { type: "text", visibility: "gm", mutable: true },
        details: {
          type: "object",
          fields: { public: { type: "text" }, secret: { type: "text", visibility: "gm" } },
        },
      },
    }),
  );
  await writeFile(
    join(module, "人物/向导.json"),
    JSON.stringify({
      name: "向导",
      hp: 8,
      secret: "幕后",
      image: "向导.webp",
      avatar: "向导头像.webp",
      details: { public: "可见", secret: "隐藏" },
    }),
  );
  await writeFile(join(module, "向导.webp"), "image fixture");
  await writeFile(join(module, "向导头像.webp"), "avatar fixture");
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({
      name: "测试模组",
      description: "角色流程",
    }),
  );
  const room = await createSession(sessions, module, "角色测试");
  return { root, module, sessions, roomId: room.id, playerId: randomUUID() };
}
test("选角角色与引用共用一次计算，草稿不进入引用，公开投影继续遮蔽秘密", async () => {
  const f = await fixture({ randomField: true });
  try {
    await withCharacters(f.sessions, f.roomId, async (db) => {
      const original = readCharacters(db)[0];
      const snapshot = await characterSnapshot(db, {
        ...original,
        id: "draft",
        sourcePath: null,
        values: { ...original.values, hp: 0 },
      });
      const character = snapshot.characters.find((item) => item.id === original.id)!;
      const document = snapshot.documents.find((item) => item.path === original.sourcePath)!;
      assert.equal(character.values.sample, document.values?.sample);
      assert.equal(character.values.secret, "幕后");
      const draft = snapshot.characters.find((item) => item.id === "draft")!;
      assert.equal(draft.values.status, "倒下");
      assert.equal(character.values.status, "行动");
      assert.equal(snapshot.documents.length, 1);
      const references = await publicGameDocuments(db, snapshot.documents);
      assert.equal(references[0].values?.sample, character.values.sample);
      assert.equal(references[0].values?.secret, undefined);
      assert.equal(references[0].values?.status, "行动");
      assert.deepEqual(references[0].values?.details, { public: "可见" });
      assert.throws(
        () =>
          validateCharacterDraft(db, {
            typeId: "人物",
            name: "测试",
            description: "",
            values: { hp: 6, secret: "修改" },
          }),
        /不能填写字段：secret/,
      );
      assert.equal(readCharacters(db)[0].values.hp, 8);
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("角色视图读取磁盘覆盖和旁置图片，删除源模组后仍可读取且不暴露本机路径", async () => {
  const f = await fixture();
  try {
    await rm(f.module, { recursive: true, force: true });
    await withCharacters(f.sessions, f.roomId, (db) => {
      const row = readAdventureState(db).party.characters[0];
      assert.equal(row.sourcePath, "人物/向导.json");
      assert.deepEqual(Object.keys(row).sort(), [
        "id",
        "playerId",
        "retired",
        "sourcePath",
        "typeId",
      ]);
    });
    await writeFile(
      join(f.sessions, f.roomId, "game", "人物/向导.json"),
      JSON.stringify({ $overlay: 1, values: { hp: 5, secret: "新秘密" }, removed: [] }),
    );
    const character = (await withCharacters(f.sessions, f.roomId, characterViews))[0];
    assert.equal(character.name, "向导");
    assert.equal(character.values.hp, 5);
    assert.equal(character.values.secret, "新秘密");
    assert.equal(character.image, "向导.webp");
    registerRoomMedia(f.sessions, f.roomId);
    const imageFile = await resolveMediaRequestFile(
      documentMediaUrl(`room:${f.roomId}`, character.sourcePath!, character.image)!,
    );
    assert.equal(imageFile, await realpath(join(f.sessions, f.roomId, "module", "向导.webp")));
    assert.equal(character.avatar, "向导头像.webp");
    assert.equal(character.values.avatar, undefined);
    await access(imageFile!);
    assert.equal(JSON.stringify(character).includes(f.root), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("原始角色快照保留磁盘属性与身份且不执行公式", async () => {
  const f = await fixture({ randomField: true });
  try {
    await writeFile(
      join(f.sessions, f.roomId, "game", "人物/向导.json"),
      JSON.stringify({ $overlay: 1, values: { hp: 3 }, removed: [] }),
    );
    await withCharacters(f.sessions, f.roomId, async (db) => {
      const original = readCharacters(db)[0]!;
      const snapshot = await characterSnapshot(db, undefined, { raw: true });
      const character = snapshot.characters[0]!;
      assert.equal(character.id, original.id);
      assert.equal(character.sourcePath, original.sourcePath);
      assert.equal(character.playerId, original.playerId);
      assert.equal(character.values.hp, 3);
      assert.equal(character.values.status, undefined);
      assert.equal(character.values.sample, undefined);
      assert.equal(snapshot.documents[0]?.values?.hp, 3);
      assert.equal(snapshot.documents[0]?.values?.sample, undefined);
      assert.deepEqual(
        (await characterSnapshot(db, undefined, { requestedIds: [] })).characters,
        [],
      );
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
