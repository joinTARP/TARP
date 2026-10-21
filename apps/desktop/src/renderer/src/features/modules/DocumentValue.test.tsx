import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { DocumentField } from "@tarp/module/document-type";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import { DocumentReferences } from "./DocumentReferences";
import { DocumentValue } from "./DocumentValue";
import { FieldTable } from "./FieldTable";

async function render(value: ReactNode) {
  const stream = await renderToReadableStream(value);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

test("房间引用按完整路径匹配快照，显示文档标题和弹框入口，缺失引用不伪造链接", async () => {
  const html = await render(
    <DocumentReferences
      documents={[
        { path: "物品/短剑.json", title: "旧短剑", valid: true },
        { path: "物品/别处/短剑.json", title: "不应误匹配", valid: true },
        { path: "过往/佣兵.md", title: "佣兵", valid: true },
      ]}
      types={[]}
    >
      <DocumentValue
        value={["物品/短剑", "过往/佣兵", "物品/缺失", "地点/墓门|墓门", "<script>危险</script>"]}
        definition={{ type: "list", item: { type: "reference" } }}
      />
    </DocumentReferences>,
  );
  assert.ok(html.includes(">旧短剑</button>"));
  assert.ok(html.includes(">佣兵</button>"));
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 2);
  assert.ok(!html.includes("不应误匹配"));
  assert.ok(html.includes("<span>物品/缺失</span>"));
  assert.ok(html.includes("<span>地点/墓门|墓门</span>"));
  assert.ok(!html.includes("未找到对应文档"));
  assert.ok(!html.includes('title="'));
  assert.ok(!html.includes("<script>"));
});

const field = (key: string, label: string, type: DocumentField["type"]): DocumentField => ({
  key,
  label,
  type,
  required: false,
  mutable: false,
  visibility: "public",
});

test("同行伙伴列表与嵌套描述渲染 Markdown，过滤原始 HTML 与危险链接", async () => {
  const companion =
    "**黑腿花马**。健壮且适应性强。**艰难**或**危险**地形的难度降低一级。6 HP。+4 格。";
  const html = await render(
    <DocumentValue value={[companion]} definition={{ type: "list", item: { type: "text" } }} />,
  );
  for (const word of ["黑腿花马", "艰难", "危险"])
    assert.ok(html.includes(`<strong>${word}</strong>`));
  assert.ok(!html.includes("**"));
  const nested = await render(
    <DocumentValue
      value={{
        description:
          "*效果*\n\n- ~~失效~~\n- 正常\n\n<script>alert(1)</script>\n\n[链接](javascript:alert)",
      }}
      definition={{ type: "object", fields: [field("description", "描述", "text")] }}
    />,
  );
  assert.ok(nested.includes("<em>效果</em>"));
  assert.ok(nested.includes("<del>失效</del>"));
  assert.ok(nested.includes("<ul>"));
  assert.ok(!nested.includes("<script>"));
  assert.ok(!nested.includes("javascript:"));
});

test("嵌套对象递归使用字段定义，空列表有提示，null 字段按显式配置隐藏", async () => {
  const html = await render(
    <DocumentValue
      value={{
        attributes: {
          strength: 12,
          range: { minimum: 3, maximum: 6 },
          hidden: "未声明的内容",
        },
        equipment: [],
        notes: null,
      }}
      definition={{
        type: "object",
        fields: [
          {
            ...field("attributes", "属性", "object"),
            fields: [
              field("strength", "力量", "number"),
              {
                ...field("range", "数量范围", "object"),
                fields: [field("minimum", "最少", "number"), field("maximum", "最多", "number")],
              },
            ],
          },
          { ...field("equipment", "装备", "list"), item: { type: "text" } },
          { ...field("notes", "备注", "text"), hideWhenEmpty: true },
        ],
      }}
    />,
  );
  for (const text of [
    "属性",
    "力量",
    ">12<",
    "数量范围",
    "最少",
    ">3<",
    "最多",
    ">6<",
    "装备",
    "暂无",
  ])
    assert.ok(html.includes(text));
  assert.ok(!html.includes("strength"));
  assert.ok(!html.includes("未声明的内容"));
  assert.ok(!html.includes("备注"));
  assert.ok((await render(<DocumentValue value={undefined} />)).includes("暂无数据"));
});

test("对象列表按声明的标签和单位展示，保留零与 false，不推断骰号或额外字段", async () => {
  const html = await render(
    <DocumentValue
      value={[
        {
          text: "**健壮**",
          price: 0,
          equipped: false,
          tasks: [{ bind: "equipment", value: { item: "不应出现" } }],
        },
        { text: "咖啡", price: 350, tasks: [] },
      ]}
      definition={{
        type: "list",
        item: {
          type: "object",
          fields: [
            field("text", "结果", "text"),
            field("price", "价格（日元）", "number"),
            field("equipped", "已装备", "boolean"),
          ],
        },
      }}
    />,
  );
  assert.ok(html.includes("<strong>健壮</strong>"));
  assert.ok(html.includes("咖啡"));
  assert.ok(!html.includes(">1<"));
  assert.ok(!html.includes(">2<"));
  assert.ok(html.includes("价格（日元）"));
  assert.ok(html.includes(">350<"));
  assert.ok(html.includes(">0<"));
  assert.ok(html.includes("已装备"));
  assert.ok(html.includes("否"));
  assert.ok(!html.includes("gp"));
  assert.ok(!html.includes("不应出现"));
  assert.ok(!html.includes("equipment"));
  assert.ok(html.includes("结果"));
});

test("嵌套对象与对象列表只隐藏配置为空的子字段，false 和空对象仍显示", async () => {
  const fields = [
    { ...field("zero", "隐藏零值", "number"), hideWhenEmpty: true },
    { ...field("text", "隐藏空文本", "text"), hideWhenEmpty: true },
    {
      ...field("list", "隐藏空列表", "list"),
      hideWhenEmpty: true,
      item: { type: "text" as const },
    },
    { ...field("active", "保留否值", "boolean"), hideWhenEmpty: true },
    {
      ...field("object", "保留空对象", "object"),
      hideWhenEmpty: true,
      fields: [field("note", "备注", "text")],
    },
  ];
  const value = { zero: 0, text: "", list: [], active: false, object: {} };
  for (const node of [
    <DocumentValue value={value} definition={{ type: "object", fields }} />,
    <DocumentValue
      value={[value]}
      definition={{ type: "list", item: { type: "object", fields } }}
    />,
  ]) {
    const html = await render(node);
    assert.doesNotMatch(html, /隐藏零值|隐藏空文本|隐藏空列表/);
    assert.match(html, /保留否值/);
    assert.match(html, /否/);
    assert.match(html, /保留空对象/);
  }
});

test("字段表格隐藏空数值单元格，保留布尔 false 与行记录", async () => {
  const list: DocumentField = {
    ...field("rows", "记录", "list"),
    item: {
      type: "object",
      fields: [
        field("id", "标识", "text"),
        { ...field("zero", "数值", "number"), hideWhenEmpty: true },
        { ...field("active", "开关", "boolean"), hideWhenEmpty: true },
      ],
    },
  };
  const html = await render(
    <FieldTable
      value={[{ id: "a", zero: 0, active: false }]}
      field={list}
      config={{
        type: "FieldTable",
        rowKey: "id",
        columns: [{ field: "zero" }, { field: "active" }],
      }}
    />,
  );
  assert.doesNotMatch(html, />0<|暂无数据/);
  assert.match(html, /数值/);
  assert.match(html, /否/);
});
