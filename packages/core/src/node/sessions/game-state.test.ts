import { describe, test, onTestFinished, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stringifyConfig } from "@tarp/module/node/config-file";
import { validateModule } from "@tarp/module/node/validate-module";
import { writeTestFile as writeFile } from "@tarp/module/testing/files";
import { createTestModule } from "@tarp/module/testing/test-module";
import { createWorldStateDefinition } from "@tarp/module/testing/world-state";

import { createCompanionDocumentTools } from "../agent/companion-document-tools";
import { ContextSubscriptions } from "../agent/context-subscriptions";
import { createGameTools } from "../agent/game-tools";
import * as atomicFiles from "../storage/write-file-atomic";
import { forgetFrozenModule } from "./frozen-module";
import { readStateDocument } from "./game-state";
import {
  batchUpdateGameDocuments,
  forgetGameDocumentViews,
  gameFolderIndex,
  readGameDocumentView,
  readGamePath,
  stateRevision,
  readGameDocumentSnapshot,
  updateGameDocument,
  writeGameDocument,
  type GameDocumentUpdate,
} from "./game-state";
import { roomDisplaySettings } from "./room-display-settings";
import { patchRoomSettings } from "./room-settings";
import { readAdventure } from "./room-storage";
import {
  createSession,
  gameDirectoryForDatabase,
  loadSession,
  openSessionDatabase,
  roomDirectory,
} from "./session-store";
import { forgetStateVersions } from "./state-version";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-state-"));
  const module = join(root, "module");
  const sessions = join(root, "sessions");
  await mkdir(join(module, ".types"), { recursive: true });
  await mkdir(join(module, "Campaign", "State"), { recursive: true });
  await mkdir(join(module, "物品"), { recursive: true });
  await writeFile(
    join(module, ".types", "世界.fields.json"),
    JSON.stringify({
      designation: "world_state",
      fields: {
        weather: { type: "text", required: true, mutable: true },
        supplies: { type: "number" },
        position: {
          type: "object",
          fields: {
            x: { type: "number", required: true, mutable: true },
            label: { type: "text" },
          },
        },
      },
    }),
  );
  await writeFile(
    join(module, ".types", "物品.fields.json"),
    JSON.stringify({
      fields: { quantity: { type: "number", required: true, mutable: true } },
    }),
  );
  await writeFile(
    join(module, ".types", "规则.fields.json"),
    JSON.stringify({
      name: "核心规则",
      description: "检定与行动裁定依据",
    }),
  );
  await writeFile(
    join(module, "世界/当前世界.json"),
    JSON.stringify({
      name: "当前世界",
      weather: "晴",
      supplies: 3,
      position: { x: 0, label: "营地" },
    }),
  );
  await writeFile(join(module, "物品/火把.json"), JSON.stringify({ quantity: 1 }));
  await writeFile(join(module, "规则/玩法.md"), "# 玩法\n\n保持火把明亮。\n");
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "测试模组", description: "状态测试" }),
  );
  const room = await createSession(sessions, module, "状态测试");
  return { root, module, sessions, room };
}

test("字段定义按需读取保留父级权限与实例绑定，JSON 和 TOML 返回同一结构", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const definition = {
    description: "无关类型说明",
    fields: {
      quantity: { type: "number", mutable: true },
      type: { type: "text", mutable: false },
      bag: {
        type: "list",
        mutable: false,
        visibility: "gm",
        item: {
          type: "object",
          instance: { referenceField: "ref", stateField: "state" },
          fields: {
            ref: { type: "reference", targets: ["物品"], required: true },
            note: { type: "text" },
          },
        },
      },
    },
  };
  for (const extension of ["json", "toml"]) {
    await rm(join(f.module, ".types/物品.fields.json"), { force: true });
    const path = `.types/物品.fields.${extension}`;
    await writeFile(join(f.module, path), stringifyConfig(definition, path));
    const room = await createSession(f.sessions, f.module, `定义读取 ${extension}`);
    const db = await openSessionDatabase(f.sessions, room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      // 建局会把 TOML 编译为 JSON；在独立测试覆盖层保留 TOML，验证读取器的两种格式。
      if (extension === "toml") {
        await mkdir(join(game, ".types"), { recursive: true });
        await writeFile(join(game, path), stringifyConfig(definition, path));
      }
      assert.deepEqual(await readGamePath(db, game, path), {
        path: `/${path}`,
        readonly: true,
        content: definition,
      });
      assert.deepEqual(await readGamePath(db, game, path, ["/fields/bag/item/fields/ref"]), {
        path: `/${path}`,
        readonly: true,
        content: { "/fields/bag/item/fields/ref": definition.fields.bag.item.fields.ref },
        constraints: {
          "/fields/bag": { type: "list", mutable: false, visibility: "gm" },
          "/fields/bag/item": {
            type: "object",
            instance: { referenceField: "ref", stateField: "state" },
          },
        },
      });
      assert.deepEqual(await readGamePath(db, game, path, ["/fields/type/type"]), {
        path: `/${path}`,
        readonly: true,
        content: { "/fields/type/type": "text" },
        constraints: { "/fields/type": definition.fields.type },
      });
      await assert.rejects(readGamePath(db, game, path, ["/fields/missing"]), /字段不存在/);
      await assert.rejects(readGamePath(db, game, path, ["/fields/~2"]), /JSON Pointer/);
      await assert.rejects(readGamePath(db, game, path, []), /1 到 100/);
      await assert.rejects(readGamePath(db, game, "module.json", ["/name"]), /只能查阅/);
    } finally {
      db.close();
    }
  }
});

test("上下文订阅按字段保存、读取最新值，关闭、失效和取消不注入旧内容", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const room = join(f.sessions, f.room.id);
  const subscriptions = new ContextSubscriptions(room, new AbortController().signal);
  const document = "世界/当前世界";
  assert.equal(await subscriptions.prompt(), "");
  await assert.rejects(
    subscriptions.execute({ action: "set", document, fields: ["/weather"] }),
    /未开启/,
  );
  patchRoomSettings(room, { contextSubscriptionsEnabled: true });
  const tool = subscriptions.tool();
  const result = await tool.execute(
    "subscribe",
    { action: "set", document, fields: ["/weather", "/position/x"] },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(result.content[0].type, "text");
  assert.match(JSON.stringify(result.content), /晴/);
  assert.doesNotMatch(await subscriptions.prompt(), /supplies|营地/);
  const db = await openSessionDatabase(f.sessions, f.room.id);
  try {
    await updateGameDocument(db, gameDirectoryForDatabase(db), {
      path: document,
      changes: [{ op: "set", path: "/weather", value: "雨" }],
    });
    const restored = new ContextSubscriptions(room, new AbortController().signal);
    assert.match(await restored.prompt(), /雨/);
    assert.doesNotMatch(await restored.prompt(), /晴/);
    await restored.execute({
      action: "set",
      document: `/${document}.json`,
      fields: ["/position/x"],
    });
    assert.equal(readAdventure(room).contextSubscriptions.host.length, 1);
    assert.doesNotMatch(await restored.prompt(), /weather/);
    await assert.rejects(
      restored.execute({ action: "set", document, fields: ["/missing"] }),
      /字段不存在/,
    );
    await assert.rejects(restored.execute({ action: "set", document, fields: ["/position/~2"] }));
    await assert.rejects(
      restored.execute({ action: "set", document: ".types/世界.fields.json", fields: ["/fields"] }),
    );
    await assert.rejects(
      restored.execute({ action: "set", document: "../settings.json", fields: ["/ai"] }),
    );
    patchRoomSettings(room, { contextSubscriptionsEnabled: false });
    assert.equal(await restored.prompt(), "");
    await assert.rejects(restored.execute({ action: "list" }), /未开启/);
    patchRoomSettings(room, { contextSubscriptionsEnabled: true });
    assert.match(await restored.prompt(), /position/);
    await restored.execute({ action: "remove", document });
    assert.equal(await restored.prompt(), "");
    await restored.execute({ action: "set", document: "物品/火把", fields: ["/quantity"] });
    await rm(join(room, "module", "物品/火把.json"));
    const missing = await restored.prompt();
    assert.match(missing, /订阅暂不可用/);
    assert.doesNotMatch(missing, /"content"/);
    await restored.execute({ action: "clear" });
    assert.equal(await restored.prompt(), "");
  } finally {
    db.close();
  }
});

async function batchFixture() {
  const f = await fixture();
  await writeFile(
    join(f.module, ".types/集合.fields.json"),
    JSON.stringify({
      fields: {
        target: { type: "reference", targets: ["物品"], mutable: true },
        total: {
          type: "number",
          compute:
            "load($self.target).quantity >= 0 ? load($self.target).quantity : (() => { throw new Error('数量不能为负'); })()",
        },
        items: { type: "list", mutable: true, item: { type: "text" } },
        fixed: {
          type: "list",
          item: {
            type: "object",
            fields: {
              label: { type: "text" },
              count: { type: "number", mutable: true },
            },
          },
        },
      },
    }),
  );
  await writeFile(
    join(f.module, "集合/集合.json"),
    JSON.stringify({
      target: "物品/火把",
      items: ["甲", "乙"],
      fixed: [{ label: "固定", count: 1 }],
    }),
  );
  await writeFile(join(f.module, "物品/银币.toml"), "quantity = 4\n");
  await writeFile(
    join(f.module, ".types/规则.fields.json"),
    JSON.stringify({
      fields: {
        body: { type: "text", mutable: true },
      },
    }),
  );
  const room = await createSession(f.sessions, f.module, "批量更新");
  return { ...f, room };
}

test("短期连接关闭不重置活动房间，最后关闭后重新加载修复的字段定义", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const first = await openSessionDatabase(f.sessions, f.room.id);
  const second = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => {
    first.close();
    second.close();
  });
  const root = gameDirectoryForDatabase(first);
  const input = {
    path: "物品/火把.json",
    changes: [{ op: "set" as const, path: "/quantity", value: 2 }],
  };
  await updateGameDocument(first, root, input);
  await readGameDocumentView(first, root, input.path);
  second.close();
  const updated = await updateGameDocument(first, root, {
    ...input,
    changes: [{ op: "set", path: "/quantity", value: 3 }],
  });
  assert.equal(updated.revision, 3);
  assert.equal((await readGameDocumentView(first, root, input.path)).values?.quantity, 3);
  first.close();
  await chmod(join(f.sessions, f.room.id, "module/.types/物品.fields.json"), 0o600);
  await writeFile(
    join(f.sessions, f.room.id, "module/.types/物品.fields.json"),
    JSON.stringify({
      fields: {
        quantity: { type: "number", required: true, mutable: true },
        note: { type: "text", mutable: true },
      },
    }),
  );
  const reopened = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => reopened.close());
  await updateGameDocument(reopened, gameDirectoryForDatabase(reopened), {
    path: input.path,
    changes: [{ op: "set", path: "/note", value: "新字段已生效" }],
  });
  assert.equal(
    (await readGameDocumentView(reopened, gameDirectoryForDatabase(reopened), input.path)).values
      ?.note,
    "新字段已生效",
  );
  assert.equal(
    (await readGameDocumentView(reopened, gameDirectoryForDatabase(reopened), input.path)).values
      ?.quantity,
    3,
  );
});

test("批量 JSON Patch 解析作者格式别名，用最终状态计算引用并保存 JSON 覆盖", async () => {
  const f = await batchFixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const tools = await createGameTools(dirname(game), new AbortController().signal);
  const result = await tools
    .find((tool) => tool.name === "batch_update")!
    .execute(
      "batch",
      {
        updates: [
          {
            path: "/集合/集合.json",
            patch: [
              { op: "test", path: "/target", value: "物品/火把" },
              { op: "replace", path: "/target", value: "物品/银币" },
              { op: "add", path: "/items/-", value: "丙" },
              { op: "remove", path: "/items/0" },
              { op: "replace", path: "/items/0", value: "丁" },
              { op: "replace", path: "/fixed/0/count", value: 2 },
            ],
          },
          { path: "物品/银币.toml", patch: [{ op: "replace", path: "/quantity", value: 7 }] },
          { path: "规则/玩法.md", patch: [{ op: "replace", path: "/body", value: "新正文" }] },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    );
  assert.equal(JSON.parse((result.content[0] as { text: string }).text), "Success");
  const read = (await readGamePath(db, game, "集合/集合.json")) as any;
  assert.equal(read.content.total, 7);
  assert.deepEqual(read.content.items, ["丁", "丙"]);
  assert.deepEqual(read.content.fixed, [{ label: "固定", count: 2 }]);
  const readTool = tools.find((tool) => tool.name === "read")!;
  const partial = await readTool.execute(
    "partial",
    { path: "集合/集合", fields: ["/total", "/items/1", "/fixed/0/count"] },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(JSON.parse((partial.content[0] as { text: string }).text), {
    path: "/集合/集合.json",
    revision: 2,
    content: { "/total": 7, "/items/1": "丙", "/fixed/0/count": 2 },
  });
  for (const field of ["/missing", "/items/2", "/items/01", "/items/length", "/toString"])
    await assert.rejects(readGamePath(db, game, "集合/集合", [field]), /字段不存在/);
  for (const field of ["", "total", "/items/~2"])
    await assert.rejects(readGamePath(db, game, "集合/集合", [field]), /JSON Pointer/);
  await assert.rejects(readGamePath(db, game, "集合/集合", []), /1 到 100/);
  await assert.rejects(readGamePath(db, game, "/", ["/total"]), /不支持目录/);
  await assert.rejects(readGamePath(db, game, ".types/集合.fields.json", ["/total"]), /字段不存在/);
  const index = JSON.parse(await readFile(join(dirname(game), "document-references.json"), "utf8"));
  assert.deepEqual(index.documents["集合/集合"].references, { "物品/银币": ["物品"] });
  assert.ok(index.documents["物品/银币"]);
  assert.ok(index.documents["规则/玩法"]);
  assert.equal(((await readGamePath(db, game, "规则/玩法.md")) as any).content.body, "新正文");
  assert.equal(
    JSON.parse(await readFile(join(dirname(game), "module/物品/银币.json"), "utf8")).quantity,
    4,
  );
  assert.equal(
    JSON.parse(await readFile(join(game, "规则/玩法.json"), "utf8")).values.body,
    "新正文",
  );
  // 第一份文档的公式必须看到同批修改后的引用目标，而不能用目标旧值通过校验。
  const before = await readFile(join(game, "集合/集合.json"), "utf8");
  await assert.rejects(
    batchUpdateGameDocuments(db, game, {
      updates: [
        { path: "集合/集合.json", patch: [{ op: "add", path: "/items/-", value: "未保存" }] },
        { path: "物品/银币.toml", patch: [{ op: "replace", path: "/quantity", value: -1 }] },
      ],
    }),
    /数量不能为负/,
  );
  assert.equal(await readFile(join(game, "集合/集合.json"), "utf8"), before);
  assert.equal(((await readGamePath(db, game, "物品/银币.toml")) as any).content.quantity, 7);
});

test("批量更新的状态冲突、字段权限、协议及引用错误均不发布任何文档", async () => {
  const f = await batchFixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const tools = await createGameTools(dirname(game), new AbortController().signal);
  const tool = tools.find((tool) => tool.name === "batch_update")!;
  const revision = stateRevision(db);
  const index = await readFile(join(dirname(game), "document-references.json"), "utf8");
  const invalidUpdates = [
    {
      path: "集合/集合.json",
      patch: [
        { op: "replace", path: "/items/0", value: "变化" },
        { op: "test", path: "/target", value: "过期值" },
      ],
    },
    {
      path: "集合/集合.json",
      patch: [{ op: "replace", path: "/fixed/0/label", value: "不能修改" }],
    },
    { path: "集合/集合.json", patch: [{ op: "remove", path: "/fixed/0" }] },
    {
      path: "集合/集合.json",
      patch: [{ op: "add", path: "/fixed/-", value: { label: "新增", count: 0 } }],
    },
    { path: "集合/集合.json", patch: [{ op: "replace", path: "/items", value: "不是列表" }] },
    { path: "集合/集合.json", patch: [{ op: "replace", path: "/total", value: 100 }] },
    { path: "集合/集合.json", patch: [{ op: "replace", path: "/target", value: "物品/不存在" }] },
    { path: "集合/集合.json", patch: [{ op: "replace", path: "/items/9", value: "越界" }] },
    { path: "集合/集合.json", patch: [{ op: "test", path: "/__proto__/polluted", value: true }] },
    { path: "集合/集合.json", patch: [{ op: "test", path: "/bad~2path", value: true }] },
    { path: "集合/集合.json", patch: [{ op: "replace", path: "/target" }] },
    { path: "集合/集合.json", patch: [{ op: "move", from: "/items/0", path: "/items/1" }] },
    { path: "物品/不存在.json", patch: [{ op: "add", path: "/quantity", value: 2 }] },
    { path: "/物品/火把.json", patch: [{ op: "replace", path: "/quantity", value: 3 }] },
  ];
  for (const invalid of invalidUpdates) {
    await assert.rejects(
      tool.execute(
        "invalid",
        {
          updates: [
            {
              path: "物品/火把.json",
              patch: [{ op: "replace", path: "/quantity", value: 2 }],
            },
            invalid,
          ],
        },
        undefined,
        undefined,
        undefined as never,
      ),
      JSON.stringify(invalid),
    );
    assert.equal(stateRevision(db), revision);
    assert.deepEqual(await readdir(game), []);
    assert.equal(await readFile(join(dirname(game), "document-references.json"), "utf8"), index);
  }
  assert.equal(((await readGamePath(db, game, "物品/火把.json")) as any).content.quantity, 1);
});

test("批量暂存失败清理临时文件，发布失败准确报告部分成功并刷新缓存", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const world = "世界/当前世界.json";
  const updates: GameDocumentUpdate[] = [
    { path: world, patch: [{ op: "replace", path: "/weather", value: "雨" }] },
    { path: "物品/火把.json", patch: [{ op: "replace", path: "/quantity", value: 2 }] },
  ];
  await readGameDocumentView(db, game, world);
  const revision = stateRevision(db);
  const stageFile = atomicFiles.stageFileAtomic;
  const secondPath = join(game, updates[1]!.path);
  const failStage = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    (target, content, options) =>
      target === secondPath
        ? Promise.reject(new Error("第二份文档暂存失败"))
        : stageFile(target, content, options),
  );
  try {
    await assert.rejects(batchUpdateGameDocuments(db, game, { updates }), /暂存失败/);
  } finally {
    failStage.mockRestore();
  }
  assert.equal(stateRevision(db), revision);
  assert.deepEqual(await readdir(join(game, "世界")), []);
  const failPublish = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    async (target, content, options) => {
      const staged = await stageFile(target, content, options);
      return target === secondPath
        ? {
            ...staged,
            publish: async () => {
              throw new Error("第二份文档发布失败");
            },
          }
        : staged;
    },
  );
  try {
    await assert.rejects(batchUpdateGameDocuments(db, game, { updates }), (error: Error) => {
      assert.match(error.message, /批次发布失败/);
      assert.ok(error.message.includes(`已保存：${JSON.stringify([world])}`));
      assert.ok(error.message.includes(`未保存：${JSON.stringify([updates[1]!.path])}`));
      return true;
    });
  } finally {
    failPublish.mockRestore();
  }
  assert.equal((await readGameDocumentView(db, game, world)).values?.weather, "雨");
  assert.equal(((await readGamePath(db, game, updates[1]!.path)) as any).content.quantity, 1);
  assert.equal(stateRevision(db), revision + 1);
  assert.deepEqual(await readdir(join(game, "物品")), []);
  assert.deepEqual(await readdir(join(game, "世界")), ["当前世界.json"]);
});

test("批量更新取消发生在发布前不写入，发布开始后完成整批，并发 test 拒绝过期状态", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const world = "世界/当前世界.json";
  const updates: GameDocumentUpdate[] = [
    { path: world, patch: [{ op: "replace", path: "/weather", value: "雨" }] },
    { path: "物品/火把.json", patch: [{ op: "replace", path: "/quantity", value: 2 }] },
  ];
  const stageFile = atomicFiles.stageFileAtomic;
  const controller = new AbortController();
  const cancelStage = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    async (target, content, options) => {
      const staged = await stageFile(target, content, options);
      if (target === join(game, world)) controller.abort();
      return staged;
    },
  );
  try {
    await assert.rejects(
      batchUpdateGameDocuments(db, game, { updates, signal: controller.signal }),
      { name: "AbortError" },
    );
  } finally {
    cancelStage.mockRestore();
  }
  assert.equal(((await readGamePath(db, game, world)) as any).content.weather, "晴");
  const publishController = new AbortController();
  const cancelPublish = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    async (target, content, options) => {
      const staged = await stageFile(target, content, options);
      return target === join(game, world)
        ? {
            ...staged,
            publish: async () => {
              await staged.publish();
              publishController.abort();
            },
          }
        : staged;
    },
  );
  try {
    await batchUpdateGameDocuments(db, game, { updates, signal: publishController.signal });
  } finally {
    cancelPublish.mockRestore();
  }
  assert.equal(((await readGamePath(db, game, updates[1]!.path)) as any).content.quantity, 2);
  const input = {
    updates: [
      {
        path: updates[1]!.path,
        patch: [
          { op: "test" as const, path: "/quantity", value: 2 },
          { op: "replace" as const, path: "/quantity", value: 3 },
        ],
      },
    ],
  };
  const concurrent = await Promise.allSettled([
    batchUpdateGameDocuments(db, game, input),
    batchUpdateGameDocuments(db, game, input),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(((await readGamePath(db, game, updates[1]!.path)) as any).content.quantity, 3);
});

test("单 JSON 引用图保存换装并恢复，普通属性不重写，写入失败和过期损坏索引可修复", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(
    join(f.module, ".types/角色.fields.json"),
    JSON.stringify({
      fields: {
        weapon: { type: "reference", targets: ["物品"], mutable: true },
        equipped: { type: "boolean", mutable: true },
        power: { type: "number", compute: "$self.equipped ? load($self.weapon).quantity : 0" },
        name: { type: "text", compute: "'角色 ' + $self.power" },
      },
    }),
  );
  await writeFile(
    join(f.module, "角色/角色.json"),
    JSON.stringify({ weapon: "物品/火把.json", equipped: false }),
  );
  await writeFile(join(f.module, "物品/银币.json"), JSON.stringify({ quantity: 4 }));
  const room = await createSession(f.sessions, f.module, "换装恢复");
  let db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const directory = dirname(game);
  const indexPath = join(directory, "document-references.json");
  const dependency = async () =>
    JSON.parse(await readFile(indexPath, "utf8")).documents["角色/角色"];
  assert.deepEqual(
    (await dependency()).references,
    { "物品/火把": ["物品"] },
    "未执行的公式分支也保留声明依赖",
  );
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 0);
  await updateGameDocument(db, game, {
    path: "角色/角色.json",
    changes: [
      { op: "set", path: "/weapon", value: "物品/银币" },
      { op: "set", path: "/equipped", value: true },
    ],
  });
  const saved = await dependency();
  assert.deepEqual(saved.references, { "物品/银币": ["物品"] }, "提交后即落盘，不等待下次展示读取");
  const source = await readFile(join(game, "角色/角色.json"), "utf8");
  const revision = stateRevision(db);
  const stageFile = atomicFiles.stageFileAtomic;
  const failIndex = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    (target, content, options) =>
      target === indexPath
        ? Promise.reject(new Error("依赖索引写入失败"))
        : stageFile(target, content, options),
  );
  try {
    await assert.rejects(
      updateGameDocument(db, game, {
        path: "角色/角色.json",
        changes: [{ op: "set", path: "/weapon", value: "物品/火把" }],
      }),
      /依赖索引写入失败/,
    );
  } finally {
    failIndex.mockRestore();
  }
  assert.equal(await readFile(join(game, "角色/角色.json"), "utf8"), source);
  assert.deepEqual(await dependency(), saved);
  assert.equal(stateRevision(db), revision);
  db.close();
  forgetGameDocumentViews(game);
  forgetStateVersions(directory);
  forgetFrozenModule(join(directory, "module"));
  db = await openSessionDatabase(f.sessions, room.id);
  await readGameDocumentSnapshot(db, game);
  assert.deepEqual(await dependency(), saved, "重启保留已提交的引用和指纹");
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).title, "角色 4");
  const unchangedIndex = await readFile(indexPath, "utf8");
  await updateGameDocument(db, game, {
    path: "物品/银币.json",
    changes: [{ op: "set", path: "/quantity", value: 7 }],
  });
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 7);
  assert.equal(await readFile(indexPath, "utf8"), unchangedIndex, "数量变化不重写引用图");
  // 模拟文件已发布而索引尚未提交就中断，重启必须以文件为准修复关系。
  await writeFile(
    join(game, "角色/角色.json"),
    JSON.stringify({
      $overlay: 1,
      values: { weapon: "物品/火把", equipped: true },
      removed: [],
    }),
  );
  db.close();
  forgetGameDocumentViews(game);
  forgetStateVersions(directory);
  db = await openSessionDatabase(f.sessions, room.id);
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 1);
  assert.deepEqual((await dependency()).references, { "物品/火把": ["物品"] });
  assert.notEqual((await dependency()).fingerprint, saved.fingerprint);
  await updateGameDocument(db, game, {
    path: "物品/火把.json",
    changes: [{ op: "set", path: "/quantity", value: 9 }],
  });
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 9);
  await writeFile(indexPath, "{损坏的索引");
  db.close();
  forgetGameDocumentViews(game);
  forgetStateVersions(directory);
  db = await openSessionDatabase(f.sessions, room.id);
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 9);
  assert.deepEqual((await dependency()).references, { "物品/火把": ["物品"] });
  // 索引发布失败发生在文档已保存之后，当前进程也必须修复，而不能继续复用旧结果。
  const beforePublishFailure = await readFile(indexPath, "utf8");
  const failPublish = spyOn(atomicFiles, "stageFileAtomic").mockImplementation(
    async (target, content, options) => {
      const staged = await stageFile(target, content, options);
      return target === indexPath
        ? {
            ...staged,
            publish: async () => {
              throw new Error("索引发布失败");
            },
          }
        : staged;
    },
  );
  try {
    await assert.rejects(
      updateGameDocument(db, game, {
        path: "角色/角色.json",
        changes: [{ op: "set", path: "/weapon", value: "物品/银币" }],
      }),
      /游戏文档已保存.*依赖索引保存失败/,
    );
  } finally {
    failPublish.mockRestore();
  }
  assert.equal(await readFile(indexPath, "utf8"), beforePublishFailure);
  assert.equal((await readGameDocumentView(db, game, "角色/角色.json")).values?.power, 7);
  assert.deepEqual((await dependency()).references, { "物品/银币": ["物品"] });
});

test("多级揭露对玩家过滤、主持仍能读取，权威读取核验远端引用且提交拒绝远端公式错误", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const definitions = {
    场景: {
      displayWhen: "$self.revealed === true",
      fields: {
        revealed: { type: "boolean", mutable: true, visibility: "gm" },
        base: { type: "number", mutable: true },
      },
    },
    陷阱: {
      displayWhen: "$self.revealed === true",
      fields: {
        scene: { type: "reference", targets: ["场景"] },
        revealed: { type: "boolean", compute: "load($self.scene)?.revealed === true" },
        power: {
          type: "number",
          compute:
            "load($self.scene).base < 0 ? (() => { throw new Error('基础值非法'); })() : load($self.scene).base",
        },
      },
    },
    宝物: {
      displayWhen: "$self.revealed === true",
      fields: {
        trap: { type: "reference", targets: ["陷阱"] },
        revealed: { type: "boolean", compute: "load($self.trap)?.revealed === true" },
        power: { type: "number", compute: "load($self.trap).power + 1" },
        ratio: { type: "number", compute: "$self.quantity / $self.quantity" },
        quantity: { type: "number", mutable: true },
      },
    },
  };
  for (const [id, definition] of Object.entries(definitions))
    await writeFile(join(f.module, ".types", `${id}.fields.json`), JSON.stringify(definition));
  await writeFile(
    join(f.module, "场景/古墓.json"),
    JSON.stringify({ name: "古墓", revealed: false, base: 3 }),
  );
  await writeFile(
    join(f.module, "陷阱/机关.json"),
    JSON.stringify({ name: "机关", scene: "场景/古墓" }),
  );
  await writeFile(
    join(f.module, "宝物/宝珠.json"),
    JSON.stringify({ name: "宝珠", trap: "陷阱/机关", quantity: 1 }),
  );
  await writeFile(
    join(f.module, ".types/规则.fields.json"),
    JSON.stringify({
      fields: {
        target: { type: "reference", targets: ["宝物"] },
        nested: {
          type: "object",
          fields: { targets: { type: "list", item: { type: "reference", targets: ["宝物"] } } },
        },
      },
    }),
  );
  await writeFile(
    join(f.module, "规则/查阅.json"),
    JSON.stringify({
      name: "查阅说明",
      target: "宝物/宝珠",
      nested: { targets: ["宝物/宝珠"] },
      description: "公开简介。[[宝物/宝珠]]",
      body: "公开正文。[[宝物/宝珠]]\n\n[不可公开的宝珠](%E5%AE%9D%E7%89%A9/%E5%AE%9D%E7%8F%A0.md)\n\n[隐藏引用][secret]\n\n[secret]: 宝物/宝珠\n\n<!-- 幕后注释 -->\n\n[unused]: https://example.com/未显示的幕后备注\n\n| 项目 | 说明 |\n| --- | --- |\n| 查阅 | 公开规则 |",
    }),
  );
  const room = await createSession(f.sessions, f.module, "多级揭露");
  const db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const hidden = await readGameDocumentView(db, game, "宝物/宝珠.json");
  assert.equal(hidden.visible, false);
  assert.equal(hidden.values, undefined);
  assert.doesNotMatch(hidden.title, /宝珠/);
  const companionTools = createCompanionDocumentTools(dirname(game), new AbortController().signal);
  const call = async (name: string, params: Record<string, unknown>) => {
    const result = await companionTools
      .find((tool) => tool.name === name)!
      .execute("query", params, undefined, undefined, undefined as never);
    const content = result.content[0]!;
    assert(content.type === "text");
    return JSON.parse(content.text);
  };
  assert.deepEqual(
    companionTools.map((tool) => tool.name),
    ["find", "read"],
  );
  assert.deepEqual((await call("find", { type: "宝物" })).documents, []);
  assert.deepEqual((await call("find", { query: "宝珠" })).documents, []);
  for (const id of [
    hidden.id!,
    "宝物/宝珠",
    "宝物/宝珠.json",
    ".types/宝物.fields.json",
    "../module/module.json",
  ])
    await assert.rejects(call("read", { id }), /资料不存在或当前不可见/);
  const guideId = (await call("find", { query: "查阅" })).documents[0].id;
  const guide = await call("read", { id: guideId });
  assert.equal(guide.values.target, null);
  assert.deepEqual(guide.values.nested.targets, []);
  assert.doesNotMatch(
    JSON.stringify(guide),
    /宝珠|幕后注释|未显示的幕后备注|secret|%E5|\.json|\.md/,
  );
  assert.match(guide.body, /公开正文/);
  assert.match(guide.body, /\| 项目/);
  const pages = await call("find", { limit: 1 });
  assert.equal(pages.documents.length, 1);
  assert.equal(pages.nextOffset, 1);
  assert.notEqual(
    (await call("find", { limit: 1, offset: 1 })).documents[0].id,
    pages.documents[0].id,
  );

  const host = (await readGamePath(db, game, "宝物/宝珠")) as { content: Record<string, unknown> };
  assert.equal(host.content.name, "宝珠");
  assert.equal(host.content.power, 4);
  await updateGameDocument(db, game, {
    path: "场景/古墓.json",
    changes: [{ op: "set", path: "/revealed", value: true }],
  });
  assert.equal((await readGameDocumentView(db, game, "宝物/宝珠.json")).visible, true);
  const foundTreasure = (await call("find", { type: "宝物" })).documents[0];
  assert.equal(foundTreasure.id, hidden.id);
  assert.equal((await call("read", { id: foundTreasure.id })).values.power, 4);
  const revealedGuide = await call("read", { id: guideId });
  assert.deepEqual(revealedGuide.values.target, foundTreasure);
  assert.deepEqual(revealedGuide.values.nested.targets, [foundTreasure]);
  assert.match(revealedGuide.body, new RegExp(`#document/${foundTreasure.id}`));
  assert.doesNotMatch(revealedGuide.body, /宝珠\.宝物|不可公开的宝珠|%E5|幕后注释/);

  // 人工修改不提升房间版本，主持读取仍必须核验第二层引用的当前原值。
  await writeFile(
    join(game, "场景/古墓.json"),
    JSON.stringify({ $overlay: 1, values: { revealed: true, base: 8 }, removed: [] }),
  );
  const changed = (await readGamePath(db, game, "宝物/宝珠")) as {
    content: Record<string, unknown>;
  };
  assert.equal(changed.content.power, 9);
  const beforeNonFinite = stateRevision(db);
  await assert.rejects(
    updateGameDocument(db, game, {
      path: "宝物/宝珠.json",
      changes: [{ op: "set", path: "/quantity", value: 0 }],
    }),
    /非有限数值/,
  );
  assert.equal(stateRevision(db), beforeNonFinite);
  await assert.rejects(access(join(game, "宝物/宝珠.json")), /ENOENT/);
  assert.equal(
    ((await readGamePath(db, game, "宝物/宝珠")) as { content: Record<string, unknown> }).content
      .quantity,
    1,
  );
  await updateGameDocument(db, game, {
    path: "场景/古墓.json",
    changes: [{ op: "set", path: "/base", value: -1 }],
  });
  const revision = stateRevision(db);
  await assert.rejects(
    updateGameDocument(db, game, {
      path: "宝物/宝珠.json",
      changes: [{ op: "set", path: "/quantity", value: 2 }],
    }),
    /基础值非法/,
  );
  assert.equal(stateRevision(db), revision);
  await assert.rejects(access(join(game, "宝物/宝珠.json")), /ENOENT/);
  await updateGameDocument(db, game, {
    path: "场景/古墓.json",
    changes: [{ op: "set", path: "/revealed", value: false }],
  });
  assert.equal((await readGameDocumentView(db, game, "宝物/宝珠.json")).visible, false);
  await assert.rejects(call("read", { id: foundTreasure.id }), /资料不存在或当前不可见/);
  assert.deepEqual((await call("find", { type: "宝物" })).documents, []);
  assert.equal((await call("read", { id: guideId })).values.target, null);
  await writeFile(join(game, "场景/古墓.json"), "损坏文档中的幕后原值");
  forgetGameDocumentViews(game);
  await assert.rejects(call("find", {}), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "无法查阅公开资料，请稍后重试");
    return true;
  });
});

test("read 的格式扩展名别名读取同一文档，同名多格式连精确路径也拒绝", async () => {
  const f = await fixture();
  try {
    const db = await openSessionDatabase(f.sessions, f.room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      await writeGameDocument(db, game, {
        path: "物品/银币.toml",
        content: { quantity: 3 },
      });
      await updateGameDocument(db, game, {
        path: "物品/火把.json",
        changes: [{ op: "set", path: "/quantity", value: 5 }],
      });
      for (const path of ["物品/火把.json", "物品/银币.toml", "规则/玩法.md"]) {
        const full = await readGamePath(db, game, path);
        assert.deepEqual(await readGamePath(db, game, path.replace(/\.[^.]+$/, "")), full);
        assert.deepEqual(await readGamePath(db, game, `/${path.replace(/\.[^.]+$/, "")}`), full);
        for (const extension of ["json", "toml", "md"])
          assert.deepEqual(
            await readGamePath(db, game, path.replace(/\.[^.]+$/, `.${extension}`)),
            full,
          );
      }
      const tools = await createGameTools(
        roomDirectory(f.sessions, f.room.id),
        new AbortController().signal,
      );
      const result = await tools
        .find((tool) => tool.name === "read")!
        .execute("test", { path: "物品/火把" }, undefined, undefined, undefined as never);
      const response = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(response.path, "/物品/火把.json");
      assert.equal(response.content.quantity, 5);
      for (const path of ["火把", "物品/不存在"])
        await assert.rejects(readGamePath(db, game, path), /不存在/);
      await assert.rejects(readGamePath(db, game, "物品/../Items/火把"), /路径无效/);
      await mkdir(join(game, "物品/目录"));
      await writeFile(join(game, "物品/目录.json"), '{"quantity":1}');
      await assert.rejects(readGamePath(db, game, "物品/目录"), /只能查阅游戏文档与字段定义/);
      // 跨覆盖层出现格式冲突时不能任选一个文件。
      await writeFile(join(game, "物品/火把.toml"), "quantity = 9");
      await assert.rejects(readGamePath(db, game, "物品/火把"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /文档路径不唯一/);
        assert.ok(error.message.includes("物品/火把.json"));
        assert.ok(error.message.includes("物品/火把.toml"));
        return true;
      });
      await assert.rejects(readGamePath(db, game, "物品/火把.json"), /文档路径不唯一/);
    } finally {
      db.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("系统目录索引按 doctype 披露实际目录、后缀和本局新增文档", async () => {
  const f = await fixture();
  try {
    const db = await openSessionDatabase(f.sessions, f.room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      const deep = "规则/探险/甲/乙/丙/丁/戊";
      await mkdir(join(game, deep), { recursive: true });
      for (let i = 0; i < 21; i++)
        await writeFile(join(game, deep, `检定${i}.md`), "规则正文不应出现在目录中");
      await writeFile(join(game, deep, "说明.txt"), "不是规则文档");
      await writeGameDocument(db, game, {
        path: "物品/战利品/银币.toml",
        content: { quantity: 2 },
      });
      const manual = "规则/主持人手册/时间与并行.md";
      await mkdir(join(game, "主持人手册"), { recursive: true });
      await writeFile(join(game, manual), "并行行动规则正文");
      const inlineDirectory = "物品/行装/甲/乙/丙/丁/戊";
      await mkdir(join(game, inlineDirectory), { recursive: true });
      for (let i = 0; i < 20; i++)
        await writeFile(join(game, inlineDirectory, `物品${i}.json`), '{"quantity":1}');
      const index = await gameFolderIndex(game, db);
      assert.ok(index.includes("### 核心规则（规则）"));
      assert.ok(index.includes("检定与行动裁定依据"));
      assert.ok(index.includes('- 文件夹："规则"（1 份）'));
      assert.ok(index.includes(`- 文件夹："${deep}"（21 份）`));
      assert.ok(index.includes(`read(${JSON.stringify({ path: deep })})`));
      assert.ok(index.includes("- 定义：.types/规则.fields.json"));
      assert.ok(index.includes("读取时用 文件夹/文件名 拼接为 path"));
      assert.ok(index.includes(`- 文件夹："${inlineDirectory}"（20 份）`));
      for (const path of ["规则/玩法.json", "物品/火把.json", "物品/战利品/银币.json", manual]) {
        const filename = path.slice(path.lastIndexOf("/") + 1);
        assert.equal(index.split(`  - 文件：${JSON.stringify(filename)}`).length - 1, 1, path);
        if (path.includes("/")) assert.ok(!index.includes(path));
        const document = (await readGamePath(db, game, path)) as any;
        assert.equal(document.path, `/${path}`);
      }
      assert.ok(!index.includes(".主持人手册/"));
      assert.ok(index.includes('- 文件夹："规则/主持人手册"（1 份）\n  - 文件："时间与并行.md"'));
      assert.ok(!index.includes("并行行动规则正文"));
      const alias = (await readGamePath(db, game, manual.replace(/\.md$/, ".json"))) as any;
      assert.equal(alias.path, `/${manual}`);
      await assert.rejects(readGamePath(db, game, "规则/.主持人手册/时间与并行.json"), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(JSON.stringify(manual)));
        assert.ok(error.message.includes("请使用实际路径重新读取"));
        assert.ok(!error.message.includes("并行行动规则正文"));
        return true;
      });
      for (let i = 0; i < 20; i++) {
        const filename = `物品${i}.json`;
        assert.ok(index.includes(`  - 文件：${JSON.stringify(filename)}`));
        assert.ok(!index.includes(`${inlineDirectory}/${filename}`));
        const document = (await readGamePath(db, game, `${inlineDirectory}/${filename}`)) as any;
        assert.equal(document.content.quantity, 1);
      }
      assert.ok(!index.includes("工作区目录索引"));
      assert.ok(!index.includes("规则/检定0.md"));
      assert.ok(!index.includes("说明.txt"));
      assert.ok(!index.includes("规则正文不应出现在目录中"));
    } finally {
      db.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("game 工作区独立于只读快照，支持读取、更新与创建", async () => {
  const f = await fixture();
  try {
    const db = await openSessionDatabase(f.sessions, f.room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      const before = (await readGamePath(db, game, "/世界/当前世界.json")) as any;
      assert.equal(before.revision, 1);
      assert.equal(before.content.weather, "晴");
      const update = {
        path: "世界/当前世界.json",
        changes: [{ op: "set" as const, path: "/weather", value: "雨" }],
      };
      const changed = await updateGameDocument(db, game, update);
      assert.equal(changed.revision, 2);
      const moved = await updateGameDocument(db, game, {
        path: update.path,
        changes: [{ op: "set", path: "/position/x", value: 1 }],
      });
      assert.equal(moved.revision, 3);
      await assert.rejects(
        updateGameDocument(db, game, {
          path: update.path,
          changes: [{ op: "set", path: "/supplies", value: 2 }],
        }),
        /未标记为运行时可修改/,
      );
      await assert.rejects(
        updateGameDocument(db, game, {
          path: update.path,
          changes: [{ op: "set", path: "/name", value: "新名字" }],
        }),
        /不是 Schema 字段/,
      );
      assert.equal(
        ((await readGamePath(db, game, update.path)) as { content: { weather: string } }).content
          .weather,
        "雨",
      );
      assert.equal(JSON.parse(await readFile(join(f.module, update.path), "utf8")).weather, "晴");
      const created = await writeGameDocument(db, game, {
        path: "物品/银币.json",
        content: { name: "银币", quantity: 12 },
      });
      assert.equal(created.revision, 1);
      assert.equal(stateRevision(db), 3);
      const index = await gameFolderIndex(game, db);
      assert.match(index, /\.types\/世界\.fields\.json/);
      assert.match(index, /- 文件夹："世界"（[^\n]+\n  - 文件："当前世界\.json"/);
      assert.match(index, /- 文件夹："物品"（[^\n]+\n(?:  - [^\n]+\n)*  - 文件："银币\.json"/);
      const folder = (await readGamePath(db, game, "/物品")) as any;
      assert.deepEqual(folder.entries, ["火把.json", "银币.json"]);
      const markdown = (await readGamePath(db, game, "/规则/玩法.md")) as any;
      assert.equal(markdown.revision, 1);
      const tools = await createGameTools(
        roomDirectory(f.sessions, f.room.id),
        new AbortController().signal,
      );
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "batch_update",
        "end_adventure",
        "find",
        "grep",
        "read",
        "update",
        "write",
      ]);
      const updateTool = tools.find((tool) => tool.name === "update")!;
      const updateResult = await updateTool.execute(
        "test",
        {
          path: update.path,
          patch: [{ op: "replace", path: "/weather", value: "风" }],
        },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(JSON.parse((updateResult.content[0] as { text: string }).text), "Success");
      assert.equal(
        ((await readGamePath(db, game, update.path)) as { content: { weather: string } }).content
          .weather,
        "风",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("可新增并独立更新世界文档，仍拒绝越界路径并读取外部修改", async () => {
  const f = await fixture();
  try {
    const db = await openSessionDatabase(f.sessions, f.room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      const secondWorld = "世界/另一个世界.json";
      await writeGameDocument(db, game, {
        path: secondWorld,
        content: { weather: "雾" },
      });
      await updateGameDocument(db, game, {
        path: secondWorld,
        changes: [{ op: "set", path: "/weather", value: "雨" }],
      });
      assert.equal((await readStateDocument(db, game, secondWorld)).content.weather, "雨");
      assert.equal((await readStateDocument(db, game, "世界/当前世界.json")).content.weather, "晴");
      assert.ok(
        (await loadSession(f.sessions, f.room.id)).documents.some(
          (document) => document.path === secondWorld,
        ),
      );
      await assert.rejects(
        writeGameDocument(db, game, {
          path: "物品/../逃逸.json",
          content: { quantity: 1 },
        }),
        /路径无效|超出/,
      );
      await mkdir(join(game, "物品"), { recursive: true });
      await writeFile(join(game, "物品/占位.json"), JSON.stringify({ quantity: 1 }));
      await assert.rejects(
        writeGameDocument(db, game, {
          path: "物品/占位.json",
          content: { quantity: 2 },
        }),
        /游戏文档已存在/,
      );
      assert.equal(
        (await loadSession(f.sessions, f.room.id)).documents.find(
          (document) => document.path === "物品/占位.json",
        )?.revision,
        1,
      );
      await updateGameDocument(db, game, {
        path: "物品/占位.json",
        changes: [{ op: "set", path: "/quantity", value: 2 }],
      });
      assert.equal(
        ((await readGamePath(db, game, "/物品/占位.json")) as { revision: number }).revision,
        2,
      );
      const stopped = new AbortController();
      stopped.abort();
      await assert.rejects(
        updateGameDocument(db, game, {
          signal: stopped.signal,
          path: "物品/火把.json",
          changes: [{ op: "set", path: "/quantity", value: 2 }],
        }),
        /aborted/i,
      );
      const path = join(game, "物品/火把.json");
      await writeFile(
        path,
        JSON.stringify({ $overlay: 1, values: { quantity: 999 }, removed: [] }),
      );
      const current = (await readGamePath(db, game, "/物品/火把.json")) as any;
      assert.equal(current.content.quantity, 999);
      await createGameTools(roomDirectory(f.sessions, f.room.id), new AbortController().signal);
      await updateGameDocument(db, game, {
        path: "物品/火把.json",
        changes: [{ op: "set", path: "/quantity", value: 1000 }],
      });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        $overlay: 1,
        values: { quantity: 1000 },
        removed: [],
      });
    } finally {
      db.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("玩家资料按当前事实计算字段，房主调试可查看原始幕后内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-visibility-"));
  const module = join(root, "module");
  const sessions = join(root, "sessions");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "测试模组", description: "可见性测试" }),
  );
  try {
    await writeFile(
      join(module, ".types", "怪物.fields.json"),
      JSON.stringify({
        fields: {
          source_description: { type: "text", visibility: "gm" },
          source_image: { type: "text", visibility: "gm" },
          name: {
            type: "text",
            compute:
              "$self.source_name.endsWith('.怪物') ? (() => { throw new Error('标题后缀错误') })() : ($self.seen ? $self.source_name : '未知怪物')",
          },
          description: {
            type: "text",
            compute: "$self.seen ? '一尊会活动的陶俑' : '只知道这里有怪物。'",
          },
          image: { type: "text", compute: "$self.seen ? '陶俑.webp' : null" },
          source_name: { type: "text", visibility: "gm" },
          seen: { type: "boolean", mutable: true },
          trueName: { type: "text", visibility: "gm" },
          gmSecret: { type: "text", visibility: "gm" },
          appearance: { type: "text", compute: "$self.seen ? '裂纹陶甲' : '？？？'" },
          attacks: {
            type: "list",
            item: {
              type: "object",
              fields: {
                rawDamage: { type: "text", visibility: "gm" },
                damage: { type: "text", compute: "$self.seen ? $item.rawDamage : '？？？'" },
              },
            },
          },
          traits: {
            type: "object",
            fields: {
              raw: { type: "text", visibility: "gm" },
              visible: { type: "text", compute: "$self.seen ? $item.raw : '？？？'" },
            },
          },
        },
      }),
    );
    await writeFile(
      join(module, "怪物/陶俑.json"),
      JSON.stringify({
        source_name: "陶俑",
        source_image: "陶俑.webp",
        seen: false,
        trueName: "陶俑",
        gmSecret: "守墓机关",
        attacks: [{ rawDamage: "石锤 1d6" }],
        traits: { raw: "怕水" },
      }),
    );
    await writeFile(join(module, "陶俑.webp"), "image fixture");
    await writeFile(
      join(module, ".types", "线索.fields.json"),
      JSON.stringify({
        fields: {
          source_body: { type: "text", visibility: "gm" },
          body: {
            type: "text",
            compute: "$self.opened ? '音乐盒里卡着一根头发。' : '音乐盒尚未打开。'",
          },
          opened: { type: "boolean", mutable: true },
          hair: { type: "text", compute: "$self.opened ? '凶手的一根头发卡在转轴处' : '？？？'" },
          gmSecret: { type: "text", visibility: "gm" },
        },
      }),
    );
    await writeFile(
      join(module, "线索/音乐盒.md"),
      "---\nname: 音乐盒\nopened: false\ngmSecret: 真凶留下的\nsource_body: 原始幕后正文。\n---\n",
    );
    await writeFile(
      join(module, ".types", "封印.fields.json"),
      JSON.stringify({
        fields: {
          tripped: { type: "boolean", mutable: true },
          gmSecret: { type: "text", visibility: "gm" },
          hint: {
            type: "text",
            compute: "$self.tripped ? (() => { throw new Error('幕后失败') })() : '正常'",
          },
        },
      }),
    );
    await writeFile(
      join(module, "封印/封印.json"),
      JSON.stringify({
        name: "不可泄露的封印",
        tripped: false,
        gmSecret: "禁咒",
      }),
    );
    const room = await createSession(sessions, module, "可见性局");
    const first = await loadSession(sessions, room.id);
    const monster = first.documents.find((item) => item.docType === "怪物")!;
    assert.equal(monster.title, "未知怪物");
    assert.equal(monster.values?.appearance, "？？？");
    assert.deepEqual(monster.values?.attacks, [{ damage: "？？？" }]);
    assert.deepEqual(monster.values?.traits, { visible: "？？？" });
    assert.equal(monster.values?.gmSecret, undefined);
    assert.equal(
      first.documentTypes
        .find((type) => type.id === "怪物")
        ?.fields.some((field) => field.key === "gmSecret"),
      false,
    );
    const clue = first.documents.find((item) => item.docType === "线索")!;
    assert.equal(clue.body, "音乐盒尚未打开。");
    assert.equal(clue.values?.hair, "？？？");
    const db = await openSessionDatabase(sessions, room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      const companionTools = createCompanionDocumentTools(
        dirname(game),
        new AbortController().signal,
      );
      const query = async (name: string, params: Record<string, unknown>) => {
        const result = await companionTools
          .find((tool) => tool.name === name)!
          .execute("query", params, undefined, undefined, undefined as never);
        const content = result.content[0]!;
        assert(content.type === "text");
        return JSON.parse(content.text);
      };
      assert.deepEqual((await query("find", { query: "陶俑" })).documents, []);
      const publicMonster = await query("read", { id: monster.id });
      assert.equal(publicMonster.title, "未知怪物");
      assert.deepEqual(publicMonster.values.attacks, [{ damage: "？？？" }]);
      assert.deepEqual(publicMonster.values.traits, { visible: "？？？" });
      assert.doesNotMatch(
        JSON.stringify(publicMonster),
        /陶俑|石锤|怕水|守墓机关|source_|gmSecret|rawDamage|\.json|computed/,
      );
      const publicClue = await query("read", { id: clue.id });
      assert.equal(publicClue.body, "音乐盒尚未打开。");
      assert.doesNotMatch(
        JSON.stringify(publicClue),
        /原始幕后正文|真凶留下的|source_|gmSecret|_body/,
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        createCompanionDocumentTools(dirname(game), cancelled.signal)[0]!.execute(
          "cancelled",
          {},
          undefined,
          undefined,
          undefined as never,
        ),
        /abort/i,
      );
      const raw = (await readGamePath(db, game, "/线索/音乐盒.md")) as any;
      assert.equal(raw.revision, 1);
      assert.equal(raw.content.body, "音乐盒尚未打开。");
      assert.equal(raw.content.source_body, "原始幕后正文。");
      assert.equal(raw.content.gmSecret, "真凶留下的");
      assert.equal(raw.content.hair, "？？？");
      const partialClue = (await readGamePath(db, game, "/线索/音乐盒.md", ["/body"])) as any;
      assert.deepEqual(partialClue.content, {
        "/body": raw.content.body,
        ...(Object.hasOwn(raw.content, "_body") ? { "/_body": raw.content._body } : {}),
      });
      const monsterRead = (await readGamePath(db, game, "/怪物/陶俑.json")) as any;
      assert.equal(monsterRead.content.name, "未知怪物");
      assert.equal(monsterRead.content.source_name, "陶俑");
      assert.equal(monsterRead.content.gmSecret, "守墓机关");
      assert.equal(monsterRead.content.attacks[0].damage, "？？？");
      assert.equal(monsterRead.content.attacks[0].rawDamage, "石锤 1d6");
      await writeGameDocument(db, game, {
        path: "怪物/无名陶俑.json",
        content: { source_name: "无名陶俑", seen: true, attacks: [], traits: { raw: "怕水" } },
      });
      const unnamed = (await readGamePath(db, game, "怪物/无名陶俑.json")) as any;
      assert.equal(unnamed.content.name, "无名陶俑");
      await rm(join(game, "怪物/无名陶俑.json"));
      const changed = await updateGameDocument(db, game, {
        path: "线索/音乐盒.md",
        changes: [{ op: "set" as const, path: "/opened", value: true }],
      });
      assert.equal(changed.revision, 2);
      assert.match(
        await readFile(join(sessions, room.id, "module", "线索/音乐盒.json"), "utf8"),
        /"source_body": "原始幕后正文。"/u,
      );
      assert.equal(
        (await readFile(join(game, "线索/音乐盒.json"), "utf8")).includes("原始幕后正文"),
        false,
      );
      await assert.rejects(
        updateGameDocument(db, game, {
          path: "线索/音乐盒.md",
          changes: [{ op: "set", path: "/body", value: "改写" }],
        }),
        /未标记为运行时可修改/,
      );
      await updateGameDocument(db, game, {
        path: "怪物/陶俑.json",
        changes: [{ op: "set", path: "/seen", value: true }],
      });
    } finally {
      db.close();
    }
    const revealed = await loadSession(sessions, room.id);
    assert.equal(revealed.documents.find((item) => item.docType === "怪物")?.title, "陶俑");
    assert.equal(
      revealed.documents.find((item) => item.docType === "怪物")?.values?.appearance,
      "裂纹陶甲",
    );
    assert.deepEqual(revealed.documents.find((item) => item.docType === "怪物")?.values?.attacks, [
      { damage: "石锤 1d6" },
    ]);
    assert.equal(
      revealed.documents.find((item) => item.docType === "线索")?.values?.hair,
      "凶手的一根头发卡在转轴处",
    );
    assert.equal(
      revealed.documents.find((item) => item.docType === "线索")?.body,
      "音乐盒里卡着一根头发。",
    );
    await roomDisplaySettings(sessions, room.id, { showAllDocuments: true });
    const debug = await loadSession(sessions, room.id);
    assert.equal(
      debug.documents.find((item) => item.docType === "怪物")?.values?.gmSecret,
      "守墓机关",
    );
    assert.equal(
      debug.documents.find((item) => item.docType === "线索")?.values?.source_body,
      "原始幕后正文。",
    );
    assert.equal(
      debug.documentTypes
        .find((type) => type.id === "怪物")
        ?.fields.some((field) => field.key === "gmSecret"),
      true,
    );
    await roomDisplaySettings(sessions, room.id, { showAllDocuments: false });
    assert.equal(
      (await loadSession(sessions, room.id)).documents.find((item) => item.docType === "怪物")
        ?.values?.gmSecret,
      undefined,
    );
    const faultDb = await openSessionDatabase(sessions, room.id);
    try {
      const game = gameDirectoryForDatabase(faultDb);
      const revision = stateRevision(faultDb);
      await assert.rejects(
        updateGameDocument(faultDb, game, {
          path: "封印/封印.json",
          changes: [{ op: "set", path: "/tripped", value: true }],
        }),
        /幕后失败/,
      );
      assert.equal(stateRevision(faultDb), revision);
      await assert.rejects(access(join(game, "封印/封印.json")));
      await assert.rejects(
        writeGameDocument(faultDb, game, {
          path: "封印/新封印.json",
          content: { tripped: true },
        }),
        /幕后失败/,
      );
      await assert.rejects(access(join(game, "封印/新封印.json")));
      // 模拟外部修改引入公式错误：展示隐藏失败字段，原值仍可供主持检查。
      await writeFile(
        join(game, "封印/封印.json"),
        JSON.stringify({ $overlay: 1, values: { tripped: true }, removed: [] }),
      );
      // 无关坏文档不应阻止其他文档写入。
      await updateGameDocument(faultDb, game, {
        path: "怪物/陶俑.json",
        changes: [{ op: "set", path: "/seen", value: false }],
      });
    } finally {
      faultDb.close();
    }
    const failed = (await loadSession(sessions, room.id)).documents.find(
      (item) => item.docType === "封印",
    )!;
    assert.equal(failed.valid, true);
    assert.equal(failed.title, "不可泄露的封印");
    assert.equal(failed.values?.hint, null);
    assert.equal(failed.values?.tripped, true);
    assert.equal(JSON.stringify(failed).includes("禁咒"), false);
    const faultReadDb = await openSessionDatabase(sessions, room.id);
    try {
      const faultRead = (await readGamePath(
        faultReadDb,
        gameDirectoryForDatabase(faultReadDb),
        "/封印/封印.json",
      )) as any;
      assert.equal(faultRead.revision, 1);
      assert.equal(faultRead.content.name, "不可泄露的封印");
      assert.equal(faultRead.content.tripped, true);
      assert.equal(faultRead.content.gmSecret, "禁咒");
      assert.equal(faultRead.content.hint, null);
      assert.equal(faultRead.error, undefined);
    } finally {
      faultReadDb.close();
    }
    await roomDisplaySettings(sessions, room.id, { showAllDocuments: true });
    const debugFailed = (await loadSession(sessions, room.id)).documents.find(
      (item) => item.docType === "封印",
    )!;
    assert.equal(debugFailed.values?.gmSecret, "禁咒");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("提交校验与读取共用计算名称，名称计算失败不落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-candidate-title-"));
  const module = join(root, "module");
  const sessions = join(root, "sessions");
  try {
    await mkdir(join(module, ".types"), { recursive: true });
    await writeFile(
      join(module, "module.json"),
      JSON.stringify({ name: "标题测试", description: "提交与读取一致" }),
    );
    await writeFile(
      join(module, ".types", "资料.fields.json"),
      JSON.stringify({
        fields: {
          name: {
            type: "text",
            compute: "$self.expected_name === $self.source_name ? $self.source_name : null",
          },
          source_name: { type: "text", visibility: "gm" },
          expected_name: { type: "text", mutable: true },
        },
      }),
    );
    await writeFile(
      join(module, "资料/原资料.json"),
      JSON.stringify({ source_name: "原资料", expected_name: "原资料" }),
    );
    const room = await createSession(sessions, module, "标题测试");
    const db = await openSessionDatabase(sessions, room.id);
    try {
      const game = gameDirectoryForDatabase(db);
      await writeGameDocument(db, game, {
        path: "资料/新资料.json",
        content: { source_name: "新资料", expected_name: "新资料" },
      });
      await updateGameDocument(db, game, {
        path: "资料/原资料.json",
        changes: [{ op: "set", path: "/expected_name", value: "原资料" }],
      });
      const read = (await readGamePath(db, game, "资料/新资料.json")) as any;
      assert.equal(read.content.name, "新资料");
      const previousSource = await readFile(join(game, "资料/新资料.json"), "utf8");
      const revision = stateRevision(db);
      await assert.rejects(
        updateGameDocument(db, game, {
          path: "资料/新资料.json",
          changes: [{ op: "set", path: "/expected_name", value: "错误标题" }],
        }),
        /计算/,
      );
      assert.equal(await readFile(join(game, "资料/新资料.json"), "utf8"), previousSource);
      assert.equal(stateRevision(db), revision);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模组自定位置、参与者、回合和效果结构，平台只检查声明的字段与引用", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const definition = createWorldStateDefinition("地点") as any;
  definition.fields.scenes.item.fields.activity.options.push("交涉");
  definition.fields.effects = {
    type: "object",
    mutable: true,
    fields: { source: { type: "text" }, remaining: { type: "number" } },
  };
  definition.fields.world_time = { type: "number", compute: "0.5" };
  await writeFile(join(f.modulePath, ".types/世界状态.fields.json"), JSON.stringify(definition));
  const scene = {
    id: "重复标识由模组解释",
    location: "地点/集合点",
    members: ["地点/集合点"],
    activity: "交涉",
    round: 0.5,
    turn: "地点/集合点",
  };
  const values = { scenes: [scene, scene], effects: { source: "环境", remaining: 1.5 } };
  await writeFile(join(f.modulePath, "世界状态/状态/当前世界.json"), JSON.stringify(values));
  assert.equal((await validateModule(f.modulePath)).status, "success");
  const room = await createSession(f.sessions, f.modulePath, "自定义状态");
  const db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const read = await readStateDocument(db, game, "世界状态/状态/当前世界");
  assert.deepEqual(read.content, values, "创建房间不根据字段名补写或改写模组状态");
  await updateGameDocument(db, game, {
    path: read.path,
    changes: [{ op: "set", path: "/effects", value: { source: "环境", remaining: 0.5 } }],
  });
  assert.deepEqual((await readStateDocument(db, game, read.path)).content.effects, {
    source: "环境",
    remaining: 0.5,
  });
  const revision = stateRevision(db);
  await assert.rejects(
    updateGameDocument(db, game, {
      path: read.path,
      changes: [{ op: "set", path: "/scenes", value: [{ ...scene, location: "地点/不存在" }] }],
    }),
  );
  assert.equal(stateRevision(db), revision, "通用引用约束仍然生效");
});

describe("CLI 校验与创建冒险支持多份状态文档并检查存储约束", () => {
  test("同类型、不同类型和不同格式的世界文档均可独立维护并恢复", async () => {
    const f = await createTestModule();
    onTestFinished(f.cleanup);
    await writeFile(
      join(f.modulePath, ".types/世界状态.fields.json"),
      JSON.stringify(createWorldStateDefinition()),
    );
    await writeFile(
      join(f.modulePath, ".types/任务进度.fields.json"),
      JSON.stringify({
        designation: "world_state",
        fields: { stage: { type: "text", required: true, mutable: true } },
      }),
    );
    await writeFile(join(f.modulePath, "世界状态/状态/另一世界.toml"), "scenes = []\n");
    await writeFile(
      join(f.modulePath, "任务进度/状态/任务.json"),
      JSON.stringify({ stage: "调查" }),
    );
    assert.equal((await validateModule(f.modulePath)).status, "success");
    const room = await createSession(f.sessions, f.modulePath, "多份状态");
    let db = await openSessionDatabase(f.sessions, room.id);
    try {
      let game = gameDirectoryForDatabase(db);
      for (const path of ["世界状态/状态/当前世界", "世界状态/状态/另一世界"])
        assert.deepEqual((await readStateDocument(db, game, path)).content.scenes, []);
      await updateGameDocument(db, game, {
        path: "任务进度/状态/任务",
        changes: [{ op: "set", path: "/stage", value: "完成" }],
      });
      db.close();
      db = await openSessionDatabase(f.sessions, room.id);
      game = gameDirectoryForDatabase(db);
      assert.equal((await readStateDocument(db, game, "任务进度/状态/任务")).content.stage, "完成");
      const session = await loadSession(f.sessions, room.id);
      const worldTypes = new Set(
        session.documentTypes
          .filter((type) => type.designation === "world_state")
          .map((type) => type.id),
      );
      assert.equal(
        session.documents.filter((document) => worldTypes.has(document.docType ?? "")).length,
        3,
      );
    } finally {
      db.close();
    }
  });

  const cases = [
    {
      name: "世界状态包含运行时保留字段",
      content: { scenes: [], _runtime: {} },
      error: /文档不能包含保留字段/,
    },
    {
      name: "世界状态原始文件超过大小限制",
      content: { scenes: [], padding: "文".repeat(350_000) },
      error: /游戏文档超过 1 MiB 限制/,
    },
  ];
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const f = await createTestModule();
      onTestFinished(f.cleanup);
      await writeFile(
        join(f.modulePath, ".types/世界状态.fields.json"),
        JSON.stringify(createWorldStateDefinition()),
      );
      if (scenario.content)
        await writeFile(
          join(f.modulePath, "世界状态/状态/当前世界.json"),
          JSON.stringify(scenario.content),
        );
      const report = await validateModule(f.modulePath);
      assert.equal(report.status, "error");
      assert.ok(
        report.issues.some(
          (issue) => issue.kind === "launch" && scenario.error.test(issue.message),
        ),
        JSON.stringify(report.issues),
      );
      await assert.rejects(
        createSession(join(f.root, "sessions"), f.modulePath, "无效开局"),
        scenario.error,
      );
    });
  }
});

test("武器文档公式覆盖贯通房间原始快照、昼夜更新及重启，错误公式和覆盖修改不落盘", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const worldPath = "世界/当前世界.json";
  const worldTypePath = join(f.module, ".types/世界.fields.json");
  const worldType = JSON.parse(await readFile(worldTypePath, "utf8"));
  worldType.fields.period = { type: "enum", options: ["白天", "夜晚"], mutable: true };
  await writeFile(worldTypePath, JSON.stringify(worldType));
  const world = JSON.parse(await readFile(join(f.module, worldPath), "utf8"));
  await writeFile(join(f.module, worldPath), JSON.stringify({ ...world, period: "白天" }));
  await writeFile(
    join(f.module, ".types/武器.fields.json"),
    JSON.stringify({
      fields: {
        name: { type: "text" },
        world: { type: "reference", targets: ["世界"] },
        baseAttack: { type: "number", mutable: true },
        attack: { type: "number", required: true },
      },
    }),
  );
  await writeFile(join(f.module, "武器/铁剑.json"), JSON.stringify({ baseAttack: 20, attack: 20 }));
  const expression = "$self.baseAttack + (load($self.world)?.period === '夜晚' ? 5 : 0)";
  await writeFile(
    join(f.module, "武器/夜刃.toml"),
    `baseAttack = 10\nworld = "世界/当前世界"\n[computed]\nattack = "${expression}"\nname = "'攻击 ' + $self.attack"\n`,
  );
  const room = await createSession(f.sessions, f.module, "文档公式覆盖");
  let db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const snapshot = await readGameDocumentSnapshot(db, game);
  assert.deepEqual(
    snapshot.find((entry) => entry.document.path === "武器/夜刃.json")!.computed,
    {
      attack: expression,
      name: "'攻击 ' + $self.attack",
    },
    "同步用原始快照保留实例公式",
  );
  assert.equal(
    snapshot.find((entry) => entry.document.path === "武器/夜刃.json")!.values.computed,
    undefined,
  );
  const day = await readGameDocumentView(db, game, "武器/夜刃.toml");
  assert.equal(day.title, "攻击 10");
  assert.equal(day.values?.computed, undefined);
  await updateGameDocument(db, game, {
    path: worldPath,
    changes: [{ op: "set", path: "/period", value: "夜晚" }],
  });
  assert.equal((await readGameDocumentView(db, game, "武器/夜刃.toml")).values?.attack, 15);
  assert.equal((await readGameDocumentView(db, game, "武器/铁剑.json")).values?.attack, 20);
  await updateGameDocument(db, game, {
    path: "武器/夜刃.toml",
    changes: [{ op: "set", path: "/baseAttack", value: 12 }],
  });
  const saved = await readFile(join(game, "武器/夜刃.json"), "utf8");
  assert.equal(saved.includes("computed"), false, "已有模组公式由基础文档继承，不重复写入覆盖");
  assert.equal(saved.includes("attack"), false, "计算结果不写回本局文件");
  const revision = stateRevision(db);
  for (const changes of [
    [{ op: "set" as const, path: "/computed/attack", value: "99" }],
    [{ op: "set" as const, path: "/attack", value: 99 }],
  ])
    await assert.rejects(
      updateGameDocument(db, game, { path: "武器/夜刃.toml", changes }),
      /Schema|运行时可修改/,
    );
  await assert.rejects(
    writeGameDocument(db, game, {
      path: "武器/坏武器.json",
      content: { baseAttack: 3, computed: { attack: "'错误类型'" } },
    }),
    /计算结果无效/,
  );
  await assert.rejects(access(join(game, "武器/坏武器.json")), /ENOENT/);
  assert.equal(stateRevision(db), revision);
  assert.equal(await readFile(join(game, "武器/夜刃.json"), "utf8"), saved);
  await writeGameDocument(db, game, {
    path: "武器/新武器.json",
    content: { baseAttack: 2, computed: { attack: "$self.baseAttack + 30" } },
  });
  assert.equal((await readGameDocumentView(db, game, "武器/新武器.json")).values?.attack, 32);
  db.close();
  forgetGameDocumentViews(game);
  forgetStateVersions(dirname(game));
  db = await openSessionDatabase(f.sessions, room.id);
  assert.equal((await readGameDocumentView(db, game, "武器/夜刃.toml")).title, "攻击 17");
  assert.equal((await readGameDocumentView(db, game, "武器/新武器.json")).values?.attack, 32);
  // 只人工修改基础文档公式，不修改业务值或进程内版本，权威读取仍须看到新结果。
  const weaponPath = join(dirname(game), "module", "武器/夜刃.json");
  const originalWeapon = await readFile(weaponPath, "utf8");
  await chmod(weaponPath, 0o600);
  await writeFile(weaponPath, originalWeapon.replace(expression, "$self.baseAttack + 20"));
  const reread = (await readGamePath(db, game, "武器/夜刃.toml")) as {
    content: { name: string; attack: number };
  };
  assert.equal(reread.content.attack, 32);
  assert.equal(reread.content.name, "攻击 32");
});

async function instanceRoomFixture() {
  const f = await fixture();
  await writeFile(
    join(f.module, ".types/持有者.fields.json"),
    JSON.stringify({
      fields: {
        world: { type: "reference", targets: ["世界"], required: true, visibility: "gm" },
        bag: {
          type: "list",
          mutable: true,
          item: {
            type: "object",
            instance: { referenceField: "item", stateField: "state" },
            fields: { item: { type: "reference", targets: ["物品"], required: true } },
          },
        },
      },
    }),
  );
  await writeFile(
    join(f.module, "物品/计时器.json"),
    JSON.stringify({
      quantity: 1,
      instance: {
        fields: {
          budget: { type: "number", required: true, mutable: true },
          end: { type: "number", mutable: true },
          secret: { type: "text", mutable: true, visibility: "gm" },
          fixed: { type: "text", required: true },
          remaining: {
            type: "number",
            compute:
              "$item.end == null ? $item.budget : max(0, $item.end - load($self.world).position.x)",
          },
          lit: { type: "boolean", compute: "$item.end != null && $item.remaining > 0" },
        },
        display: ["remaining", "lit"],
      },
    }),
  );
  await writeFile(
    join(f.module, "持有者/甲.json"),
    JSON.stringify({
      world: "世界/当前世界",
      bag: [
        { item: "物品/计时器", state: { budget: 20, secret: "幕后", fixed: "甲号" } },
        { item: "物品/计时器", state: { budget: 30, fixed: "乙号" } },
      ],
    }),
  );
  await writeFile(
    join(f.module, "持有者/乙.json"),
    JSON.stringify({ world: "世界/当前世界", bag: [] }),
  );
  const room = await createSession(f.sessions, f.module, "实例状态测试");
  return { ...f, room };
}

test("实例的点燃、熄灭等待、重燃、转交和恢复保持独立状态，玩家只收到公开摘要", async () => {
  const f = await instanceRoomFixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const read = async (path = "持有者/甲") =>
    (await readGameDocumentView(db, game, path, true)).values!.bag as any[];
  await updateGameDocument(db, game, {
    path: "持有者/甲",
    changes: [{ op: "set", path: "/bag/0/state/end", value: 20 }],
  });
  await updateGameDocument(db, game, {
    path: "世界/当前世界",
    changes: [{ op: "set", path: "/position/x", value: 7 }],
  });
  assert.equal((await read())[0].state.remaining, 13);
  assert.equal((await read())[1].state.remaining, 30);
  await batchUpdateGameDocuments(db, game, {
    updates: [
      {
        path: "持有者/甲",
        patch: [
          { op: "replace", path: "/bag/0/state/budget", value: 13 },
          { op: "remove", path: "/bag/0/state/end" },
        ],
      },
    ],
  });
  await updateGameDocument(db, game, {
    path: "世界/当前世界",
    changes: [{ op: "set", path: "/position/x", value: 40 }],
  });
  assert.equal((await read())[0].state.remaining, 13);
  assert.equal((await read())[0].state.lit, false);
  await updateGameDocument(db, game, {
    path: "持有者/甲",
    changes: [{ op: "set", path: "/bag/0/state/end", value: 53 }],
  });
  await batchUpdateGameDocuments(db, game, {
    updates: [
      { path: "持有者/甲", patch: [{ op: "remove", path: "/bag/0" }] },
      {
        path: "持有者/乙",
        patch: [
          {
            op: "add",
            path: "/bag/-",
            value: {
              item: "物品/计时器",
              state: { budget: 13, end: 53, secret: "幕后", fixed: "甲号" },
            },
          },
        ],
      },
    ],
  });
  assert.equal((await read())[0].state.budget, 30);
  assert.equal((await read("持有者/乙"))[0].state.remaining, 13);
  const projected = (await readGameDocumentView(db, game, "持有者/乙")).values!.bag as any[];
  assert.equal(projected[0].state.secret, undefined);
  assert.equal(projected[0].$instance.display[0].value, 13);
  const hostRead = (await readGamePath(db, game, "持有者/乙")) as any;
  assert.equal(hostRead.content.bag[0].state.remaining, 13);
  assert.equal(hostRead.content.bag[0].state.secret, "幕后");
  assert.equal(hostRead.content.bag[0].$instance, undefined);
  const explicit = (await readGamePath(db, game, "持有者/乙", ["/bag/0/$instance/display"])) as any;
  assert.equal(explicit.content["/bag/0/$instance/display"][0].value, 13);
  const companionTools = createCompanionDocumentTools(dirname(game), new AbortController().signal);
  const companionRead = companionTools.find((tool) => tool.name === "read")!;
  const publicDocument = await readGameDocumentView(db, game, "持有者/乙");
  const result = await companionRead.execute(
    "instance",
    { id: publicDocument.id },
    undefined,
    undefined,
    undefined as never,
  );
  const serialized = (result.content[0] as { text: string }).text;
  const companionView = JSON.parse(serialized);
  assert.equal(companionView.values.bag[0].state.remaining, 13);
  assert.equal(companionView.values.bag[0].state.lit, true);
  assert.equal(companionView.values.bag[0].state.secret, undefined);
  assert.ok(!serialized.includes("幕后"));
  assert.equal(serialized, JSON.stringify(companionView));

  const disk = await readFile(join(game, "持有者/乙.json"), "utf8");
  assert.equal(disk.includes("remaining"), false);
  assert.equal(disk.includes("$instance"), false);
  forgetGameDocumentViews(game);
  forgetStateVersions(game);
  assert.equal((await read("持有者/乙"))[0].state.end, 53);
  assert.equal((await read("持有者/乙"))[0].state.remaining, 13);
  await updateGameDocument(db, game, {
    path: "世界/当前世界",
    changes: [{ op: "set", path: "/position/x", value: 53 }],
  });
  assert.equal((await read("持有者/乙"))[0].state.remaining, 0);
  assert.equal((await read("持有者/乙"))[0].state.lit, false);
});

test("实例权限约束普通更新、容器替换和批量 Patch，失败不保存部分状态", async () => {
  const f = await instanceRoomFixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const db = await openSessionDatabase(f.sessions, f.room.id);
  onTestFinished(() => db.close());
  const game = gameDirectoryForDatabase(db);
  const update = (path: string, value: unknown, publicOnly = false) =>
    updateGameDocument(db, game, {
      path: "持有者/甲",
      publicOnly,
      changes: [{ op: "set", path, value }],
    });
  await assert.rejects(update("/bag/0/state/secret", "泄露", true), /非公开/);
  await assert.rejects(update("/bag/0/state/remaining", 100), /可修改/);
  await assert.rejects(
    update("/bag/0/state", { budget: 20, fixed: "甲号", remaining: 100 }),
    /实例字段不可修改|计算|never/,
  );
  await assert.rejects(update("/bag/0/state", { budget: 20, fixed: "伪造" }), /实例字段不可修改/);
  await assert.rejects(update("/bag/0/state", { budget: 20, fixed: "甲号" }, true), /整体覆盖/);
  await assert.rejects(
    update("/bag", [{ item: "物品/计时器", state: { budget: 20, fixed: "伪造" } }]),
    /实例字段不可修改/,
  );
  await assert.rejects(
    update("/bag", [{ item: "物品/计时器", state: { budget: 20, fixed: "甲号", mystery: 3 } }]),
    /mystery|Unrecognized/,
  );
  await assert.rejects(
    update("/bag", [{ item: "物品/计时器", state: { fixed: "甲号" } }]),
    /budget/,
  );
  await assert.rejects(
    batchUpdateGameDocuments(db, game, {
      updates: [
        {
          path: "世界/当前世界",
          patch: [{ op: "replace", path: "/position/x", value: 10 }],
        },
        {
          path: "持有者/甲",
          patch: [{ op: "replace", path: "/bag/0/state/remaining", value: 100 }],
        },
      ],
    }),
    /可修改/,
  );
  assert.equal(
    (await readGameDocumentView(db, game, "世界/当前世界", true)).values!.position &&
      ((await readGameDocumentView(db, game, "世界/当前世界", true)).values!.position as any).x,
    0,
  );
  await update("/bag/0/state/budget", 18, true);
  assert.equal(
    ((await readGameDocumentView(db, game, "持有者/甲")).values!.bag as any[])[0].state.remaining,
    18,
  );
});
