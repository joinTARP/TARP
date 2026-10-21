import { describe, it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { loadModuleDocuments } from "./module-documents";
import { loadModuleMetadata } from "./module-metadata";
import { loadModulePages } from "./module-pages";

describe("模组元数据", () => {
  it("元数据缺失或无效时拒绝加载，合法数据保留封面和头像引用", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarp-module-metadata-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(loadModuleMetadata(root), { code: "ENOENT" });
    for (const { value, error } of [
      {
        value: { name: "雾港", description: "简介", unknown: true },
        error: /module\.json\.根节点/,
      },
      { value: { name: "", description: "简介" }, error: /module\.json\.name/ },
      {
        value: {
          name: "雾港",
          description: "简介",
          tts: {
            characters: {
              "角色/旅人.md": { description: "低沉" },
              "角色/旅人.toml": { description: "清亮" },
            },
          },
        },
        error: /同一角色不能配置多个音色/,
      },
    ]) {
      await writeFile(join(root, "module.json"), JSON.stringify(value));
      await assert.rejects(loadModuleMetadata(root), error);
    }
    const metadata = {
      name: "雾港",
      description: "一场发生在海雾中的冒险。",
      cover: "封面.svg",
      host: { name: "引路人", avatar: "未生成的头像.svg" },
      system: "Cairn 2e",
      tags: ["海港"],
    };
    await writeFile(join(root, "module.json"), JSON.stringify(metadata));
    assert.deepEqual(await loadModuleMetadata(root), metadata);
  });

  it("阅读页按 module.json 的文件列表载入，不进入文档", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarp-module-metadata-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "module.json"),
      JSON.stringify({
        name: "雾港",
        description: "一场发生在海雾中的冒险。",
        pages: ["概览.md", "手册/玩家手册.md"],
      }),
      "utf8",
    );
    await writeFile(join(root, "概览.md"), "---\nname: 概览\n---\n\n雾从码头上来。\n", "utf8");
    await mkdir(join(root, "手册"));
    await writeFile(join(root, "手册/玩家手册.md"), "坐下就可以开始。\n", "utf8");

    const metadata = await loadModuleMetadata(root);
    assert.deepEqual(await loadModulePages(root, metadata.pages!), [
      { path: "概览.md", title: "概览", body: "雾从码头上来。" },
      { path: "手册/玩家手册.md", title: "玩家手册", body: "坐下就可以开始。" },
    ]);
    assert.deepEqual(await loadModuleDocuments(root, []), []);
    await assert.rejects(loadModulePages(root, ["../秘密.md"]), /模组目录内/);
  });
});
