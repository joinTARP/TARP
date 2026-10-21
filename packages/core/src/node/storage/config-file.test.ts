import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig, stringifyConfig } from "@tarp/module/node/config-file";
import { loadDocumentTypes } from "@tarp/module/node/document-types";
import { loadModuleDocuments } from "@tarp/module/node/module-documents";
import { loadModuleMetadata } from "@tarp/module/node/module-metadata";
import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { createGameTools } from "../agent/game-tools";
import { createSession } from "../sessions/session-store";

test("JSON 与 TOML 元配置、字段定义及混合格式布局产生相同业务数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-config-formats-"));
  try {
    const results: unknown[] = [];
    for (const format of ["json", "toml"]) {
      const directory = join(root, format);
      await mkdir(join(directory, ".types"), { recursive: true });
      const config = (stem: string, value: Record<string, unknown>, extension = format) => {
        const path = join(directory, `${stem}.${extension}`);
        return writeFile(path, stringifyConfig(value, path));
      };
      await config("module", {
        name: "测试",
        description: "双格式",
        hostPrompt: "第一行\n第二行",
        pages: ["手册.md"],
      });
      await config(".types/角色.fields", {
        fields: { hp: { type: "number", mutable: true } },
      });
      await config(
        ".types/角色.layout",
        { detail: { type: "grid", fields: ["hp"] } },
        format === "json" ? "toml" : "json",
      );
      await writeFile(join(directory, "角色/角色.json"), JSON.stringify({ hp: 6 }));
      await writeFile(join(directory, "手册.md"), "# 游戏手册");
      const types = await loadDocumentTypes(directory);
      results.push({
        metadata: await loadModuleMetadata(directory),
        types,
        documents: await loadModuleDocuments(directory, types),
      });
      if (format === "toml") {
        const sessions = join(root, "sessions");
        const room = await createSession(sessions, directory, "TOML 房间");
        const tools = await createGameTools(join(sessions, room.id), new AbortController().signal);
        const found = await tools
          .find((tool) => tool.name === "grep")!
          .execute("test", { pattern: "双格式" }, undefined, undefined, {} as any);
        assert.doesNotMatch(JSON.stringify(found), /module\.toml|双格式/);
        const definitions = await tools
          .find((tool) => tool.name === "grep")!
          .execute("test", { path: ".types", pattern: "mutable" }, undefined, undefined, {} as any);
        assert.match(JSON.stringify(definitions), /角色\.fields\.json/);
        const definition = await tools
          .find((tool) => tool.name === "read")!
          .execute("test", { path: ".types/角色.fields.json" }, undefined, undefined, {} as any);
        const result = JSON.parse((definition.content[0] as { text: string }).text);
        assert.equal(result.readonly, true);
        assert.equal(result.content.fields.hp.mutable, true);
      }
    }
    assert.deepEqual(results[0], results[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同名双格式元配置、字段和布局均拒绝歧义", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-config-conflict-"));
  try {
    await mkdir(join(root, ".types"));
    await writeFile(join(root, "module.json"), '{"name":"测试","description":"测试"}');
    await writeFile(join(root, "module.toml"), 'name = "测试"\ndescription = "测试"');
    await assert.rejects(loadModuleMetadata(root), /配置冲突/);
    await writeFile(join(root, ".types/角色.fields.json"), "{}");
    await writeFile(join(root, ".types/角色.fields.toml"), "");
    await assert.rejects(loadDocumentTypes(root), /配置冲突/);
    await rm(join(root, ".types/角色.fields.toml"));
    await writeFile(join(root, ".types/角色.layout.json"), "{}");
    await writeFile(join(root, ".types/角色.layout.toml"), "");
    await assert.rejects(loadDocumentTypes(root), /配置冲突/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TOML 注释、中文键和多行文本可读，拒绝不安全键、日期对象和非有限数值", () => {
  assert.deepEqual(
    parseConfig('# 注释\n"名称" = "角色"\ntext = """第一行\n第二行"""', "module.toml"),
    { 名称: "角色", text: "第一行\n第二行" },
  );
  assert.throws(() => parseConfig("name = [", "module.toml"), /module.toml.*TOML/);
  assert.throws(() => parseConfig("a = inf", "module.toml"), /非有限/);
  assert.throws(() => parseConfig("a = 2026-09-29", "module.toml"), /日期时间/);
  for (const format of ["json", "toml"]) {
    const source =
      format === "json" ? '{"__proto__":{"polluted":true}}' : "__proto__.polluted = true";
    assert.throws(() => parseConfig(source, `test.${format}`));
  }
});
