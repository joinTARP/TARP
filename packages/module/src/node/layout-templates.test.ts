import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile } from "../testing/files";
import { loadDocumentTypes } from "./document-types";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-template-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeTestFile(
    join(root, ".types/角色.fields.json"),
    JSON.stringify({ fields: { hp: { type: "number" } } }),
  );
  await writeTestFile(
    join(root, ".types/panel.hbs"),
    "<h2>{{name}}</h2>{{> status}}<p>{{values.hp}}</p>",
  );
  await writeTestFile(join(root, ".types/status.hbs"), "<p>生命 {{values.hp}}</p>");
  await writeTestFile(join(root, ".types/panel.css"), "h2 { text-align: center; }");
  const writeLayout = async (rootNode: unknown) =>
    writeTestFile(
      join(root, ".types/角色.layout.json"),
      JSON.stringify({
        detail: rootNode,
        sheet: rootNode,
        card: { content: rootNode },
        hover: { width: "lg", content: rootNode },
      }),
    );
  return { root, writeLayout };
}

test("加载 hbs、CSS 与局部模板并冻结到布局，重新加载读取新内容", async () => {
  const f = await fixture();
  await f.writeLayout({
    type: "handlebars",
    templateFile: ".types/panel.hbs",
    styleFile: ".types/panel.css",
    partialFiles: { status: ".types/status.hbs" },
  });
  const [type] = await loadDocumentTypes(f.root);
  assert.match(type.layout!.sheet!.template!, /{{name}}/);
  assert.equal(type.layout!.sheet!.css, "h2 { text-align: center; }");
  assert.match(type.layout!.sheet!.partials!.status, /values.hp/);
  assert.equal(type.layout!.card!.content!.template, type.layout!.sheet!.template);
  assert.equal(type.layout!.hover!.content!.css, type.layout!.sheet!.css);
  assert.equal(type.layout!.hover!.width, "lg");
  assert.ok(!JSON.stringify(type.layout).includes("templateFile"));
  await writeTestFile(join(f.root, ".types/panel.hbs"), "<p>新模板</p>");
  const [changed] = await loadDocumentTypes(f.root);
  assert.equal(changed.layout!.sheet!.template, "<p>新模板</p>");
  assert.match(type.layout!.sheet!.template!, /{{name}}/);
});

test("加载拒绝缺失、冲突、越界及符号链接模板，并指出布局文件", async () => {
  const f = await fixture();
  await writeTestFile(join(f.root, "outside.hbs"), "<p>外部模板</p>");
  await symlink(join(f.root, "outside.hbs"), join(f.root, ".types/inside.hbs"));
  const outside = await mkdtemp(join(tmpdir(), "tarp-template-outside-"));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  await writeTestFile(join(outside, "panel.hbs"), "不可读取");
  await symlink(join(outside, "panel.hbs"), join(f.root, ".types/outside.hbs"));
  for (const node of [
    { type: "handlebars", templateFile: "../escape.hbs" },
    { type: "handlebars", templateFile: ".types/missing.hbs" },
    { type: "handlebars", templateFile: ".types/outside.hbs" },
    { type: "handlebars", template: "固定", templateFile: ".types/panel.hbs" },
    { type: "handlebars", template: "固定", css: "", styleFile: ".types/panel.css" },
    { type: "handlebars", template: "{{#if name}}" },
    { type: "handlebars", template: '<tarp-image field="missing"></tarp-image>' },
    { type: "handlebars", template: "<script>alert(1)</script>" },
    { type: "handlebars", template: '<img src="ok" onerror="alert(1)">' },
    { type: "handlebars", template: "{{unknown name}}" },
  ]) {
    await f.writeLayout(node);
    await assert.rejects(loadDocumentTypes(f.root), /角色.layout.json/);
  }
  await f.writeLayout({ type: "handlebars", templateFile: ".types/inside.hbs" });
  assert.equal((await loadDocumentTypes(f.root))[0].layout!.sheet!.template, "<p>外部模板</p>");
});
