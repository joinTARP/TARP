import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

import { validateDocumentLayout, validateDocumentType } from "@jointarp/module/document-type";
import { referenceCollectionSchema } from "@jointarp/module/reference-collection";
import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";

const preview = { visible: false };

// SSR 不挂载悬浮 Portal；仅在检查悬浮内容时展开展示边界，保留实际资料和实例消费链路。
const actual = { ...(await import("@base-ui/react/preview-card")) };
mock.module("@base-ui/react/preview-card", () => {
  return {
    ...actual,
    PreviewCard: {
      ...actual.PreviewCard,
      Portal: (props: React.ComponentProps<typeof actual.PreviewCard.Portal>) =>
        preview.visible ? props.children : <actual.PreviewCard.Portal {...props} />,
      Positioner: (props: React.ComponentProps<typeof actual.PreviewCard.Positioner>) =>
        preview.visible ? props.children : <actual.PreviewCard.Positioner {...props} />,
      Popup: (props: React.ComponentProps<typeof actual.PreviewCard.Popup>) =>
        preview.visible ? props.children : <actual.PreviewCard.Popup {...props} />,
    },
  };
});
const { buildCharacterSheet } = await import("../sessions/character-sheet");
const { CharacterSheet } = await import("../sessions/CharacterSheet");
const { RoomDocumentScope } = await import("../sessions/room-document");
const { buildDocumentSheet } = await import("./document-sheet");
const { DocumentDetail } = await import("./DocumentDetail");
import type { ReferenceDocument } from "./DocumentReferences";
const { DocumentReferences } = await import("./DocumentReferences");
const { DocumentSheet } = await import("./DocumentSheet");
const { InventorySlots } = await import("./InventorySlots");
const { buildReferenceCollectionRows, filterReferenceCollectionRows } =
  await import("./reference-collection");
const { ReferenceCollection } = await import("./ReferenceCollection");
const { ComputedReferenceItems } = await import("./ReferenceItemDocument");
const { computedCollectionRows, roomCollectionCandidates } = await import("./room-collection-rows");

const type = validateDocumentType("角色", {
  fields: {
    equipment: {
      type: "list",
      label: "背包",
      item: {
        type: "object",
        fields: {
          item: { type: "reference", targets: ["物品"] },
          quantity: { type: "number", label: "数量" },
          location: { type: "enum", options: ["随身", "穿戴"], label: "位置" },
          secret: { type: "text", visibility: "gm" },
        },
      },
    },
    spells: { type: "list", item: { type: "reference", targets: ["法术"] } },
    hp: { type: "number" },
  },
});
const config = referenceCollectionSchema.parse({
  type: "ReferenceCollection",
  referenceField: "item",
  filterField: "location",
  metadata: [{ field: "quantity" }, { field: "location" }],
});
const field = type.fields[0];
const values = {
  equipment: [
    { item: "/物品/短剑.json", quantity: 1, location: "穿戴" },
    { item: "物品/短剑", quantity: 0, location: "随身" },
    { item: "物品/失落卷轴", quantity: 2, location: "随身" },
  ],
};
const documents: ReferenceDocument[] = [
  {
    path: "物品/短剑",
    title: "铁制短剑",
    docType: "物品",
    valid: true,
    image: "https://example.test/images/sword.webp",
    values: { damage: "d6" },
  },
];
const layout = validateDocumentLayout(type, {
  detail: {
    type: "grid",
    fields: ["equipment"],
    fieldViews: { equipment: config },
  },
});

async function render(node: ReactNode) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

test("引用集合校验列表结构、公开子字段和展示路径", () => {
  for (const [path, view] of [
    ["hp", config],
    ["equipment", { ...config, referenceField: "quantity" }],
    ["equipment", { ...config, metadata: [{ field: "secret" }] }],
    ["equipment", { ...config, filterField: "secret" }],
    ["equipment", { ...config, metadata: [{ field: "quantity" }, { field: "quantity" }] }],
    ["equipment", { ...config, unknownProp: true }],
    ["equipment", { ...config, quantityField: "secret" }],
    ["equipment", { ...config, quantityField: "location" }],
    ["equipment", { ...config, slotCount: 0 }],
    ["equipment", { ...config, slotCount: 201 }],
    ["equipment", { ...config, imageAspect: "1:0" }],
  ] as const)
    assert.throws(() =>
      validateDocumentLayout(type, {
        detail: { type: "grid", fields: [path], fieldViews: { [path]: view } },
      }),
    );
  assert.throws(() =>
    validateDocumentLayout(type, {
      detail: {
        type: "grid",
        fields: ["hp"],
        fieldViews: { equipment: config },
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateDocumentLayout(type, {
      detail: {
        type: "grid",
        fields: ["spells"],
        fieldViews: { spells: { type: "ReferenceCollection" } },
      },
    }),
  );
  assert.throws(() =>
    validateDocumentLayout(type, {
      detail: {
        type: "grid",
        fields: ["spells"],
        fieldViews: { spells: config },
      },
    }),
  );
});

test("解析引用名称，保留重复物品、零数量和失效引用，搜索与分类组合生效", () => {
  const original = JSON.stringify(values);
  const rows = buildReferenceCollectionRows(
    values.equipment,
    field,
    config,
    new Map(documents.map((document) => [document.path, document])),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, "铁制短剑");
  assert.equal(rows[1].metadata[0].text, "0");
  assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(rows[2].unavailable, true);
  assert.equal(filterReferenceCollectionRows(rows, "  短剑 ", "随身").length, 1);
  assert.equal(filterReferenceCollectionRows(rows, "卷轴", "穿戴").length, 0);
  assert.equal(JSON.stringify(values), original);
});

test("详情和游戏角色卡共用引用集合，保留详情入口和搜索控件", async () => {
  const documentType = { ...type, layout };
  const sheet = buildCharacterSheet(documentType, values);
  for (const node of [
    <DocumentDetail
      document={{ path: "角色/玩家", title: "玩家", valid: true, values }}
      documentType={documentType}
    />,
    <CharacterSheet sheet={sheet} compact />,
  ]) {
    const html = await render(
      <DocumentReferences documents={documents} types={[documentType]}>
        {node}
      </DocumentReferences>,
    );
    assert.ok(html.includes('aria-label="搜索背包"'));
    assert.ok(html.includes('aria-label="卡片视图"'));
    assert.ok(html.includes("铁制短剑"));
    assert.ok(html.includes("资料暂不可用"));
    assert.ok(html.includes("3 / 3 项"));
  }
});

test("纯引用列表可复用为法术书；空集合与只展示配置有明确反馈", async () => {
  const spells = type.fields[1];
  const plain = referenceCollectionSchema.parse({
    type: "ReferenceCollection",
    searchable: false,
    switchable: false,
    display: "list",
  });
  const rows = buildReferenceCollectionRows(["法术/光亮术"], spells, plain);
  assert.equal(rows[0].title, "光亮术");
  const html = await render(<ReferenceCollection value={[]} field={spells} config={plain} />);
  assert.ok(html.includes("暂无"));
  assert.ok(!html.includes('type="search"'));
  assert.ok(!html.includes("卡片视图"));
});

test("嵌入 sheet 的循环引用保留详情入口而不无限展开", async () => {
  const base = validateDocumentType("资料", {
    fields: { related: { type: "list", item: { type: "reference", targets: ["资料"] } } },
  });
  const relatedView = {
    type: "ReferenceCollection",
    display: "sheets",
    searchable: false,
    switchable: false,
  };
  const documentType = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: { type: "grid", fields: ["related"], fieldViews: { related: relatedView } },
    }),
  };
  const documents = [
    {
      path: "资料/甲.json",
      title: "甲",
      docType: base.id,
      valid: true,
      values: { related: ["资料/乙.json"] },
    },
    {
      path: "资料/乙.json",
      title: "乙",
      docType: base.id,
      valid: true,
      values: { related: ["资料/甲.json"] },
    },
  ];
  const html = await render(
    <DocumentReferences documents={documents} types={[documentType]}>
      <DocumentSheet sheet={buildDocumentSheet(documents[0]!, documentType)} />
    </DocumentReferences>,
  );
  assert.ok(html.includes("嵌入已折叠"));
  assert.ok(html.includes("查看甲详情"));
  assert.ok(html.includes("查看乙详情"));
  assert.throws(
    () =>
      validateDocumentLayout(type, {
        detail: { type: "grid", fields: ["equipment"], fieldViews: { equipment: relatedView } },
      }),
    /纯引用列表/,
  );
});

test("角色卡透传物品格配置与图片，显示数量和空槽，超容量不丢物品", async () => {
  const slots = referenceCollectionSchema.parse({
    ...config,
    display: "slots",
    slotCount: 8,
    quantityField: "quantity",
  });
  const documentType = {
    ...type,
    layout: { ...layout, sheet: undefined, fieldViews: { equipment: slots } },
  };
  const sheet = buildCharacterSheet(documentType, values);
  const html = await render(
    <DocumentReferences documents={documents} types={[documentType]}>
      <CharacterSheet sheet={sheet} />
    </DocumentReferences>,
  );
  assert.equal((html.match(/aria-label="空物品槽 /g) ?? []).length, 5);
  assert.ok(html.includes('aria-label="数量 0"'));
  assert.ok(html.includes('aria-label="数量 2"'));
  assert.ok(html.includes('aria-label="物品格视图"'));
  assert.ok(html.includes("3 / 8 格"));
  assert.ok(html.includes('src="https://example.test/images/sword.webp"'));
  for (const location of ["穿戴", "随身"]) assert.ok(html.includes(location));
  const empty = await render(<ReferenceCollection value={[]} field={field} config={slots} />);
  assert.equal((empty.match(/aria-label="空物品槽 /g) ?? []).length, 8);
  const overflow = await render(
    <ReferenceCollection
      value={values.equipment}
      field={field}
      config={{ ...slots, slotCount: 1 }}
    />,
  );
  assert.ok(overflow.includes("失落卷轴"));
  assert.ok(overflow.includes("超出展示容量"));
  assert.ok(!overflow.includes('aria-label="空物品槽 '));
  const rows = buildReferenceCollectionRows(values.equipment, field, slots);
  const filtered = await render(
    <InventorySlots
      rows={filterReferenceCollectionRows(rows, "卷轴")}
      label="背包"
      slotCount={8}
      filtered
    />,
  );
  assert.ok(!filtered.includes('aria-label="空物品槽 '));
  assert.ok(!filtered.includes("短剑"));
});

test("引用集合的三种视图显示提供的图片，无图时仍保留物品名称", async () => {
  for (const display of ["cards", "list", "slots"] as const) {
    const draw = (image?: string) =>
      render(
        <DocumentReferences documents={[{ ...documents[0]!, image }]} types={[type]}>
          <ReferenceCollection
            value={values.equipment.slice(0, 1)}
            field={field}
            config={{ ...config, display }}
          />
        </DocumentReferences>,
      );
    assert.match(await draw("https://example.test/images/revealed.webp"), /revealed\.webp/);
    const hidden = await draw();
    assert.doesNotMatch(hidden, /<img\b/);
    assert.match(hidden, /铁制短剑/);
  }
});

test("房间背包按当前投影搜索并展示名称和图片，等待及失效不回退原始索引", () => {
  const index = new Map(documents.map((document) => [document.path, document]));
  index.set("物品/其他", { ...documents[0]!, path: "物品/其他" });
  const rows = buildReferenceCollectionRows(values.equipment, field, config, index);
  assert.equal(roomCollectionCandidates(rows, index).length, 1);
  const raw = { ...documents[0]!, valid: true };
  const current = computedCollectionRows(rows, [
    { ...raw, title: "当前公开别名", image: "https://example.test/images/current.webp" },
  ]);
  const visible = filterReferenceCollectionRows(current, "公开别名");
  assert.equal(visible.length, 2);
  assert.equal(filterReferenceCollectionRows(current, "铁制短剑").length, 0);
  assert.equal(current.length, 2, "未取得本版投影的条目不显示，也不计入数量");
  const draw = (projected: typeof rows) =>
    renderToStaticMarkup(
      <RoomDocumentScope roomId="room">
        <DocumentReferences documents={documents} types={[type]}>
          <ComputedReferenceItems>
            <InventorySlots rows={projected} label="背包" slotCount={1} filtered />
          </ComputedReferenceItems>
        </DocumentReferences>
      </RoomDocumentScope>,
    );
  const html = draw(visible);
  assert.match(html, /当前公开别名/);
  assert.match(html, /current\.webp/);
  assert.doesNotMatch(html, /铁制短剑|sword\.webp|正在读取资料/);
  for (const pending of [[], [{ ...raw, valid: false }]]) {
    const mapped = computedCollectionRows(rows, pending);
    assert.equal(filterReferenceCollectionRows(mapped, "铁制短剑").length, 0);
    if (pending.length) assert.match(draw(mapped), /资料暂不可用/);
    else assert.equal(mapped.length, 0);
    assert.doesNotMatch(draw(mapped), /铁制短剑|sword\.webp|current\.webp/);
  }
  const hidden = computedCollectionRows(rows, [{ ...raw, visible: false }]);
  assert.equal(hidden.length, 0);
  assert.doesNotMatch(draw(hidden), /铁制短剑|sword\.webp|穿戴|随身|数量/);
  const revoked = computedCollectionRows(rows, [
    { ...raw, title: "当前公开别名", image: undefined },
  ]);
  assert.doesNotMatch(draw(revoked), /sword\.webp|current\.webp/);
  assert.equal(rows[0].title, "铁制短剑", "原始索引和输入行保持不变");
});

test("引用集合隐藏空值附加字段，保留零数量对应的条目和原始数据", () => {
  const hiddenField = {
    ...field,
    item: {
      ...field.item!,
      fields: field.item!.fields!.map((child) =>
        child.key === "quantity" ? { ...child, hideWhenEmpty: true } : child,
      ),
    },
  };
  const rows = buildReferenceCollectionRows(values.equipment, hiddenField, config);
  assert.equal(rows.length, values.equipment.length);
  assert.equal(rows[0].metadata.find((entry) => entry.key === "quantity")?.text, "1");
  assert.equal(
    rows[1].metadata.some((entry) => entry.key === "quantity"),
    false,
  );
  assert.equal(values.equipment[1].quantity, 0);
});

test("行装自动显示每个实例的物品摘要，搜索读取摘要并遵守空值隐藏", async () => {
  const instanceType = validateDocumentType("持有者", {
    fields: {
      equipment: {
        type: "list",
        item: {
          type: "object",
          instance: { referenceField: "item", stateField: "state" },
          fields: {
            item: { type: "reference", targets: ["物品"], required: true },
            location: { type: "text", label: "位置" },
            quantity: { type: "number", label: "数量" },
          },
        },
      },
    },
  });
  const rows = [
    {
      item: "物品/短剑",
      location: "随身",
      state: { fuel: 20 },
      $instance: {
        display: [
          { key: "fuel", label: "剩余燃料", value: 20 },
          { key: "status", label: "状态", value: "照明中" },
          { key: "hidden", label: "隐藏空值", value: 0, hideWhenEmpty: true },
        ],
      },
    },
    {
      item: "物品/短剑",
      location: "穿戴",
      state: { fuel: 0 },
      $instance: {
        display: [
          { key: "fuel", label: "剩余燃料", value: 0 },
          { key: "status", label: "状态", value: "已燃尽" },
          { key: "lit", label: "正在照明", value: false, hideWhenEmpty: true },
        ],
      },
    },
  ];
  const mapped = buildReferenceCollectionRows(rows, instanceType.fields[0]!, config);
  assert.equal(filterReferenceCollectionRows(mapped, "照明中").length, 1);
  assert.equal(mapped[1]!.metadata.find((entry) => entry.key === "instance.lit")!.text, "否");
  for (const display of ["cards", "list", "slots"] as const) {
    const draw = () =>
      render(
        <DocumentReferences documents={documents} types={[instanceType]}>
          <ReferenceCollection
            value={rows}
            field={instanceType.fields[0]!}
            config={{ ...config, display }}
          />
        </DocumentReferences>,
      );
    let html = await draw();
    if (display === "slots") {
      assert.doesNotMatch(html, /<dl\b/, "格子不常驻显示实例摘要");
      preview.visible = true;
      try {
        html = await draw();
      } finally {
        preview.visible = false;
      }
    }
    // 列表和卡片直接展示摘要，格子把各自实例的摘要传入共用资料悬浮卡。
    const summaries = [...html.matchAll(/<dl\b[^>]*>(.*?)<\/dl>/gs)].map((match) => match[1]!);
    assert.equal(summaries.length, 2);
    assert.match(summaries[0]!, /<dt\b[^>]*>剩余燃料：?<\/dt><dd\b[^>]*>20<\/dd>/);
    assert.match(summaries[0]!, /<dt\b[^>]*>状态：?<\/dt><dd\b[^>]*>照明中<\/dd>/);
    assert.match(summaries[1]!, /<dt\b[^>]*>剩余燃料：?<\/dt><dd\b[^>]*>0<\/dd>/);
    assert.match(summaries[1]!, /<dt\b[^>]*>状态：?<\/dt><dd\b[^>]*>已燃尽<\/dd>/);
    assert.match(summaries[1]!, /<dt\b[^>]*>正在照明：?<\/dt><dd\b[^>]*>否<\/dd>/);
    assert.ok(!html.includes("隐藏空值"));
  }
});
