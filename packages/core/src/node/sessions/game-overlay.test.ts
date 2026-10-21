import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { createGameTools } from "../agent/game-tools";
import { readCharacters } from "./character-db";
import {
  gameFolderIndex,
  batchUpdateGameDocuments,
  readGamePath,
  readStateDocument,
  updateGameDocument,
  writeGameDocument,
} from "./game-state";
import { createSession, openSessionDatabase } from "./session-store";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-overlay-"));
  const source = join(root, "source");
  await mkdir(join(source, ".types"), { recursive: true });
  await writeFile(
    join(source, "module.toml"),
    'name = "覆盖测试"\ndescription = "差异存档"\npages = ["玩家手册.md"]\n',
  );
  await writeFile(
    join(source, ".types/角色.fields.json"),
    JSON.stringify({
      designation: "character",
      fields: {
        hp: { type: "number", mutable: true },
        note: { type: "text", mutable: true },
        lore: { type: "text" },
        bag: { type: "list", mutable: true, item: { type: "text" } },
        stats: {
          type: "object",
          fields: { score: { type: "number", mutable: true }, label: { type: "text" } },
        },
        doubled: { type: "number", compute: "$self.hp * 2" },
      },
    }),
  );
  await writeFile(
    join(source, ".types/线索.fields.toml"),
    '[fields.seen]\ntype = "boolean"\nmutable = true\n',
  );
  await writeFile(
    join(source, ".types/线索.layout.toml"),
    'detail = { type = "grid", fields = ["seen"] }\n',
  );
  await writeFile(join(source, "玩家手册.md"), "# 玩家手册\n按顺序行动。\n");
  const base = {
    name: "旅人",
    hp: 10,
    note: "可删除",
    lore: "旧设定",
    bag: ["绳子", "火把"],
    stats: { score: 1, label: "旧标签" },
  };
  await writeFile(join(source, "角色/旅人.json"), JSON.stringify(base));
  await writeFile(join(source, "线索/纸条.md"), "---\nseen: false\n---\n旧正文\n");
  const sessions = join(root, "sessions");
  const room = await createSession(sessions, source, "测试");
  const directory = join(sessions, room.id),
    game = join(directory, "game"),
    module = join(directory, "module");
  const db = await openSessionDatabase(sessions, room.id);
  return {
    root,
    db,
    game,
    module,
    directory,
    base,
    async cleanup() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("新房间不复制 game；更新只保存差异，基础更新与计算字段、角色读取一致", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readdir(f.game), []);
    await updateGameDocument(f.db, f.game, {
      path: "角色/旅人.md",
      changes: [
        { op: "set", path: "/hp", value: 6 },
        { op: "set", path: "/stats/score", value: 3 },
        { op: "set", path: "/bag", value: [] },
        { op: "remove", path: "/note" },
      ],
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.game, "角色/旅人.json"), "utf8")), {
      $overlay: 1,
      values: { hp: 6, bag: [], stats: { score: 3 } },
      removed: ["/note"],
    });
    await chmod(join(f.module, "角色/旅人.json"), 0o600);
    await writeFile(
      join(f.module, "角色/旅人.json"),
      JSON.stringify({ ...f.base, hp: 20, lore: "新设定", stats: { score: 2, label: "新标签" } }),
    );
    const { content } = await readStateDocument(f.db, f.game, "角色/旅人.json");
    assert.equal(content.hp, 6);
    assert.equal(content.lore, "新设定");
    assert.deepEqual(content.stats, { score: 3, label: "新标签" });
    assert.deepEqual(content.bag, []);
    assert.equal(Object.hasOwn(content, "note"), false);
    assert.equal(readCharacters(f.db)[0].values.lore, "新设定");
    assert.equal(((await readGamePath(f.db, f.game, "角色/旅人.json")) as any).content.doubled, 12);
    const canonical = await readGamePath(f.db, f.game, "角色/旅人.json");
    for (const path of ["角色/旅人", "/角色/旅人.toml", "角色/旅人.md"])
      assert.deepEqual(await readGamePath(f.db, f.game, path), canonical);
    assert.equal(
      (await readStateDocument(f.db, f.game, "角色/旅人.toml")).id,
      readCharacters(f.db)[0].id,
    );
    await assert.rejects(
      batchUpdateGameDocuments(f.db, f.game, {
        updates: [
          { path: "角色/旅人", patch: [{ op: "replace", path: "/hp", value: 4 }] },
          { path: "角色/旅人.toml", patch: [{ op: "replace", path: "/hp", value: 2 }] },
        ],
      }),
      /重复修改/,
    );
    assert.deepEqual(await readGamePath(f.db, f.game, "角色/旅人.md"), canonical);
    await assert.rejects(
      updateGameDocument(f.db, f.game, {
        path: "角色/旅人.json",
        changes: [{ op: "set", path: "/lore", value: "越权" }],
      }),
      /可修改/,
    );
  } finally {
    await f.cleanup();
  }
});

test("Markdown 编译后只存 JSON 字段覆盖，搜索解码正文并包含新增文件", async () => {
  const f = await fixture();
  try {
    await updateGameDocument(f.db, f.game, {
      path: "线索/纸条.md",
      changes: [{ op: "set", path: "/seen", value: true }],
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.game, "线索/纸条.json"), "utf8")), {
      $overlay: 1,
      values: { seen: true },
      removed: [],
    });
    await chmod(join(f.module, "线索/纸条.json"), 0o600);
    await writeFile(
      join(f.module, "线索/纸条.json"),
      JSON.stringify({ seen: false, body: "长前文".repeat(300) + "\n新正文\n后文\n" }),
    );
    const read = (await readGamePath(f.db, f.game, "线索/纸条.md")) as any;
    assert.equal(read.content.seen, true);
    assert.match(read.content.body, /新正文/);
    await writeGameDocument(f.db, f.game, {
      path: "角色/新增/同伴",
      content: { name: "搜索独有词", hp: 3 },
    });
    const tools = await createGameTools(f.directory, new AbortController().signal);
    const execute = async (name: string, args: unknown) =>
      JSON.stringify(
        await tools
          .find((t) => t.name === name)!
          .execute("test", args, undefined, undefined, {} as any),
      );
    assert.match(await execute("find", { path: "角色", pattern: "*.json" }), /同伴/);
    assert.match(await execute("find", { path: "角色", pattern: "*.json" }), /旅人/);
    assert.match(await execute("grep", { pattern: "新正文" }), /新正文/);
    assert.match(
      await execute("grep", { path: "线索/纸条.toml", pattern: "^新正文$", context: 1 }),
      /后文/,
    );
    assert.match(await execute("grep", { pattern: "搜索独有词" }), /同伴/);
    assert.match(await execute("grep", { path: "角色/新增", pattern: "搜索独有词" }), /同伴/);
    assert.match(await execute("grep", { path: ".", pattern: "搜索独有词" }), /同伴/);
    assert.doesNotMatch(await execute("grep", { pattern: "旧正文" }), /纸条/);
  } finally {
    await f.cleanup();
  }
});

test("主持文件工具仅披露文档和字段定义，准确配置路径也不能绕过限制", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.game, ".types"));
    await mkdir(join(f.game, "配置"));
    await mkdir(join(f.game, "混合/深层"), { recursive: true });
    const excluded = [
      "module.json",
      "module.json",
      ".types/角色.layout.json",
      ".types/未知.fields.json",
      "配置/设置.json",
      "混合/深层/说明.txt",
      "插图.webp",
      "未知/未登记.json",
    ];
    for (const path of excluded.filter((path) => path !== "module.json"))
      await writeFile(join(f.game, path), "配置独有词");
    // 基础模组中的配置也不应被查询；保留原文件，不修改只读副本。
    const tools = await createGameTools(f.directory, new AbortController().signal);
    const execute = async (name: string, args: unknown) => {
      const result = await tools
        .find((tool) => tool.name === name)!
        .execute("test", args, undefined, undefined, {} as any);
      return (result.content[0] as { text: string }).text;
    };
    for (const path of excluded) {
      await assert.rejects(execute("read", { path }), /只能查阅/);
      await assert.rejects(execute("grep", { path, pattern: "." }), /只能查阅/);
    }
    for (const name of ["read", "find", "grep"]) {
      const args =
        name === "read"
          ? { path: "配置" }
          : name === "find"
            ? { path: "配置", pattern: "*" }
            : { path: "配置", pattern: "." };
      await assert.rejects(execute(name, args), /只能查阅/);
    }
    const root = JSON.parse(await execute("read", { path: "/" }));
    assert.deepEqual(root.entries, [".types/", "线索/", "角色/"]);
    const definitions = JSON.parse(await execute("read", { path: ".types" }));
    assert.deepEqual(definitions.entries, ["线索.fields.json", "角色.fields.json"]);
    const definition = JSON.parse(await execute("read", { path: ".types/角色.fields.json" }));
    assert.equal(definition.readonly, true);
    assert.equal(definition.content.fields.hp.mutable, true);
    assert.match(await execute("grep", { path: ".types", pattern: "mutable" }), /角色.fields.json/);
    assert.doesNotMatch(
      await execute("grep", { pattern: "配置独有词|覆盖测试" }),
      /配置独有词|覆盖测试/,
    );
    const found = await execute("find", { pattern: "**/*", limit: 1000 });
    const index = await gameFolderIndex(f.game, f.db);
    for (const path of excluded) {
      assert.ok(!found.includes(path), path);
      assert.ok(!index.includes(path), path);
    }
    assert.ok(!found.includes("配置/"));
    assert.ok(!found.includes("混合/"));
    assert.match(found, /角色.fields.json/);
    // 允许范围不能固化在工具创建时：后续新建文档立即可查。
    await writeGameDocument(f.db, f.game, {
      path: "角色/混合/深层/同伴.toml",
      content: { name: "本局搜索词", hp: 3 },
    });
    assert.match(await execute("find", { path: "角色/混合", pattern: "*.json" }), /深层\/同伴/);
    assert.match(await execute("grep", { path: "角色/混合", pattern: "本局搜索词" }), /同伴/);
    assert.deepEqual(JSON.parse(await execute("read", { path: "角色/混合/深层" })).entries, [
      "同伴.json",
    ]);
    const character = JSON.parse(await execute("read", { path: "角色/混合/深层/同伴" }));
    assert.equal(character.content.hp, 3);
    assert.equal(character.content.doubled, 6);
    // 定义可查但不可写，图片展示不通过文件工具读取。
    await assert.rejects(
      execute("update", {
        path: ".types/角色.fields.json",
        patch: [{ op: "replace", path: "/fields/hp/mutable", value: false }],
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("创建冒险编译配置、布局和 Markdown，原模组与阅读页保持原内容且副本只读", async () => {
  const f = await fixture();
  onTestFinished(() => f.cleanup());
  assert.deepEqual(JSON.parse(await readFile(join(f.module, "线索/纸条.json"), "utf8")), {
    seen: false,
    body: "旧正文\n",
  });
  for (const path of ["module", ".types/线索.fields", ".types/线索.layout", "线索/纸条"]) {
    const file = join(f.module, `${path}.json`);
    JSON.parse(await readFile(file, "utf8"));
    assert.equal((await lstat(file)).mode & 0o222, 0);
    await assert.rejects(
      access(join(f.module, `${path}.${path === "线索/纸条" ? "md" : "toml"}`)),
      /ENOENT/,
    );
  }
  assert.equal(
    await readFile(join(f.root, "source/线索/纸条.md"), "utf8"),
    "---\nseen: false\n---\n旧正文\n",
  );
  assert.equal(
    await readFile(join(f.root, "source/module.toml"), "utf8"),
    'name = "覆盖测试"\ndescription = "差异存档"\npages = ["玩家手册.md"]\n',
  );
  assert.equal(await readFile(join(f.module, "玩家手册.md"), "utf8"), "# 玩家手册\n按顺序行动。\n");
  const created = await writeGameDocument(f.db, f.game, {
    path: "线索/新线索.md",
    content: { seen: false, body: "新正文" },
  });
  assert.equal(created.path, "线索/新线索.json");
  await assert.rejects(
    writeGameDocument(f.db, f.game, {
      path: "线索/新线索.toml",
      content: { seen: true },
    }),
    /已存在/,
  );
  await mkdir(join(f.root, "source/线索/纸条.json"));
  await assert.rejects(
    createSession(join(f.root, "sessions"), join(f.root, "source"), "冲突副本"),
    /JSON 路径冲突/,
  );
  assert.deepEqual(await readdir(join(f.root, "sessions")), [basename(f.directory)]);
  assert.equal(
    await readFile(join(f.root, "source/线索/纸条.md"), "utf8"),
    "---\nseen: false\n---\n旧正文\n",
  );
});

test("拒绝手工写入只读覆盖、悬空链接和失去基础的覆盖文件", async () => {
  const f = await fixture();
  try {
    const path = join(f.game, "角色/旅人.json");
    await writeFile(path, JSON.stringify({ $overlay: 1, values: { lore: "越权" }, removed: [] }));
    await assert.rejects(readStateDocument(f.db, f.game, "角色/旅人.json"), /可修改/);
    await rm(path);
    await symlink(join(f.root, "missing"), path);
    await assert.rejects(readStateDocument(f.db, f.game, "角色/旅人.json"), /符号链接/);
    await rm(path);
    await writeFile(path, JSON.stringify({ $overlay: 1, values: { hp: 3 }, removed: [] }));
    await rm(join(f.module, "角色/旅人.json"));
    await assert.rejects(readStateDocument(f.db, f.game, "角色/旅人.json"), /缺少基础/);
  } finally {
    await f.cleanup();
  }
});
