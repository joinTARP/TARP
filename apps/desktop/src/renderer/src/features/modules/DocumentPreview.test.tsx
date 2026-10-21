import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { ModuleDocument } from "@shared/desktop-api";
import { publicValues } from "@tarp/module/character";
import { evaluateComputedFields } from "@tarp/module/computed-fields";
import { validateDocumentLayout, validateDocumentType } from "@tarp/module/document-type";
import { equipmentSlotsSchema } from "@tarp/module/equipment-slots";
import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";

import { buildCharacterSheet } from "../sessions/character-sheet";
import { CharacterSheet } from "../sessions/CharacterSheet";
import { RoomDocumentScope } from "../sessions/room-document";
import { DocumentLibraryScope } from "./document-library-context";
import { documentReferencePath, getPreviewFields } from "./document-preview";
import { DocumentCardContent } from "./DocumentCardContent";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentDialog } from "./DocumentDialog";
import { DocumentPreview } from "./DocumentPreview";
import { DocumentReferences, DocumentReference } from "./DocumentReferences";
import { DocumentTable } from "./DocumentTable";
import { EquipmentSlots } from "./EquipmentSlots";
import { ModuleDocuments } from "./ModuleDocuments";

async function render(node: ReactNode) {
  const stream = await renderToReadableStream(node);
  await stream.allReady;
  return new Response(stream).text();
}

const type = validateDocumentType("人物", {
  fields: {
    hp: { type: "number", label: "HP" },
    active: { type: "boolean", label: "行动" },
    secret: { type: "text", visibility: "gm" },
    hidden: { type: "object", visibility: "gm", fields: { name: { type: "text" } } },
  },
});
const document = {
  path: "人物/沈莺.json",
  docType: "人物",
  title: "沈莺",
  valid: true,
  description: "公开简介",
  body: "详情正文不应进入预览",
  values: { hp: 0, active: false, secret: "秘密不应出现", hidden: { name: "隐藏姓名" } },
};

test("预览字段保留零和 false，跳过未配置、未声明和非公开字段", () => {
  assert.deepEqual(
    getPreviewFields(document, type, ["active", "secret", "hp", "hidden.name", "missing"]),
    [
      { path: "active", label: "行动", text: "否" },
      { path: "hp", label: "HP", text: "0" },
    ],
  );
  assert.deepEqual(getPreviewFields(document, type, ["secret", "hidden.name"], true), [
    { path: "secret", label: "secret", text: "秘密不应出现" },
    { path: "hidden.name", label: "name", text: "隐藏姓名" },
  ]);
});

test("整份隐藏资料不显示引用、详情、表格和装备内容，模组库仍能展示完整资料", async () => {
  const hidden = {
    ...document,
    visible: false,
    image: "https://example.test/hidden.webp",
    body: "绝密正文",
  };
  const documentType = { ...type, displayWhen: "$self.revealed === true" };
  const tableLayout = { type: "table" as const, fields: ["hp"], description: true };
  const view = (
    <DocumentReferences documents={[hidden]} types={[documentType]}>
      <DocumentReference value={hidden.path}>引用文字也不显示</DocumentReference>
      <DocumentPreview document={hidden} documentType={documentType} />
      <DocumentDetail document={hidden} documentType={documentType} />
      <DocumentDialog
        document={hidden}
        documentType={documentType}
        open
        trigger={<button>秘密入口</button>}
      />
      <DocumentTable
        documents={[hidden]}
        documentType={documentType}
        layout={tableLayout}
        selectedDocumentPath={null}
        onSelectDocument={() => {}}
      />
      <EquipmentSlots
        value={{ hand: hidden.path }}
        label="装备"
        config={equipmentSlotsSchema.parse({
          type: "EquipmentSlots",
          slots: [{ field: "hand", label: "主手", icon: "hand" }],
        })}
      />
    </DocumentReferences>
  );
  const stream = await renderToReadableStream(view);
  await stream.allReady;
  const html = await new Response(stream).text();
  assert.doesNotMatch(html, /沈莺|绝密正文|引用文字也不显示|秘密入口|hidden\.webp|未装备/);
  assert.match(html, /资料当前不可见/);
  assert.match(html, /主手/);
  assert.deepEqual(getPreviewFields(hidden, documentType, ["hp"]), []);
  const library = await renderToReadableStream(
    <DocumentLibraryScope>
      <DocumentDetail document={hidden} documentType={documentType} />
    </DocumentLibraryScope>,
  );
  await library.allReady;
  const complete = await new Response(library).text();
  assert.match(complete, /HP/);
  assert.match(complete, /绝密正文/);
});

test("聊天引用在资料隐藏或失效时保留正文文字，预览和详情入口仍关闭", async () => {
  for (const unavailable of [
    { ...document, visible: false },
    { ...document, valid: false },
  ]) {
    const html = await render(
      <DocumentReferences documents={[unavailable]} types={[type]} view="game">
        <DocumentReference value={document.path} preserveText>
          已在聊天中提到的称呼
        </DocumentReference>
      </DocumentReferences>,
    );
    assert.match(html, /已在聊天中提到的称呼/);
    assert.doesNotMatch(html, /<button|沈莺|公开简介|详情正文/);
    const hiddenName = await render(
      <DocumentReferences documents={[unavailable]} types={[type]} view="game">
        <DocumentReference value={document.path} preserveText />
      </DocumentReferences>,
    );
    assert.doesNotMatch(hiddenName, /沈莺|<button/, "尚未显示过的资料名称不从原始索引补回");
  }
});

test("模组库和游戏共用布局，主持摘要仅在模组作用域可见，null 默认保留字段", async () => {
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: { type: "grid", fields: ["hp", "secret"] },
      hover: { fields: ["secret", "hp"], image: "none", descriptionLines: 0 },
    }),
  };
  const render = async (node: React.ReactNode) => {
    const stream = await renderToReadableStream(node);
    await stream.allReady;
    return new Response(stream).text();
  };
  const game = await render(<DocumentPreview document={document} documentType={documentType} />);
  const library = await render(
    <DocumentLibraryScope>
      <DocumentPreview document={document} documentType={documentType} />
    </DocumentLibraryScope>,
  );
  assert.ok(!game.includes("秘密不应出现"));
  assert.ok(library.includes("秘密不应出现"));
  const hidden = await render(
    <DocumentDetail
      document={{ ...document, values: publicValues(type.fields, { hp: null, secret: null }) }}
      documentType={documentType}
    />,
  );
  assert.ok(hidden.includes("HP"));
  assert.ok(hidden.includes("暂无数据"));
  assert.ok(!hidden.includes("secret"));
});

test("悬浮摘要按配置显示，不带入详情正文与秘密", async () => {
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: { type: "grid", fields: ["hp", "secret"] },
      hover: { fields: ["hp"], image: "none", descriptionLines: 0 },
    }),
  };
  const stream = await renderToReadableStream(
    <DocumentPreview document={document} documentType={documentType} />,
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  assert.ok(html.includes("沈莺"));
  assert.ok(html.includes("HP"));
  for (const hidden of ["公开简介", "详情正文", "秘密不应出现", "隐藏姓名"])
    assert.ok(!html.includes(hidden));
});

test("列表卡片独立控制图片、简介和摘要字段，不受详情与 hover 配置影响", async () => {
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: { type: "grid", fields: ["secret"] },
      card: { image: "none", descriptionLines: 0, fields: ["hp"] },
      hover: { fields: ["active"] },
    }),
  };
  const stream = await renderToReadableStream(
    <ModuleDocuments
      documents={[{ ...document, image: "portrait.webp" }]}
      documentTypes={[documentType]}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />,
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  assert.ok(html.includes("HP"));
  for (const hidden of ["<img", "公开简介", "秘密不应出现", "行动"])
    assert.ok(!html.includes(hidden));
});

test("省略简介时卡片、悬浮和表格使用正文纯文本，详情不重复正文", async () => {
  const short = {
    ...document,
    description: undefined,
    body: "**恢复** [生命](https://example.test/heal) `2` 点。\n\n- 随身携带\n\n<!-- 内部注释 -->",
  };
  const views = (doc: ModuleDocument, enabled = true) => [
    <DocumentCardContent
      document={doc}
      documentType={{
        ...type,
        layout: validateDocumentLayout(type, {
          detail: { type: "grid", fields: ["hp"] },
          card: { descriptionLines: enabled ? 2 : 0 },
        }),
      }}
    />,
    <DocumentPreview
      document={doc}
      documentType={{
        ...type,
        layout: validateDocumentLayout(type, {
          detail: { type: "grid", fields: ["hp"] },
          hover: { descriptionLines: enabled ? 3 : 0 },
        }),
      }}
    />,
    <DocumentTable
      documents={[doc]}
      documentType={type}
      layout={{ type: "table", fields: [], description: enabled }}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />,
  ];
  for (const view of views(short)) {
    const html = await render(view);
    assert.match(html, /恢复 生命 2 点。 随身携带/);
    assert.doesNotMatch(html, /\*\*|https:\/\/example|内部注释|<strong>|<code>/);
  }
  for (const view of views({ ...short, description: "优先使用简介" })) {
    const html = await render(view);
    assert.match(html, /优先使用简介/);
    assert.doesNotMatch(html, /恢复|随身携带/);
  }
  for (const view of views(short, false)) {
    assert.doesNotMatch(await render(view), /恢复|随身携带/);
  }
  for (const view of views({ ...short, body: "  <!-- 没有可见正文 -->  " })) {
    assert.doesNotMatch(await render(view), /没有可见正文/);
  }
  const detail = await render(<DocumentDetail document={short} documentType={type} />);
  assert.equal(detail.match(/随身携带/gu)?.length, 1);
  assert.equal(short.description, undefined);
});

test("文档正文展示图片和编码引用，保留外链与锚点，不自动展开被引用正文", async () => {
  const documentType = {
    ...type,
    layout: validateDocumentLayout(type, {
      detail: { type: "grid", fields: ["hp"] },
      reference: { style: "badge" },
    }),
  };
  const stream = await renderToReadableStream(
    <DocumentReferences
      documents={[
        document,
        {
          path: "地点/聚餐.json",
          title: "聚餐包间",
          docType: "地点",
          valid: true,
          image: "图片/聚餐现场.webp",
          body: "被引用资料正文不应自动出现",
        },
      ]}
      types={[documentType]}
    >
      <DocumentDetail
        documentType={documentType}
        document={{
          ...document,
          body: `![聚餐包间](图片/聚餐现场.webp)\n\n热菜陆续端上桌。[[地点/聚餐.json]]\n\n**村民**\n\n[受困村民](${encodeURI(document.path)}) [无扩展名](人物/沈莺) [外部](https://example.com) [段落](#section) [缺失](人物/未知.json)`,
        }}
      />
    </DocumentReferences>,
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  assert.ok(html.includes("<p><strong>村民</strong></p>"));
  assert.ok(html.includes('src="图片/聚餐现场.webp"'));
  assert.ok(html.includes('alt="聚餐包间"'));
  assert.ok(html.includes('aria-label="放大查看聚餐包间"'));
  assert.ok(html.includes("热菜陆续端上桌。"));
  assert.ok(html.includes(">聚餐包间</button>"));
  assert.ok(!html.includes("被引用资料正文不应自动出现"));
  assert.ok(html.includes("受困村民</button>"));
  assert.ok(html.includes("无扩展名</button>"));
  assert.ok(html.includes('aria-haspopup="dialog"'));
  assert.ok(html.includes('href="https://example.com"'));
  assert.match(
    html,
    /<a[^>]*href="https:\/\/example\.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
  );
  assert.ok(html.includes('href="#section"'));
  assert.match(html, /<a href="#section">/);
  assert.ok(html.includes(">缺失</a>"));
  assert.equal(documentReferencePath("https://example.com/人物/沈莺"), undefined);
  assert.equal(documentReferencePath("%broken"), undefined);
  assert.equal(documentReferencePath("人物/沈莺.md"), "人物/沈莺.md");
  assert.equal(documentReferencePath("./人物/沈莺"), "人物/沈莺");
});

const tableType = validateDocumentType("物品", {
  name: "物品",
  fields: {
    name: { type: "text", compute: '"未辨识物品"' },
    damage: { type: "number", label: "伤害", compute: "10" },
  },
});
const tableDocument: ModuleDocument = {
  id: "item",
  path: "物品/古剑.json",
  docType: "物品",
  title: "秘藏古剑",
  description: "斩断结界",
  valid: true,
  values: { damage: 18 },
};
const tableView = (
  <DocumentReferences documents={[tableDocument]} types={[tableType]}>
    <DocumentTable
      documents={[tableDocument]}
      documentType={tableType}
      layout={{ type: "table", fields: ["damage"], description: true }}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />
  </DocumentReferences>
);

test("普通与调试模组表格显示摘要值、说明和引用名称", () => {
  for (const node of [
    tableView,
    <RoomDocumentScope roomId="room" debug>
      {tableView}
    </RoomDocumentScope>,
  ]) {
    const html = renderToStaticMarkup(node);
    assert.match(html, />秘藏古剑<\/button>/);
    assert.match(html, />18<\/td>/);
    assert.match(html, /斩断结界/);
  }
});

test("房间表格初次计算期间不渲染原始名称、说明和字段", () => {
  const html = renderToStaticMarkup(
    <RoomDocumentScope roomId="room">{tableView}</RoomDocumentScope>,
  );
  assert.equal(html.includes("秘藏古剑"), false);
  assert.equal(html.includes("斩断结界"), false);
  assert.equal(html.includes(">18</td>"), false);
});

test("空值隐藏在角色卡、详情、摘要和表格生效，有值后恢复且 false 保留", async () => {
  const base = validateDocumentType("角色", {
    fields: {
      zero: { type: "number", label: "空数值", hideWhenEmpty: true },
      text: { type: "text", label: "空文本", hideWhenEmpty: true },
      effects: {
        type: "list",
        label: "空效果",
        mutable: true,
        hideWhenEmpty: true,
        item: { type: "text" },
      },
      rows: {
        type: "list",
        label: "空集合",
        hideWhenEmpty: true,
        item: { type: "object", fields: { id: { type: "text" }, value: { type: "number" } } },
      },
      absent: { type: "text", label: "缺省字段", hideWhenEmpty: true },
      nullValue: { type: "text", label: "隐藏计算值", hideWhenEmpty: true },
      active: { type: "boolean", label: "保留布尔", hideWhenEmpty: true },
      defaultZero: { type: "number", label: "默认零值", hideWhenEmpty: false },
    },
  });
  const fields = base.fields.map((field) => field.key);
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "grid",
        fields,
        fieldViews: { rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "value" }] } },
      },
      hover: { fields },
    }),
  };
  const values = {
    zero: 0,
    text: "",
    effects: [],
    rows: [],
    nullValue: null,
    active: false,
    defaultZero: 0,
  };
  const empty = { ...document, docType: "角色", values };
  assert.deepEqual(
    getPreviewFields(empty, type, fields).map((entry) => entry.label),
    ["保留布尔", "默认零值"],
  );
  for (const node of [
    <DocumentDetail document={empty} documentType={type} />,
    <CharacterSheet sheet={buildCharacterSheet(type, values)} />,
    <DocumentPreview document={empty} documentType={type} />,
  ]) {
    const stream = await renderToReadableStream(node);
    await stream.allReady;
    const html = await new Response(stream).text();
    assert.doesNotMatch(html, /空数值|空文本|空效果|空集合|缺省字段|隐藏计算值|暂无|暂无数据/);
    assert.match(html, /保留布尔/);
    assert.match(html, /默认零值/);
    assert.match(html, /否/);
  }
  const table = renderToStaticMarkup(
    <DocumentTable
      documents={[empty]}
      documentType={type}
      layout={{ type: "table", fields: ["zero", "active"], description: false }}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />,
  );
  assert.doesNotMatch(table, /<td[^>]*>0<|—/);
  assert.match(table, /否/);
  const filled = {
    ...values,
    zero: 3,
    text: "眩晕",
    effects: ["中毒"],
    rows: [{ id: "a", value: 2 }],
  };
  for (const node of [
    <DocumentDetail document={{ ...empty, values: filled }} documentType={type} />,
    <CharacterSheet sheet={buildCharacterSheet(type, filled)} />,
  ]) {
    const stream = await renderToReadableStream(node);
    await stream.allReady;
    const html = await new Response(stream).text();
    for (const label of ["空数值", "空文本", "空效果", "空集合", "中毒"])
      assert.ok(html.includes(label), label);
  }
  assert.equal(values.zero, 0);
  assert.deepEqual(values.effects, []);
});

test("计算 null 未配置或关闭空值隐藏时保留字段，显式启用才隐藏", async () => {
  const base = validateDocumentType("角色", {
    fields: {
      defaultNull: { type: "text", label: "默认空结果", compute: "null" },
      shownNull: { type: "number", label: "关闭隐藏的结果", compute: "null", hideWhenEmpty: false },
      hiddenNull: { type: "text", label: "明确隐藏的结果", compute: "null", hideWhenEmpty: true },
      rows: {
        type: "list",
        label: "无值表格",
        compute: "null",
        item: { type: "object", fields: { id: { type: "text" } } },
      },
      details: {
        type: "object",
        label: "嵌套资料",
        fields: { nullValue: { type: "text", label: "嵌套空结果", compute: "null" } },
      },
    },
  });
  const fields = base.fields.map((field) => field.key);
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "grid",
        fields,
        fieldViews: { rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "id" }] } },
      },
      hover: { fields },
    }),
  };
  const { values } = await evaluateComputedFields(
    { identity: "角色/测试", documentType: type, values: { details: {} } },
    undefined,
    { strict: true },
  );
  const projected = { ...document, docType: "角色", values };
  assert.deepEqual(
    getPreviewFields(projected, type, fields).map((entry) => entry.label),
    ["默认空结果", "关闭隐藏的结果", "无值表格", "嵌套资料"],
  );
  const detail = await render(<DocumentDetail document={projected} documentType={type} />);
  const sheet = await render(<CharacterSheet sheet={buildCharacterSheet(type, values)} />);
  const summary = await render(<DocumentPreview document={projected} documentType={type} />);
  for (const html of [detail, sheet, summary]) {
    assert.match(html, /默认空结果/);
    assert.match(html, /关闭隐藏的结果/);
    assert.match(html, /无值表格/);
    assert.match(html, /暂无数据/);
    assert.doesNotMatch(html, /明确隐藏的结果|数据无效/);
  }
  assert.match(detail, /嵌套空结果/);
});

test("计算错误优先于空值隐藏，角色卡、详情、摘要和表格清楚区分暂无数据与失败", async () => {
  const base = validateDocumentType("角色", {
    fields: {
      empty: { type: "text", label: "正常空结果", compute: "null" },
      hidden: { type: "text", label: "隐藏空结果", compute: "null", hideWhenEmpty: true },
      bad: {
        type: "number",
        label: "失败字段",
        compute: "(() => { throw new Error('可展开原因'); })()",
        hideWhenEmpty: true,
      },
      details: {
        type: "object",
        label: "嵌套资料",
        fields: {
          value: { type: "number", label: "嵌套失败", compute: "undefined", hideWhenEmpty: true },
        },
      },
      stats: {
        type: "object",
        compute: "undefined",
        fields: { current: { type: "number", label: "父级失败的数值", hideWhenEmpty: true } },
      },
      rows: {
        type: "list",
        label: "记录",
        item: {
          type: "object",
          fields: {
            id: { type: "text" },
            value: { type: "number", label: "条目数值", compute: "undefined", hideWhenEmpty: true },
          },
        },
      },
      description: { type: "text", compute: "undefined" },
    },
  });
  const fields = ["empty", "hidden", "bad", "details", "stats.current", "rows"];
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "grid",
        fields,
        fieldViews: { rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "value" }] } },
      },
      hover: { fields },
    }),
  };
  const result = await evaluateComputedFields({
    identity: "角色/错误",
    documentType: type,
    values: { details: {}, rows: [{ id: "a" }] },
  });
  const projected = {
    ...document,
    docType: "角色",
    values: result.values,
    fieldErrors: result.fieldErrors,
  };
  const detail = await render(<DocumentDetail document={projected} documentType={type} />);
  const sheet = await render(
    <CharacterSheet
      sheet={buildCharacterSheet(type, result.values, undefined, result.fieldErrors)}
    />,
  );
  const summary = await render(<DocumentPreview document={projected} documentType={type} />);
  const table = await render(
    <DocumentTable
      documents={[projected]}
      documentType={type}
      layout={{ type: "table", fields: ["empty", "bad"], description: false }}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />,
  );
  for (const html of [detail, sheet, summary, table]) {
    assert.match(html, /正常空结果/);
    assert.match(html, /暂无数据/);
    assert.match(html, /失败字段/);
    assert.match(html, /计算失败/);
    assert.match(html, /可展开原因/);
    assert.match(html, /<details[^>]*role="alert"/);
    assert.doesNotMatch(html, /隐藏空结果|未填写|数据无效/);
  }
  assert.match(detail, /嵌套失败/);
  assert.match(detail, /父级失败的数值/);
  assert.match(detail, /条目数值/);
  assert.match(detail, /简介/);
  const cardHtml = await render(<DocumentCardContent document={projected} documentType={type} />);
  assert.match(cardHtml, /简介/);
  assert.match(cardHtml, /计算失败/);
  const directoryHtml = await render(
    <DocumentTable
      documents={[projected]}
      documentType={type}
      layout={{ type: "table", fields: [], description: true }}
      selectedDocumentPath={null}
      onSelectDocument={() => {}}
    />,
  );
  assert.match(directoryHtml, /用途与说明/);
  assert.match(directoryHtml, /计算失败/);

  assert.match(summary, /父级失败的数值/);
});

test("摘要卡片与悬浮内容独立使用 HBS，保留附加摘要并过滤秘密与隐藏文档", async () => {
  const custom = {
    ...type,
    layout: validateDocumentLayout(type, {
      card: {
        content: {
          type: "handlebars",
          template: "<h3>列表 {{name}}</h3><strong>{{values.hp}}</strong><p>{{values.secret}}</p>",
        },
      },
      hover: {
        width: "lg",
        content: {
          type: "handlebars",
          template: "<p>悬浮 {{name}}：{{values.hp}}</p><p>{{values.secret}}</p>",
        },
      },
    }),
  };
  const card = await render(<DocumentCardContent document={document} documentType={custom} />);
  const hover = await render(
    <DocumentPreview document={document} documentType={custom}>
      <p>实例摘要</p>
    </DocumentPreview>,
  );
  assert.match(card, /tarp-hbs-renderer/);
  assert.match(card, /列表 沈莺/);
  assert.ok(!card.includes("悬浮 沈莺"));
  assert.match(hover, /tarp-hbs-renderer/);
  assert.match(hover, /悬浮 沈莺/);
  assert.match(hover, /实例摘要/);
  for (const html of [card, hover]) {
    assert.ok(!html.includes("秘密不应出现"));
    assert.ok(!html.includes("公开简介"));
  }
  const changed = await render(
    <DocumentPreview
      document={{ ...document, values: { ...document.values, hp: 3 } }}
      documentType={custom}
    />,
  );
  assert.match(changed, /3/);
  for (const node of [
    <DocumentCardContent document={{ ...document, visible: false }} documentType={custom} />,
    <DocumentPreview document={{ ...document, visible: false }} documentType={custom} />,
    <DocumentPreview
      document={document}
      documentType={{
        ...custom,
        layout: { ...custom.layout, hover: { ...custom.layout!.hover!, enabled: false } },
      }}
    />,
  ])
    assert.equal(await render(node), "");
});

test("HBS 直接组合引用和物品格，不附带平台字段标题、计数或工具栏", async () => {
  const base = validateDocumentType("自由角色", {
    fields: {
      weapon: { type: "reference", targets: ["物品"] },
      capacity: { type: "number" },
      inventory: {
        type: "list",
        item: {
          type: "object",
          fields: { item: { type: "reference", targets: ["物品"] }, quantity: { type: "number" } },
        },
      },
    },
  });
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "handlebars",
        template:
          '<h3>自定行装</h3><p>共 {{values.capacity}} 位</p><tarp-reference field="weapon"></tarp-reference><tarp-item-grid field="inventory" reference-field="item" quantity-field="quantity" capacity="{{values.capacity}}" label="自定格子"></tarp-item-grid>',
      },
    }),
  };
  const doc = {
    path: "自由角色/甲.json",
    title: "甲",
    valid: true,
    values: { weapon: "物品/短剑", capacity: 3, inventory: [{ item: "物品/短剑", quantity: 2 }] },
  };
  const html = await render(
    <DocumentReferences
      documents={[{ path: "物品/短剑", title: "铁剑", docType: "物品", valid: true }]}
      types={[type]}
    >
      <DocumentDetail document={doc} documentType={type} />
    </DocumentReferences>,
  );
  assert.match(html, /自定行装/);
  assert.match(html, /共 3 位/);
  assert.match(html, /铁剑/);
  assert.match(html, /data-inventory-slots/);
  assert.match(html, /数量 2/);
  for (const text of ['role="status"', 'role="searchbox"', "展示方式", "3 格", "1 / 3"])
    assert.ok(!html.includes(text), text);
});
