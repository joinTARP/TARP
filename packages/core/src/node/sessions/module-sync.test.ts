import { test, onTestFinished, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { lstat, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@tarp/module/testing/files";
import { createTestModule } from "@tarp/module/testing/test-module";

import { readCharacters } from "./character-db";
import { updateGameDocument, readGameDocumentView, writeGameDocument } from "./game-state";
import {
  readModuleSource,
  bindModuleSource,
  checkModuleUpdate,
  syncModule,
  moduleFingerprint,
} from "./module-sync";
import { moduleSyncDirectory, moduleSyncJournal } from "./module-sync-recovery";
import { readAdventure, updateAdventure } from "./room-storage";
import {
  createSession,
  openSessionDatabase,
  loadSessionModuleResources,
  saveRoomNotes,
  setSessionStatus,
} from "./session-store";
import { withStateLock } from "./state-lock";

const characterPath = "角色/旅人.json";
async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("同步更新模组、公式、附件和角色索引，保留覆盖、归属、新增文档与笔记，并刷新已有连接", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "同步测试");
  const directory = join(f.sessions, room.id);
  assert.equal(await readModuleSource(f.sessions, room.id), f.modulePath);
  assert.equal((await checkModuleUpdate(f.sessions, room.id)).changed, false);
  const db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = join(directory, "game");
  const originalCharacters = readCharacters(db);
  const originalCharacter = originalCharacters.find(
    (character) => character.sourcePath === characterPath,
  )!;
  updateAdventure(directory, (adventure) => {
    adventure.party.characters.find(
      (character) => character.id === originalCharacter.id,
    )!.playerId = "同步玩家";
    adventure.party.companions.push({
      id: "同步队友",
      status: "reserved",
      characterId: originalCharacters.find((character) => character.id !== originalCharacter.id)!
        .id,
    });
    adventure.launch.state = {
      revision: 5,
      startId: "arrival",
      locked: true,
      opening: "complete",
      intro: "told",
    };
    adventure.launch.players["同步玩家"] = {
      revision: 3,
      stage: "opening",
      prelude: { path: ["intro"], answers: {}, done: true },
      characterId: originalCharacter.id,
      confirmed: true,
    };
    return adventure;
  });
  const beforeProgress = readAdventure(directory);
  const beforeSettings = await readFile(join(directory, "settings.json"), "utf8");
  await saveRoomNotes(f.sessions, room.id, "同步玩家", "保留笔记");
  await updateGameDocument(db, game, {
    path: characterPath,
    changes: [{ op: "set", path: "/hp", value: 3 }],
  });
  await writeGameDocument(db, game, {
    path: "规则/记录.json",
    content: { name: "本局记录", body: "保留新文档" },
  });
  const before = await loadSessionModuleResources(f.sessions, room.id);
  await readGameDocumentView(db, game, characterPath, true);
  const source = await readJson(join(f.modulePath, characterPath));
  source.name = "新版旅人";
  source.hp = 20;
  source.reserve = 9;
  await writeFile(join(f.modulePath, characterPath), JSON.stringify(source));
  await writeFile(
    join(f.modulePath, "角色/新增旅人.json"),
    JSON.stringify({ ...source, name: "新增旅人" }),
  );
  const typePath = join(f.modulePath, ".types/角色.fields.json");
  const type = await readJson(typePath);
  type.fields.capacity.compute = "$self.stats.vigor + 100";
  await writeFile(typePath, JSON.stringify(type));
  await writeFile(join(f.modulePath, "更新.png"), "新图片");
  const metadataPath = join(f.modulePath, "module.json");
  const metadata = await readJson(metadataPath);
  metadata.name = "同步后的模组";
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal((await checkModuleUpdate(f.sessions, room.id)).changed, true);
  assert.deepEqual(await syncModule(f.sessions, room.id), { changed: true });
  const current = await readGameDocumentView(db, game, characterPath, true);
  assert.equal(current.title, "新版旅人");
  assert.equal(current.values?.hp, 3);
  assert.equal(current.values?.reserve, 9);
  assert.equal(current.values?.capacity, source.stats.vigor + 100);
  assert.equal((await readGameDocumentView(db, game, "规则/记录.json", true)).body, "保留新文档");
  const afterCharacters = readCharacters(db);
  assert.equal(
    afterCharacters.find((character) => character.sourcePath === characterPath)!.id,
    originalCharacter.id,
  );
  assert.equal(
    afterCharacters.find((character) => character.sourcePath === characterPath)!.playerId,
    "同步玩家",
  );
  assert.equal(afterCharacters.length, originalCharacters.length + 1);
  const adventure = readAdventure(directory);
  assert.equal(adventure.notes["同步玩家"], "保留笔记");
  assert.equal(adventure.room.moduleName, "同步后的模组");
  assert.deepEqual(adventure.launch, beforeProgress.launch);
  assert.deepEqual(adventure.party.companions, beforeProgress.party.companions);
  assert.equal(await readFile(join(directory, "settings.json"), "utf8"), beforeSettings);
  assert.notEqual(
    (await loadSessionModuleResources(f.sessions, room.id)).baseline.version,
    before.baseline.version,
  );
  assert.equal(await readFile(join(directory, "module/更新.png"), "utf8"), "新图片");
  assert.equal((await checkModuleUpdate(f.sessions, room.id)).changed, false);
  assert.deepEqual(await syncModule(f.sessions, room.id), { changed: false });
});

for (const scenario of [
  "权限改变",
  "删除角色",
  "公式错误",
  "引用错误",
  "新增文档冲突",
  "缺少类型",
  "开局方案改变",
] as const)
  test(`拒绝不兼容更新并保留整个存档：${scenario}`, async () => {
    const f = await createTestModule();
    onTestFinished(f.cleanup);
    const room = await createSession(f.sessions, f.modulePath, "失败同步");
    const directory = join(f.sessions, room.id);
    const game = join(directory, "game");
    const db = await openSessionDatabase(f.sessions, room.id);
    onTestFinished(() => db.close());
    await updateGameDocument(db, game, {
      path: characterPath,
      changes: [{ op: "set", path: "/hp", value: 3 }],
    });
    const beforeVersion = await moduleFingerprint(join(directory, "module"));
    if (scenario === "权限改变" || scenario === "公式错误") {
      const path = join(f.modulePath, ".types/角色.fields.json");
      const type = await readJson(path);
      if (scenario === "权限改变") type.fields.hp.mutable = false;
      else type.fields.capacity.compute = "(() => { throw new Error('故意失败'); })()";
      await writeFile(path, JSON.stringify(type));
    } else if (scenario === "删除角色") await rm(join(f.modulePath, characterPath));
    else if (scenario === "缺少类型") {
      await writeGameDocument(db, game, { path: "规则/新增.json", content: { body: "本局文档" } });
      await rm(join(f.modulePath, ".types/规则.fields.json"));
    } else if (scenario === "新增文档冲突") {
      await writeGameDocument(db, game, { path: "规则/新增.json", content: { body: "本局文档" } });
      await writeFile(join(f.modulePath, "规则/新增.json"), JSON.stringify({ body: "模组文档" }));
    } else if (scenario === "开局方案改变") {
      updateAdventure(directory, (adventure) => {
        adventure.launch.state!.startId = "arrival";
        return adventure;
      });
      const path = join(f.modulePath, "module.json");
      const metadata = await readJson(path);
      metadata.gameStarts[0].id = "another";
      await writeFile(path, JSON.stringify(metadata));
    } else {
      const path = join(f.modulePath, characterPath);
      const character = await readJson(path);
      character.ability_records = [{ document: "能力/不存在", bonus: 1 }];
      await writeFile(path, JSON.stringify(character));
    }
    const beforeAdventure = await readFile(join(directory, "adventure.json"), "utf8");
    const beforeGame = await readFile(join(game, characterPath), "utf8");
    await assert.rejects(syncModule(f.sessions, room.id));
    assert.equal(await moduleFingerprint(join(directory, "module")), beforeVersion);
    assert.equal(await readFile(join(directory, "adventure.json"), "utf8"), beforeAdventure);
    assert.equal(await readFile(join(game, characterPath), "utf8"), beforeGame);
    assert.equal((await readGameDocumentView(db, game, characterPath, true)).values?.hp, 3);
    if (scenario === "开局方案改变") {
      const path = join(f.modulePath, "module.json");
      const metadata = await readJson(path);
      metadata.gameStarts[0].id = "arrival";
      metadata.name = "修复后的模组";
      await writeFile(path, JSON.stringify(metadata));
      assert.deepEqual(await syncModule(f.sessions, room.id), { changed: true });
      assert.equal(readAdventure(directory).room.moduleName, "修复后的模组");
    }
  });

test("已有游戏首次绑定、来源失效与结束状态均有明确反馈；附件变化能检测", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "来源测试");
  const directory = join(f.sessions, room.id);
  await rm(join(directory, "module-source.json"));
  assert.equal(await readModuleSource(f.sessions, room.id), null);
  await assert.rejects(checkModuleUpdate(f.sessions, room.id), /选择模组来源/);
  await bindModuleSource(f.sessions, room.id, f.modulePath);
  assert.equal((await checkModuleUpdate(f.sessions, room.id)).changed, false);
  await writeFile(join(f.modulePath, "新增.png"), "图片");
  assert.equal((await checkModuleUpdate(f.sessions, room.id)).changed, true);
  await setSessionStatus(f.sessions, room.id, "ended");
  await assert.rejects(syncModule(f.sessions, room.id), /重新开启/);
  await rename(f.modulePath, join(f.root, "moved"));
  await assert.rejects(checkModuleUpdate(f.sessions, room.id), /模组目录不存在/);
});

test("发布中途失败恢复原模组、角色记录和引用索引", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "发布恢复");
  const directory = join(f.sessions, room.id);
  const before = await readFile(join(directory, "adventure.json"), "utf8");
  const fingerprint = await moduleFingerprint(join(directory, "module"));
  const index = await readFile(join(directory, "document-references.json"), "utf8");
  await writeFile(join(f.modulePath, "新附件.png"), "新内容");
  const original = fs.renameSync;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from).endsWith("next-adventure.json")) throw new Error("模拟文件发布失败");
    return original(from, to);
  });
  try {
    await assert.rejects(syncModule(f.sessions, room.id), /已恢复原存档/);
  } finally {
    failure.mockRestore();
  }
  assert.equal(await moduleFingerprint(join(directory, "module")), fingerprint);
  assert.equal(await readFile(join(directory, "adventure.json"), "utf8"), before);
  assert.equal(await readFile(join(directory, "document-references.json"), "utf8"), index);
  assert.equal(fs.existsSync(moduleSyncJournal(directory)), false);
});

for (const phase of ["prepared", "committed"] as const)
  test(`重新打开恢复发布中断：${phase}`, async () => {
    const f = await createTestModule();
    onTestFinished(f.cleanup);
    const room = await createSession(f.sessions, f.modulePath, "中断恢复");
    const directory = join(f.sessions, room.id);
    const transaction = moduleSyncDirectory(directory);
    const original = await readFile(join(directory, "adventure.json"), "utf8");
    await mkdir(transaction);
    await writeFile(join(transaction, "previous-adventure.json"), original);
    await writeFile(
      join(transaction, "previous-document-references.json"),
      await readFile(join(directory, "document-references.json")),
    );
    await rename(join(directory, "module"), join(transaction, "previous-module"));
    await mkdir(join(directory, "module"));
    const { copyModule } = await import("./module-copy");
    await copyModule(join(transaction, "previous-module"), join(directory, "module"));
    await writeFile(join(directory, "module/新附件.png"), "新版本");
    updateAdventure(directory, (adventure) => {
      adventure.room.moduleName = "新版本";
      return adventure;
    });
    await writeFile(moduleSyncJournal(directory), JSON.stringify({ phase, hadIndex: true }));
    const db = await openSessionDatabase(f.sessions, room.id);
    db.close();
    assert.equal(
      readAdventure(directory).room.moduleName,
      phase === "prepared" ? room.moduleName : "新版本",
    );
    assert.equal(fs.existsSync(join(directory, "module/新附件.png")), phase === "committed");
    assert.equal(fs.existsSync(transaction), false);
    assert.equal(fs.existsSync(moduleSyncJournal(directory)), false);
  });

test("等待已有文档提交后再同步，保留最新覆盖", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "并发同步");
  const directory = join(f.sessions, room.id);
  const db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = join(directory, "game");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = withStateLock(game, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await updateGameDocument(db, game, {
      path: characterPath,
      changes: [{ op: "set", path: "/hp", value: 2 }],
    });
  });
  await ready;
  await writeFile(join(f.modulePath, "新附件.png"), "更新");
  const syncing = syncModule(f.sessions, room.id);
  release();
  await held;
  await syncing;
  assert.equal((await readGameDocumentView(db, game, characterPath, true)).values?.hp, 2);
});

test("工作区链接不能在同步时被静默丢弃", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "链接检查");
  const directory = join(f.sessions, room.id);
  await mkdir(join(directory, "game/角色"), { recursive: true });
  await symlink(join(f.modulePath, characterPath), join(directory, "game/角色/链接.json"));
  await writeFile(join(f.modulePath, "新附件.png"), "更新");
  await assert.rejects(syncModule(f.sessions, room.id), /只允许普通文件/);
  assert.ok((await lstat(join(directory, "game/角色/链接.json"))).isSymbolicLink());
});

test("同步校验未落盘角色草稿的引用，不发布无效候选", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "草稿引用");
  const directory = join(f.sessions, room.id);
  const { name, ...values } = await readJson(join(f.modulePath, characterPath));
  values.ability_records = [{ document: "能力/不存在", bonus: 1 }];
  updateAdventure(directory, (adventure) => {
    adventure.party.characters.push({
      id: "未落盘角色",
      typeId: "角色",
      playerId: null,
      retired: false,
      sourcePath: null,
      draft: { name, description: "", values },
    });
    return adventure;
  });
  await writeFile(join(f.modulePath, "新附件.png"), "更新");
  const before = await moduleFingerprint(join(directory, "module"));
  await assert.rejects(syncModule(f.sessions, room.id));
  assert.equal(await moduleFingerprint(join(directory, "module")), before);
  assert.equal(readAdventure(directory).party.characters.at(-1)!.sourcePath, null);
});
