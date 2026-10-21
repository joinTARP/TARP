import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { validateDocumentLayout, validateDocumentType } from "@tarp/module/document-type";
import type { EquipmentSlotsLayout } from "@tarp/module/equipment-slots";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import { buildCharacterSheet } from "../sessions/character-sheet";
import { CharacterSheet } from "../sessions/CharacterSheet";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentReferences } from "./DocumentReferences";
import { EquipmentSlots } from "./EquipmentSlots";

const type = validateDocumentType("测试角色", {
  fields: {
    equipped: {
      type: "object",
      label: "装备",
      fields: {
        head: { type: "reference", targets: ["物品"] },
        body: { type: "reference", targets: ["物品"] },
        feet: { type: "reference", targets: ["物品"] },
        secret: { type: "reference", targets: ["物品"], visibility: "gm" },
        count: { type: "number" },
      },
    },
    inventory: { type: "list", item: { type: "reference", targets: ["物品"] } },
  },
});
const config = {
  type: "EquipmentSlots",
  slots: [
    { field: "head", label: "头部", icon: "head" },
    { field: "body", label: "身体", icon: "body" },
    { field: "feet", label: "鞋靴", icon: "feet" },
  ],
};
const layoutInput = { type: "grid", fields: ["equipped"], fieldViews: { equipped: config } };
const documentType = {
  ...type,
  layout: validateDocumentLayout(type, { detail: layoutInput }),
};

async function render(node: ReactNode) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

test("装备区只接受公开引用部位，拒绝重复、未知部位与错误绑定", () => {
  for (const slots of [
    [],
    [config.slots[0], config.slots[0]],
    [{ field: "missing", label: "不存在" }],
    [{ field: "secret", label: "隐藏" }],
    [{ field: "count", label: "数量" }],
    [{ ...config.slots[0], icon: "unknown" }],
  ]) {
    assert.throws(() =>
      validateDocumentLayout(type, {
        detail: {
          ...layoutInput,
          fieldViews: { equipped: { ...config, slots } },
        },
      }),
    );
  }
  assert.throws(() =>
    validateDocumentLayout(type, {
      detail: {
        type: "grid",
        fields: ["inventory"],
        fieldViews: { inventory: config },
      },
    }),
  );
});

test("显式布局在角色卡和详情中保留装备部位", async () => {
  const gridType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: { type: "grid", fields: ["equipped"], fieldViews: { equipped: config } },
    }),
  };
  for (const node of [
    <CharacterSheet sheet={buildCharacterSheet(gridType, { equipped: {} })} />,
    <DocumentDetail
      document={{ path: "角色/测试", title: "测试", valid: true, values: { equipped: {} } }}
      documentType={gridType}
    />,
  ]) {
    const html = await render(node);
    for (const label of ["头部", "身体", "鞋靴"])
      assert.ok(html.includes(`aria-label="${label}：未装备"`));
  }
});

test("文档详情与角色卡复用装备区，缺省对象仍显示所有空部位", async () => {
  for (const values of [{}, { equipped: {} }]) {
    const sheet = buildCharacterSheet(documentType, values);
    for (const node of [
      <CharacterSheet sheet={sheet} />,
      <DocumentDetail
        document={{ path: "角色/测试", title: "测试", valid: true, values }}
        documentType={documentType}
      />,
    ]) {
      const html = await render(node);
      for (const label of ["头部", "身体", "鞋靴"])
        assert.ok(html.includes(`aria-label="${label}：未装备"`));
      assert.ok(!html.includes("隐藏"));
    }
  }
});

test("已装备引用显示名称及详情入口，失效引用保留，未配置字段不渲染", async () => {
  const html = await render(
    <DocumentReferences
      documents={[{ path: "物品/头盔", title: "旅行者头盔", docType: "物品", valid: true }]}
      types={[]}
    >
      <DocumentDetail
        document={{
          path: "角色/测试",
          title: "测试",
          valid: true,
          values: {
            equipped: { head: "物品/头盔", feet: "物品/失落靴子", secret: "秘密物品" },
          },
        }}
        documentType={documentType}
      />
    </DocumentReferences>,
  );
  assert.ok(html.includes("旅行者头盔"));
  assert.ok(html.includes("<button"));
  assert.ok(html.includes('aria-label="身体：未装备"'));
  assert.ok(html.includes("失落靴子"));
  assert.ok(html.includes("资料暂不可用"));
  assert.ok(!html.includes("秘密物品"));
});

test("装备缩略图支持三种格式的完整引用，无图时保留装备名称", async () => {
  const draw = (image?: string, extension = "") =>
    render(
      <DocumentReferences
        documents={[
          {
            path: `物品/头盔${extension || ".json"}`,
            title: "头盔",
            docType: "物品",
            valid: true,
            image,
          },
        ]}
        types={[type]}
      >
        <EquipmentSlots
          value={{ head: `物品/头盔${extension}` }}
          config={config as EquipmentSlotsLayout}
          label="装备"
        />
      </DocumentReferences>,
    );
  for (const extension of ["", ".json", ".toml", ".md"]) {
    const html = await draw("https://example.test/images/revealed-helmet.webp", extension);
    assert.match(html, /revealed-helmet\.webp/);
    assert.match(html, /头部：头盔/);
    assert.doesNotMatch(html, /资料暂不可用/);
  }
  const withoutImage = await draw();
  assert.doesNotMatch(withoutImage, /<img\b/);
  assert.match(withoutImage, /头部：头盔/);
});
