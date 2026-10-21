import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { validateDocumentLayout, validateDocumentType } from "@tarp/module/document-type";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import { DocumentDetail } from "./DocumentDetail";

async function render(value: ReactNode) {
  const stream = await renderToReadableStream(value);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

test("布局字段全部缺失时不会展开其他字段或建卡资料", async () => {
  const type = validateDocumentType("人物", {
    fields: { hp: { type: "number" }, secret: { type: "text" } },
  });
  for (const detail of [
    { type: "grid", fields: ["hp"] },
    { type: "split", fields: ["hp"], contentFields: [] },
  ]) {
    const html = await render(
      <DocumentDetail
        documentType={{ ...type, layout: validateDocumentLayout(type, { detail }) }}
        document={{
          path: "人物/测试",
          title: "测试",
          valid: true,
          values: {
            secret: "不应展开的字段",
            creation: { entries: [{ text: "不应展开的表项" }], options: ["不应展开的姓名"] },
          },
        }}
      />,
    );
    assert.ok(!html.includes("不应展开"));
  }
});

test("双栏把图片与属性放在左侧，秘密与正文在右侧，支持无图和独立滚动", async () => {
  const type = validateDocumentType("人物", {
    fields: { hp: { type: "number", label: "HP" }, secret: { type: "text", label: "秘密" } },
  });
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: {
        type: "split",
        fields: ["hp"],
        contentFields: ["secret"],
        order: ["description", "fields", "body"],
      },
    }),
  };
  for (const scrollable of [false, true]) {
    for (const image of [undefined, "portrait.webp"]) {
      const html = await render(
        <DocumentDetail
          scrollable={scrollable}
          documentType={documentType}
          document={{
            path: "人物/沈莺.json",
            title: "沈莺",
            valid: true,
            image,
            description: "人物简介",
            body: "人物正文",
            values: { hp: 3, secret: "秘密内容" },
          }}
        />,
      );
      assert.equal((html.match(/秘密内容/g) ?? []).length, 1);
      assert.ok(html.indexOf("HP") < html.indexOf("人物简介"));
      assert.ok(html.indexOf("人物简介") < html.indexOf("秘密内容"));
      assert.ok(html.indexOf("秘密内容") < html.indexOf("人物正文"));
      assert.equal(html.includes("<img"), Boolean(image));
      assert.equal(html.includes('aria-label="放大查看沈莺"'), Boolean(image));
      assert.ok(html.includes("沈莺"));
      assert.equal(html.includes('aria-label="基础资料滚动区"'), scrollable);
      assert.equal(html.includes('aria-label="详细内容滚动区"'), scrollable);
    }
  }
});

const tableType = {
  ...validateDocumentType("随机表", {
    name: "随机表",
    fields: {
      creation: {
        type: "object",
        label: "建卡规则",
        fields: {
          entries: {
            type: "list",
            label: "表项",
            item: {
              type: "object",
              fields: {
                text: { type: "text", label: "结果" },
                price: { type: "number", label: "价格（gp）" },
              },
            },
          },
        },
      },
    },
  }),
};

const tableTypeWithLayout = {
  ...tableType,
  layout: validateDocumentLayout(tableType, {
    detail: {
      type: "grid",
      columns: 1,
      fields: ["creation.entries"],
    },
  }),
};

const document = {
  path: "随机表/体格.json",
  title: "体格",
  valid: true,
  values: {
    creation: {
      entries: [
        {
          text: "健壮",
          tasks: [{ id: "hidden", kind: "grant", title: "hidden", bind: "equipment", value: {} }],
        },
        { text: "肥胖" },
      ],
    },
  },
};

test("随机表详情列出表项正文，不把建卡任务铺到阅读界面", async () => {
  const html = await render(
    <DocumentDetail document={document} documentType={tableTypeWithLayout} />,
  );
  assert.ok(html.includes("表项"));
  assert.ok(html.includes("2 项"));
  assert.ok(html.includes("健壮"));
  assert.ok(html.includes("肥胖"));
  assert.ok(!html.includes("equipment"));
  assert.ok(!html.includes("hidden"));
});

test("未声明字段时只展示正文，不推断建卡选项、任务或表项", async () => {
  const html = await render(
    <DocumentDetail
      document={{
        path: "资料/示例.md",
        title: "示例",
        valid: true,
        body: "公开正文。",
        values: {
          creation: {
            options: ["隐藏选项"],
            tasks: [{ id: "hidden", title: "隐藏任务", bind: "equipment" }],
            entries: [{ text: "隐藏表项" }],
          },
        },
      }}
      documentType={validateDocumentType("资料", {})}
    />,
  );
  assert.ok(html.includes("公开正文。"));
  for (const text of ["隐藏选项", "隐藏任务", "隐藏表项", "equipment", "表项"])
    assert.ok(!html.includes(text));
});

test("普通详情把封面和名称放在内容中，简介、字段和正文按 layout.order 展示", async () => {
  const type = validateDocumentType("人物", {
    fields: { hp: { type: "number", label: "HP" } },
  });
  const typeWithLayout = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: {
        type: "grid",
        columns: 1,
        fields: ["hp"],
        order: ["description", "fields", "body"],
      },
    }),
  };
  const html = await render(
    <DocumentDetail
      document={{
        path: "人物/小满.json",
        title: "小满",
        image: "portrait.webp",
        description: "这是简介。",
        body: "这是正文。",
        valid: true,
        values: { hp: 7 },
      }}
      documentType={typeWithLayout}
    />,
  );

  assert.equal((html.match(/<h2\b/g) ?? []).length, 1);
  assert.ok(html.indexOf("<img") < html.indexOf("<h2"));
  assert.ok(html.indexOf("<h2") < html.indexOf("这是简介。"));
  assert.ok(html.indexOf("这是简介。") < html.indexOf("HP"));
  assert.ok(html.indexOf("HP") < html.indexOf("这是正文。"));
});

test("详情中的损坏表格显示错误，不渲染重复或缺失行标识", async () => {
  const type = validateDocumentType("角色", {
    fields: {
      rows: {
        type: "list",
        label: "技能",
        item: {
          type: "object",
          fields: { id: { type: "text" }, value: { type: "number" } },
        },
      },
    },
  });
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: {
        type: "grid",
        fields: ["rows"],
        fieldViews: {
          rows: {
            type: "FieldTable",
            rowKey: "id",
            columns: [{ field: "value" }],
          },
        },
      },
    }),
  };
  for (const rows of [[{ id: "a" }, { id: "a" }], [{ value: 20 }]]) {
    const html = await render(
      <DocumentDetail
        documentType={documentType}
        document={{
          path: "角色/测试.json",
          title: "测试",
          valid: true,
          values: { rows },
        }}
      />,
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("技能数据无效"));
    assert.ok(!html.includes("<table"));
  }
});
