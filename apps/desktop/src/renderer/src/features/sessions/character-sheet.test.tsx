import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

import { validateDocumentLayout, validateDocumentType } from "@jointarp/module/document-type";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

mock.module("../../desktop-rpc", () => ({ desktopRpc: { game: {} } }));
const { TooltipProvider } = await import("../../components/ui/tooltip");
const { getPreviewFields } = await import("../modules/document-preview");
const { DocumentDetail } = await import("../modules/DocumentDetail");
const { DocumentReferences } = await import("../modules/DocumentReferences");
const { buildCharacterSheet } = await import("./character-sheet");
const { CharacterSheet } = await import("./CharacterSheet");
const { WorldStateCard, WorldStateCardContent } = await import("./WorldStateCard");

const base = validateDocumentType("测试角色", {
  fields: {
    hp: { type: "number", label: "生命" },
    max: { type: "number", label: "生命上限" },
    strength: { type: "number", label: "力量" },
    note: { type: "text", label: "备注" },
    status: { type: "text", label: "行动" },
    burden: { type: "boolean" },
    secret: { type: "text", visibility: "gm" },
    effects: { type: "list", label: "异常", hideWhenEmpty: true, item: { type: "text" } },
  },
});
const panel = {
  type: "handlebars",
  template: `<h2>{{name}}</h2>
 {{#unless errors.hp}}{{#if values.max}}<meter aria-label="生命" value="{{values.hp}}" max="{{values.max}}" aria-valuetext="{{values.hp}} / {{values.max}}"></meter>{{/if}}{{/unless}}
 <div title="力量：{{values.strength}}\n说明：{{values.note}}">力量：{{values.strength}}<small>{{values.note}}</small></div>
 {{#if values.effects.length}}<details><summary>异常</summary>{{#each values.effects}}<p>{{this}}</p>{{/each}}</details>{{/if}}
 {{#if values.burden}}<p>满载</p>{{/if}}
 <p>生命 {{values.hp}}</p><p>{{values.status}}</p><p>{{values.secret}}</p>`,
};
const type = { ...base, layout: validateDocumentLayout(base, { detail: panel, sheet: panel }) };
async function render(node: ReactNode) {
  const stream = await renderToReadableStream(<TooltipProvider>{node}</TooltipProvider>);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}
const values = {
  hp: 4,
  max: 6,
  strength: 9,
  note: "擅长攀爬",
  status: "仍可行动",
  burden: false,
  effects: [],
  secret: "不要展示",
};

test("显式模板在详情和角色卡一致展示，属性小文字与自定义悬浮使用公开字段", async () => {
  const document = { path: "", title: "示例", description: "人物简介", valid: true, values };
  for (const node of [
    <CharacterSheet sheet={buildCharacterSheet(type, values, undefined, undefined, document)} />,
    <CharacterSheet
      sheet={buildCharacterSheet(type, values, undefined, undefined, document)}
      compact
    />,
    <DocumentDetail document={document} documentType={type} />,
  ]) {
    const html = await render(node);
    assert.ok(html.includes('<tarp-hbs-renderer data-document-renderer="handlebars"'));
    assert.ok(html.includes('shadowrootmode="open"'));
    assert.ok(html.includes("<meter"));
    assert.ok(html.includes('aria-valuetext="4 / 6"'));
    assert.ok(html.includes("擅长攀爬"));
    assert.ok(html.includes("力量：9\n说明：擅长攀爬"));
    assert.ok(!html.includes("受损"));
    assert.ok(html.includes("<small>"));
    assert.ok(html.includes("仍可行动"));
    for (const hidden of ['role="tab"', "不要展示", "人物简介", "满载", "异常"])
      assert.ok(!html.includes(hidden), hidden);
  }
});

test("Handlebars 在详情与面板复用条件、循环、partial 和组件，隔离秘密并随投影重绘", async () => {
  const templateBase = validateDocumentType("模板角色", {
    fields: {
      hp: { type: "number", label: "生命" },
      max: { type: "number" },
      name: { type: "text" },
      image: { type: "text" },
      secret: { type: "text", visibility: "gm" },
      details: {
        type: "object",
        fields: { public: { type: "text" }, secret: { type: "text", visibility: "gm" } },
      },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: { title: { type: "text" }, secret: { type: "text", visibility: "gm" } },
        },
      },
    },
  });
  const page = {
    root: {
      type: "handlebars",
      css: "h2 { text-align: center; }",
      template: `<h2>{{name}}</h2>{{> summary}}{{#if (eq values.hp 4)}}<p>仍可行动</p>{{/if}}
      <p>{{field "hp"}} {{field "constructor"}}</p><p>{{values.secret}} {{values.details.secret}} {{secret}}</p>
      <ul>{{#each values.rows}}<li>{{title}} {{secret}} {{@index}}</li>{{/each}}</ul>
      <img src="{{image}}" alt="肖像"><strong>余力 {{values.hp}}</strong>
      {{#unless errors.hp}}{{#if values.max}}<meter aria-label="生命" value="{{values.hp}}" max="{{values.max}}" aria-valuetext="{{values.hp}} / {{values.max}}"></meter>{{/if}}{{/unless}}<p>{{values.hp}}</p><p>剩余 {{values.hp}}/{{values.max}}</p>`,
      partials: { summary: "<p>{{values.details.public}}</p>" },
    },
  };
  const configured = {
    ...templateBase,
    layout: validateDocumentLayout(templateBase, { detail: page.root, sheet: page.root }),
  };
  const values = {
    hp: 4,
    max: 6,
    secret: "顶层秘密",
    details: { public: "公开说明", secret: "嵌套秘密" },
    rows: [{ title: "<script>纯文本</script>", secret: "行内秘密" }],
  };
  const document = {
    path: "角色/测试.json",
    title: "模板人物",
    image: "portrait.webp",
    valid: true,
    values,
  };
  for (const node of [
    <CharacterSheet
      sheet={buildCharacterSheet(configured, values, undefined, undefined, document)}
    />,
    <DocumentDetail document={document} documentType={configured} />,
  ]) {
    const html = await render(node);
    for (const text of [
      "模板人物",
      "公开说明",
      "仍可行动",
      "剩余 4/6",
      "余力",
      "portrait.webp",
      "&lt;script&gt;纯文本&lt;/script&gt;",
      'aria-valuetext="4 / 6"',
    ])
      assert.ok(html.includes(text), text);
    for (const hidden of ["顶层秘密", "嵌套秘密", "行内秘密", "<script>", "[native code]"])
      assert.ok(!html.includes(hidden), hidden);
  }
  const changed = await render(
    <CharacterSheet sheet={buildCharacterSheet(configured, { ...values, hp: 0 })} />,
  );
  assert.ok(changed.includes('aria-valuetext="0 / 6"'));
  assert.ok(!changed.includes("仍可行动"));
  const failed = await render(
    <CharacterSheet
      sheet={buildCharacterSheet(configured, values, undefined, { hp: "失败原因" })}
    />,
  );
  assert.ok(failed.includes("计算失败"));
  assert.ok(!failed.includes('aria-valuetext="4 / 6"'));
});

test("模板的输出校验、动态组件错误及缺失 partial 保留局部错误，不泄露旧内容", async () => {
  const make = (template: string) => ({
    ...base,
    layout: validateDocumentLayout(base, {
      detail: { type: "grid", fields: ["hp"] },
      sheet: { type: "handlebars", template },
    }),
  });
  for (const template of [
    "{{> missing}}",
    '<tarp-image field="{{values.status}}"></tarp-image>',
    "{{{values.status}}}",
  ]) {
    const configured = make(template);
    const html = await render(
      <CharacterSheet
        sheet={buildCharacterSheet(configured, { ...values, status: "<script>执行脚本</script>" })}
      />,
    );
    assert.ok(html.includes("失败") || html.includes("不存在"));
    assert.ok(!html.includes("<script>"));
  }
  const first = make("{{> summary}}");
  const second = make("{{> summary}}");
  first.layout.sheet!.partials = { summary: "第一份" };
  second.layout.sheet!.partials = { summary: "第二份" };
  assert.ok(
    (await render(<CharacterSheet sheet={buildCharacterSheet(first, values)} />)).includes(
      "第一份",
    ),
  );
  const html = await render(<CharacterSheet sheet={buildCharacterSheet(second, values)} />);
  assert.ok(html.includes("第二份"));
  assert.ok(!html.includes("第一份"));
});

test("普通属性使用 HBS 原样排版，失败值不回退旧内容", async () => {
  const html = await render(<CharacterSheet sheet={buildCharacterSheet(type, values)} />);
  assert.ok(html.includes("力量：9"));
  assert.ok(html.includes("<small>擅长攀爬</small>"));
  const failed = await render(
    <CharacterSheet sheet={buildCharacterSheet(type, values, undefined, { note: "失败" })} />,
  );
  assert.ok(failed.includes("计算失败"));
  assert.ok(failed.includes("力量：9"));
  assert.ok(!failed.includes("擅长攀爬"));
});

test("模板使用条件与原生折叠组织内容，不修改业务值", async () => {
  const original = JSON.stringify(values);
  const html = await render(
    <CharacterSheet
      sheet={buildCharacterSheet(type, { ...values, effects: ["受寒"], burden: true })}
    />,
  );
  assert.ok(html.includes("满载"));
  assert.ok(html.includes("受寒"));
  assert.ok(html.includes("<details>"));
  assert.equal(JSON.stringify(values), original);
});

test("缺少资源端点保留已有数字，计算失败不被空值或条件隐藏吞掉", async () => {
  const incomplete = await render(
    <CharacterSheet sheet={buildCharacterSheet(type, { ...values, max: undefined })} />,
  );
  assert.ok(!incomplete.includes('role="meter"'));
  assert.ok(incomplete.includes("生命"));
  const failed = await render(
    <CharacterSheet
      sheet={buildCharacterSheet(type, { ...values, hp: null, effects: null }, undefined, {
        hp: "错误",
        effects: "列表计算失败",
      })}
    />,
  );
  assert.ok(failed.includes("计算失败"));
  assert.ok(failed.includes("异常"));
});

test("未配置角色卡时按详情字段顺序单页展示，不猜测上限或展开未选字段", async () => {
  const fallback = {
    ...base,
    layout: validateDocumentLayout(base, { detail: { type: "grid", fields: ["status", "hp"] } }),
  };
  const html = await render(<CharacterSheet sheet={buildCharacterSheet(fallback, values)} />);
  assert.ok(html.indexOf("仍可行动") < html.indexOf("生命"));
  assert.ok(!html.includes("擅长攀爬"));
  assert.ok(!html.includes('role="tab"'));
});

test("临时字段共享于详情、角色卡和预览，失败独立于真实值", async () => {
  const presentation = {
    type: "text",
    label: "摘要",
    compute: "self => String(self.hp)",
    hideWhenEmpty: true,
  };
  const configured = {
    ...base,
    layout: validateDocumentLayout(base, {
      displayFields: { summary: presentation },
      detail: { type: "grid", fields: ["$display.summary", "hp"] },
      sheet: { type: "handlebars", template: "<p>{{display.summary}}</p>" },
      card: { fields: ["$display.summary"] },
      hover: { fields: ["$display.summary"] },
      list: { fields: ["$display.summary"] },
    }),
  };
  const document = {
    path: "",
    title: "示例",
    valid: true,
    values,
    displayValues: { summary: "生命四点" },
  };
  for (const node of [
    <DocumentDetail document={document} documentType={configured} />,
    <CharacterSheet
      sheet={buildCharacterSheet(configured, values, undefined, undefined, document)}
    />,
  ])
    assert.ok((await render(node)).includes("生命四点"));
  assert.equal(getPreviewFields(document, configured, ["$display.summary"])[0].text, "生命四点");
  const error = {
    ...document,
    displayValues: { summary: null },
    displayErrors: { summary: "失败" },
  };
  assert.equal(getPreviewFields(error, configured, ["$display.summary"])[0].text, "计算失败");
  assert.ok(
    (await render(<DocumentDetail document={error} documentType={configured} />)).includes(
      "计算失败",
    ),
  );
});

test("世界卡只展示显式 sheet，公开投影撤销后整区消失，计算错误不掩盖其他字段", async () => {
  const baseWorld = validateDocumentType("测试世界", {
    designation: "world_state",
    fields: {
      weather: { type: "text", label: "天气" },
      progress: { type: "number", label: "进度" },
      secret: { type: "text", visibility: "gm" },
    },
  });
  const world = {
    ...baseWorld,
    layout: validateDocumentLayout(baseWorld, {
      detail: { type: "grid", fields: ["weather", "progress"] },
      displayFields: {
        summary: { type: "text", label: "天气摘要", compute: "self => self.weather" },
      },
      sheet: {
        type: "handlebars",
        template:
          "<p>{{values.weather}}</p><p>{{display.summary}}</p><p>进度 {{values.progress}}</p><p>{{values.secret}}</p>",
      },
    }),
  };
  const document = {
    path: "",
    title: "探索状态",
    valid: true,
    values: { weather: "暴雨", progress: 3, secret: "幕后秘密" },
    displayValues: { summary: "洪水将至" },
  };
  const html = await render(<WorldStateCardContent document={document} documentType={world} />);
  assert.ok(html.includes("探索状态"));
  assert.ok(html.includes("暴雨"));
  assert.ok(html.includes("洪水将至"));
  assert.ok(html.includes("进度"));
  assert.ok(!html.includes("幕后秘密"));
  assert.ok(html.includes("<details open"));
  assert.equal(
    await render(<WorldStateCardContent document={document} documentType={baseWorld} />),
    "",
  );
  const guarded = { ...world, displayWhen: "false" };
  for (const visible of [false, undefined])
    assert.equal(
      await render(
        <WorldStateCardContent document={{ ...document, visible }} documentType={guarded} />,
      ),
      "",
    );
  const changed = await render(
    <WorldStateCardContent
      document={{
        ...document,
        visible: true,
        values: { weather: "晴朗", progress: null },
        fieldErrors: { progress: "错误" },
      }}
      documentType={guarded}
    />,
  );
  assert.ok(changed.includes("晴朗"));
  assert.ok(changed.includes("计算失败"));
  assert.ok(!changed.includes("暴雨"));
});

test("世界卡完整消费模组 sheet，区域、资源条和引用对象的卡片均由作者配置", async () => {
  const worldBase = validateDocumentType("测试世界", {
    designation: "world_state",
    fields: {
      danger: { type: "boolean" },
      opponents: { type: "list", item: { type: "reference", targets: [base.id] } },
    },
  });
  const world = {
    ...worldBase,
    layout: validateDocumentLayout(worldBase, {
      detail: { type: "grid", fields: ["opponents"] },
      sheet: {
        type: "handlebars",
        template:
          '{{#if values.danger}}<section><h3>交战对象</h3><p>观察对手，再决定行动。</p>{{#each values.opponents}}<tarp-reference value="{{this}}" display="sheet"></tarp-reference>{{/each}}</section>{{/if}}',
      },
    }),
  };
  const actor = {
    path: "测试角色/守卫.json",
    title: "守卫",
    docType: type.id,
    valid: true,
    values,
  };
  const document = {
    path: "测试世界/当前世界.json",
    title: "世界",
    valid: true,
    values: { danger: true, opponents: [actor.path] },
  };
  const draw = (danger = true, target = actor) =>
    render(
      <DocumentReferences documents={[target]} types={[world, type]}>
        <WorldStateCardContent
          document={{ ...document, values: { ...document.values, danger } }}
          documentType={world}
        />
      </DocumentReferences>,
    );
  let html = await draw();
  assert.ok(html.includes("交战对象"));
  assert.ok(html.includes("观察对手，再决定行动。"));
  assert.ok(html.includes("守卫"));
  assert.ok(html.includes('aria-valuetext="4 / 6"'));
  assert.ok(html.includes("仍可行动"));
  assert.ok(!html.includes("不要展示"));
  assert.ok(!html.includes('role="searchbox"'));
  html = await draw(false);
  assert.ok(!html.includes("交战对象"));
  assert.ok(!html.includes("仍可行动"));
  html = await draw(true, { ...actor, values: { ...values, hp: 0, status: "已失能" } });
  assert.ok(html.includes('aria-valuetext="0 / 6"'));
  assert.ok(html.includes("已失能"));
  assert.ok(!html.includes("仍可行动"));
  html = await draw(true, { ...actor, visible: false } as typeof actor);
  assert.ok(!html.includes("守卫"));
  assert.ok(!html.includes("仍可行动"));
});

test("多份世界文档按索引顺序展示各自标题与布局，隐藏或未配置的资料不占位", async () => {
  const makeType = (id: string, field: string) => {
    const type = validateDocumentType(id, {
      designation: "world_state",
      fields: { [field]: { type: "text" } },
    });
    return {
      ...type,
      layout: validateDocumentLayout(type, {
        detail: { type: "grid", fields: [field] },
        sheet: { type: "handlebars", template: `<p>{{values.${field}}}</p>` },
      }),
    };
  };
  const exploration = makeType("探索", "weather");
  const combat = makeType("战斗", "round");
  const noSheet = validateDocumentType("未展示", { designation: "world_state" });
  const documents = [
    {
      path: "探索/探索甲.json",
      docType: exploration.id,
      title: "北方探索",
      valid: true,
      values: { weather: "北方大雨" },
    },
    {
      path: "战斗/交战.json",
      docType: combat.id,
      title: "当前战斗",
      valid: true,
      values: { round: "第三回合" },
    },
    {
      path: "探索/探索乙.json",
      docType: exploration.id,
      title: "南方探索",
      valid: true,
      values: { weather: "南方晴朗" },
    },
    {
      path: "探索/秘密.json",
      docType: exploration.id,
      title: "秘密状态",
      valid: true,
      visible: false,
      values: { weather: "秘密天气" },
    },
    { path: "未展示/普通.json", docType: noSheet.id, title: "未配置卡片", valid: true },
    { path: "测试角色/普通.json", docType: type.id, title: "普通资料", valid: true, values },
  ];
  const session = {
    room: {
      id: "test",
      name: "测试",
      moduleName: "测试",
      status: "active" as const,
      createdAt: "",
      updatedAt: "",
    },
    module: { name: "测试" },
    documentTypes: [combat, noSheet, exploration, type],
    documents,
    pages: [],
  };
  let html = await render(<WorldStateCard session={session} />);
  for (const text of ["北方探索", "当前战斗", "南方探索", "北方大雨", "第三回合", "南方晴朗"])
    assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("北方探索") < html.indexOf("当前战斗"));
  assert.ok(html.indexOf("当前战斗") < html.indexOf("南方探索"));
  for (const text of ["秘密状态", "秘密天气", "未配置卡片", "普通资料"])
    assert.ok(!html.includes(text), text);
  html = await render(
    <WorldStateCard
      session={{
        ...session,
        documents: documents.filter((document) => document.docType !== combat.id),
      }}
    />,
  );
  assert.ok(!html.includes("当前战斗"));
  assert.ok(html.includes("南方晴朗"));
});
