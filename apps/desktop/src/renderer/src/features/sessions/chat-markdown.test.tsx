import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

import { allowDocumentMediaRoots, resolveMediaRequestFile } from "../../../../main/media-path";
import { DocumentImageScope } from "../modules/document-image";
import { documentMarkdownPlugins } from "../modules/document-markdown";
import { DocumentReferences } from "../modules/DocumentReferences";
import { remarkChatEmphasis } from "./chat-markdown";
import { ChatMarkdown } from "./ChatMarkdown";

const plugins = [remarkChatEmphasis, ...documentMarkdownPlugins];

test("聊天中文图片在房间索引没有 image 时仍能解析到本地文件", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tarp-chat-image-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "地点"));
  const file = join(root, "地点/石廊.webp");
  await writeFile(file, "场景图片");
  const scope = `room:${root}`;
  allowDocumentMediaRoots(scope, [root]);
  const html = renderToStaticMarkup(
    <DocumentImageScope scope={scope}>
      <DocumentReferences
        documents={[{ path: "地点/石廊.json", title: "石廊", valid: true }]}
        types={[]}
        view="game"
      >
        <ChatMarkdown streaming>
          {"火光照亮石廊。\n\n![石廊场景参考](地点/石廊.webp)\n\n深处传来回声。"}
        </ChatMarkdown>
      </DocumentReferences>
    </DocumentImageScope>,
  );
  const src = /<img[^>]*src="([^"]+)"/u.exec(html)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(src, "聊天正文应展示图片");
  assert.equal(new URL(src).searchParams.get("image"), "地点/石廊.webp");
  assert.equal(await resolveMediaRequestFile(src), file);
  assert.ok(html.includes('aria-label="放大查看石廊场景参考"'));
  assert.ok(html.includes("深处传来回声。"));
});

function render(text: string) {
  return renderToStaticMarkup(
    <Markdown skipHtml remarkPlugins={plugins}>
      {text}
    </Markdown>,
  );
}

test("聊天中文加粗兼容内侧空格与相邻标点，已完成历史和流式正文使用相同显示", () => {
  const source = "光照见一排木板。 **第三块木板，比周围略低一点。 **更远处看不清。";
  const html = render(source);
  assert.ok(html.includes("<strong>第三块木板，比周围略低一点。</strong> 更远处看不清。"));
  assert.ok(!html.includes("**"));
  assert.equal(render("正文**“重点。”**后文"), "<p>正文<strong>“重点。”</strong>后文</p>");
  assert.equal(render("** 重要信息 **随后继续。"), "<p> <strong>重要信息</strong> 随后继续。</p>");
  assert.equal(render("**标准加粗**和普通文字"), "<p><strong>标准加粗</strong>和普通文字</p>");
});

test("兼容加粗保留资料引用和原有 Markdown，代码、转义及实体标记仍是字面文本", () => {
  const linked = render("**查看[[规则/测试]]。 **继续。\n\n- ~~失效~~\n- *斜体*");
  assert.ok(
    linked.includes(
      `<strong>查看<a href="${encodeURI("规则/测试")}" data-document-reference="wiki">规则/测试</a>。</strong> 继续。`,
    ),
  );
  assert.ok(linked.includes("<del>失效</del>"));
  assert.ok(linked.includes("<em>斜体</em>"));
  const literal = render(
    "`**代码。 **`\n\n```text\n**代码块。 **\n```\n\n\\*\\*字面。 \\*\\*\n\n&#42;&#42;实体。 &#42;&#42;\n\n** English **",
  );
  assert.ok(!literal.includes("<strong>"));
  assert.ok(literal.includes("<code>**代码。 **</code>"));
  assert.ok(literal.includes("**代码块。 **"));
  assert.ok(literal.includes("**字面。 **"));
  assert.ok(literal.includes("**实体。 **"));
  assert.ok(literal.includes("** English **"));
  assert.ok(!render("*** 中文。 ***").includes("<strong>"));
});

test("聊天流式渲染补全加粗与链接，完成后保留原文，资料引用和表格正常展示", () => {
  const renderChat = (text: string, streaming = false) =>
    renderToStaticMarkup(<ChatMarkdown streaming={streaming}>{text}</ChatMarkdown>);
  const bold = renderChat("**重要信息", true);
  assert.match(bold, /<strong[^>]*>重要信息<\/strong>/u);
  assert.ok(!bold.includes("**"));
  assert.ok(renderChat("**重要信息").includes("**重要信息"));
  const link = renderChat("前文[查看资料](https://example.com/pa", true);
  assert.ok(link.includes("查看资料"));
  assert.ok(!link.includes("](https://"));
  const source =
    "正文**“重点。”**后文\n\n**查看[[规则/测试]]。 **继续。\n\n| 名称 | 数值 |\n| --- | --- |\n| 测试 | 1 |";
  for (const streaming of [true, false]) {
    const html = renderChat(source, streaming);
    assert.match(html, /<strong[^>]*>“重点。”<\/strong>/u);
    assert.ok(html.includes("测试"));
    assert.ok(!html.includes("[["));
    assert.ok(html.includes("<table"));
    assert.ok(!renderChat("<script>alert(1)</script>", streaming).includes("<script"));
  }
});
