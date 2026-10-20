import { describe, test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  validateDocumentLayout,
  validateDocumentType,
  validateDocumentValues,
  validateComputedValue,
} from "./document-type";
import { validateFieldTableRows } from "./field-table";

function parseField(field: Record<string, unknown>) {
  return validateDocumentType("人物", { fields: { secret: field } });
}

describe("多场景展示配置", () => {
  const type = validateDocumentType("人物", {
    fields: {
      hp: { type: "number" },
      secret: { type: "text", visibility: "gm" },
      hidden: { type: "object", visibility: "gm", fields: { name: { type: "text" } } },
    },
  });
  const detail = { type: "grid", columns: 1, fields: ["hp", "secret"] };
  test("各场景允许复用字段，未配置的预览不继承秘密", () => {
    const layout = validateDocumentLayout(type, {
      detail,
      card: { fields: ["hp"] },
      hover: { fields: ["hp"], width: "lg" },
      reference: { style: "badge" },
    });
    assert.deepEqual(layout.fields, ["hp", "secret"]);
    assert.deepEqual(layout.card?.fields, ["hp"]);
    assert.equal(layout.hover?.width, "lg");
    assert.equal(layout.reference?.style, "badge");
    const defaults = validateDocumentLayout(type, { detail });
    assert.deepEqual(defaults.hover?.fields, []);
    assert.equal(defaults.hover?.enabled, true);
    for (const config of [
      defaults,
      validateDocumentLayout(type, { detail, card: {}, hover: {} }),
    ]) {
      assert.equal(config.card?.descriptionLines, 2);
      assert.equal(config.hover?.descriptionLines, 5);
    }
  });
  test("图片比例按展示入口独立配置，并拒绝零值、非法格式和样式注入", () => {
    const layout = validateDocumentLayout(type, {
      detail: { type: "split", fields: ["hp"], imageAspect: "2:3" },
      card: { imageAspect: "16:9" },
      hover: { imageAspect: "portrait" },
    });
    assert.equal(layout.type === "split" && layout.imageAspect, "2:3");
    assert.equal(layout.card?.imageAspect, "16:9");
    assert.equal(layout.hover?.imageAspect, "portrait");
    const defaults = validateDocumentLayout(type, { detail });
    assert.equal(defaults.card?.imageAspect, "square");
    assert.equal(defaults.hover?.imageAspect, "square");
    for (const scene of ["detail", "card", "hover"]) {
      for (const imageAspect of [
        "square",
        "portrait",
        "landscape",
        "1:1",
        "4:5",
        "16:9",
        "9999:1",
      ]) {
        assert.doesNotThrow(() =>
          validateDocumentLayout(type, {
            detail,
            [scene]:
              scene === "detail" ? { type: "split", fields: ["hp"], imageAspect } : { imageAspect },
          }),
        );
      }
      for (const imageAspect of [
        "0:1",
        "1:0",
        "-1:2",
        "1:10000",
        "16/9",
        "auto",
        "1:1;color:red",
        1,
        null,
      ]) {
        assert.throws(
          () =>
            validateDocumentLayout(type, {
              detail,
              [scene]:
                scene === "detail"
                  ? { type: "split", fields: ["hp"], imageAspect }
                  : { imageAspect },
            }),
          /imageAspect/,
        );
      }
    }
  });
  test("拒绝未知配置、重复字段和未声明字段，布局允许指定主持字段", () => {
    for (const scene of ["hover", "card"]) {
      for (const fields of [["hp", "hp"], ["missing"]]) {
        assert.throws(
          () => validateDocumentLayout(type, { detail, [scene]: { fields } }),
          new RegExp(scene),
        );
      }
      assert.doesNotThrow(() =>
        validateDocumentLayout(type, {
          detail,
          [scene]: { fields: ["secret", "hidden.name"] },
        }),
      );
    }
    assert.throws(() => validateDocumentLayout(type, { detail, hvoer: {} }), /hvoer/);
    assert.throws(
      () => validateDocumentLayout(type, { detail, hover: { descriptionLines: 99 } }),
      /descriptionLines/,
    );
    assert.throws(
      () => validateDocumentLayout(type, { detail, hover: { css: "anything" } }),
      /css/,
    );
  });
});

test("表格对实际行标识校验非空与唯一，零有效且过滤前统一校验", () => {
  const base = validateDocumentType("表格", {
    fields: {
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            id: { type: "text" },
            value: { type: "number" },
          },
        },
      },
    },
  });
  const config = { type: "FieldTable" as const, rowKey: "id", columns: [{ field: "value" }] };
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "grid",
        fields: ["rows"],
        fieldViews: { rows: config },
      },
    }),
  };
  for (const rows of [[{}], [{ id: "" }], [{ id: "   " }], [{ id: "same" }, { id: "same" }]])
    assert.throws(() => validateDocumentValues(type, { rows }), /行标识|重复/);
  assert.doesNotThrow(() => validateDocumentValues(type, { rows: [{ id: "a" }, { id: "b" }] }));
  assert.doesNotThrow(() => validateDocumentValues(type, {}));
  assert.doesNotThrow(() => validateFieldTableRows([{ id: 0 }, { id: 1 }], config));
  assert.throws(() => validateFieldTableRows([{ id: 0 }, { id: "0" }], config), /重复/);
});

test("模板面板独立于简单详情选字段，组件类型与绑定严格校验", () => {
  const type = validateDocumentType("角色", {
    fields: { current: { type: "number" }, limit: { type: "number" }, nameText: { type: "text" } },
  });
  const detail = { type: "grid", fields: ["nameText"] };
  const layout = validateDocumentLayout(type, {
    detail,
    sheet: {
      type: "handlebars",
      template: '<meter value="{{values.current}}" max="{{values.limit}}"></meter>',
    },
  });
  assert.equal(layout.sheet?.type, "handlebars");
  for (const sheet of [
    { root: { type: "resource", field: "current", max: "limit" } },
    {
      type: "handlebars",
      template: '<tarp-resource field="current" max="nameText"></tarp-resource>',
    },
    { type: "handlebars", template: '<tarp-image field="missing"></tarp-image>' },
    { type: "handlebars", template: '<tarp-slot name="unknown"></tarp-slot>' },
    {
      type: "handlebars",
      template: '<tarp-slot name="invalid"></tarp-slot>',
      components: { invalid: { type: "grid", children: [] } },
    },
  ])
    assert.throws(() => validateDocumentLayout(type, { detail, sheet }), /layout/);
  const sheetOnly = validateDocumentLayout(type, {
    sheet: { type: "handlebars", template: "{{name}}" },
  });
  assert.equal(sheetOnly.type, "grid");
});

test("双栏布局验证两侧字段并提供默认值", () => {
  const type = validateDocumentType("人物", {
    fields: { hp: { type: "number" }, secret: { type: "text" } },
  });
  const layout = validateDocumentLayout(type, {
    detail: {
      type: "split",
      fields: ["hp"],
      contentFields: ["secret"],
    },
  });
  assert.equal(layout.type, "split");
  if (layout.type !== "split") throw new Error("预期双栏布局");
  assert.equal(layout.imageAspect, "square");
  assert.equal(layout.columns, 2);
  assert.deepEqual(layout.contentFields, ["secret"]);
  assert.throws(
    () =>
      validateDocumentLayout(type, {
        detail: {
          type: "split",
          fields: ["hp"],
          contentFields: ["hp"],
        },
      }),
    /字段不能重复/,
  );
  assert.throws(
    () =>
      validateDocumentLayout(type, {
        detail: {
          type: "split",
          fields: ["hp"],
          contentFields: ["missing"],
        },
      }),
    /不存在/,
  );
  assert.throws(
    () =>
      validateDocumentLayout(type, {
        detail: {
          type: "split",
          fields: ["hp"],
          imageAspect: "invalid",
        },
      }),
    /imageAspect/,
  );
});

describe("字段可见性定义", () => {
  test("省略 visibility 默认公开", () => {
    const type = parseField({ type: "text" });
    assert.equal(type.fields[0]?.visibility, "public");
  });

  test("保留 GM 声明，但不执行内容过滤", () => {
    const gm = parseField({ type: "text", visibility: "gm" });
    assert.equal(gm.fields[0]?.visibility, "gm");
    assert.deepEqual(validateDocumentValues(gm, { secret: "秘密" }), { secret: "秘密" });
  });

  test("拒绝非法可见性", () => {
    for (const config of [{ visibility: "unknown" }, { visibility: null }]) {
      assert.throws(
        () => parseField({ type: "text", ...config }),
        /人物.fields.secret/,
        JSON.stringify(config),
      );
    }
  });

  test("对象和对象列表子字段使用相同默认值与校验", () => {
    for (const wrap of [
      (fields: unknown) => ({ type: "object", fields }),
      (fields: unknown) => ({ type: "list", item: { type: "object", fields } }),
    ]) {
      const type = parseField(wrap({ clue: { type: "text" } }));
      const parent = type.fields[0]!;
      assert.equal((parent.fields ?? parent.item?.fields)?.[0]?.visibility, "public");
      assert.throws(
        () => parseField(wrap({ clue: { type: "text", visibility: "unknown" } })),
        /clue.visibility/,
      );
    }
  });
});

describe("字段运行时修改标记", () => {
  test("默认只读，显式 mutable 才可修改", () => {
    assert.equal(parseField({ type: "number" }).fields[0]?.mutable, false);
    assert.equal(parseField({ type: "number", mutable: true }).fields[0]?.mutable, true);
  });

  test("嵌套字段保留各自标记，计算字段不能 mutable", () => {
    const type = parseField({
      type: "object",
      mutable: false,
      fields: { value: { type: "number", mutable: true } },
    });
    assert.equal(type.fields[0]?.mutable, false);
    assert.equal(type.fields[0]?.fields?.[0]?.mutable, true);
    assert.throws(
      () => parseField({ type: "number", compute: "1", mutable: true }),
      /计算字段不能标记为运行时可修改/,
    );
  });
});

describe("文档布局顺序", () => {
  const type = validateDocumentType("人物", { fields: { hp: { type: "number" } } });
  const detail = { type: "grid", fields: ["hp"] };

  test("默认顺序包含字段、简介和正文，保留自定义顺序并拒绝重复区块", () => {
    assert.deepEqual(validateDocumentLayout(type, { detail }).order, [
      "fields",
      "description",
      "body",
    ]);
    assert.deepEqual(
      validateDocumentLayout(type, {
        detail: { ...detail, order: ["description", "body", "fields"] },
      }).order,
      ["description", "body", "fields"],
    );
    assert.throws(
      () =>
        validateDocumentLayout(type, {
          detail: { ...detail, order: ["fields", "description", "description"] },
        }),
      /展示区块不能重复/,
    );
  });
});

test("内置展示字段允许保存原值，原值与计算结果分别校验", () => {
  const type = validateDocumentType("线索", {
    fields: {
      name: { type: "text", compute: "$self.trueName" },
      body: { type: "text", compute: "null" },
      avatar: { type: "text", mutable: true, visibility: "gm" },
      trueName: { type: "text", visibility: "gm" },
    },
  });
  assert.doesNotThrow(() => validateDocumentValues(type, { trueName: "刻痕", avatar: "头像.png" }));
  for (const key of ["name", "body"])
    assert.doesNotThrow(() => validateDocumentValues(type, { [key]: "原值" }));
  assert.throws(() => validateDocumentValues(type, { body: 7 }), /body/);
  assert.throws(
    () => validateDocumentType("错误类型", { fields: { name: { type: "number" } } }),
    /必须是 text/,
  );
  const name = type.fields.find((field) => field.key === "name")!;
  const body = type.fields.find((field) => field.key === "body")!;
  for (const invalid of [null, undefined, "", "  ", 7])
    assert.throws(() => validateComputedValue(type, name, invalid), /计算结果无效/);
  assert.equal(validateComputedValue(type, body, null), null);
  assert.equal(validateComputedValue(type, body, ""), "");
});

test("类型配置拒绝未知字段", () => {
  for (const key of ["unknownOption", "fileds"]) {
    assert.throws(
      () => validateDocumentType("线索", { [key]: {} }),
      new RegExp(`线索\\.根节点：.*${key}`),
    );
  }
  for (const field of [
    { type: "text", lable: "拼写错误" },
    { type: "object", fields: { child: { type: "text", lable: "拼写错误" } } },
    { type: "list", item: { type: "text", lable: "拼写错误" } },
  ])
    assert.throws(() => parseField(field), /lable/);
});

test("空值隐藏可以与修改和计算配置共存，不改变原始值的校验", () => {
  const type = validateDocumentType("角色", {
    fields: {
      count: { type: "number", required: true, mutable: true, hideWhenEmpty: true },
      effects: { type: "list", mutable: true, hideWhenEmpty: true, item: { type: "text" } },
      derived: { type: "number", compute: "$self.count + 1", hideWhenEmpty: true },
      details: { type: "object", fields: { note: { type: "text", hideWhenEmpty: true } } },
    },
  });
  assert.equal(type.fields[0].hideWhenEmpty, true);
  assert.equal(type.fields[3].fields?.[0].hideWhenEmpty, true);
  const values = { count: 0, effects: [] };
  assert.deepEqual(validateDocumentValues(type, values), values);
  assert.throws(() => validateDocumentValues(type, { effects: [] }), /count/);
  assert.throws(() => validateDocumentValues(type, { count: null }), /count/);
  assert.throws(() => parseField({ type: "text", hideWhenEmpty: "true" }), /hideWhenEmpty/);
});

test("保留简单网格预设并拒绝递归 JSON 排版树", () => {
  const type = validateDocumentType("属性表", { fields: { hp: { type: "number" } } });
  const grid = validateDocumentLayout(type, {
    detail: { type: "grid", columns: 3, fields: ["hp"] },
  });
  assert.equal(grid.type, "grid");
  for (const detail of [
    { type: "layout", page: { root: { type: "grid", children: [] } } },
    { type: "grid", columns: 3, children: [{ type: "field", field: "hp" }] },
    { type: "stack", direction: "vertical", children: [] },
  ])
    assert.throws(() => validateDocumentLayout(type, { detail }), /layout/);
});

test("卡片与悬浮模板独立校验字段、组件与动态输出入口", () => {
  const type = validateDocumentType("模板", { fields: { hp: { type: "number" } } });
  for (const scene of ["card", "hover"]) {
    assert.throws(
      () =>
        validateDocumentLayout(type, {
          [scene]: {
            content: { type: "handlebars", template: '<tarp-image field="missing"></tarp-image>' },
          },
        }),
      /missing/,
    );
    assert.throws(
      () =>
        validateDocumentLayout(type, {
          [scene]: { content: { type: "handlebars", template: "<script>alert(1)</script>" } },
        }),
      /script/,
    );
  }
});

test("模板原语接受直接属性并拒绝旧字段组件、命名 slot 和非法绑定", () => {
  const type = validateDocumentType("角色", {
    fields: {
      inventory: { type: "list", item: { type: "reference", targets: ["物品"] } },
      weapon: { type: "reference", targets: ["物品"] },
      hp: { type: "number" },
    },
  });
  assert.doesNotThrow(() =>
    validateDocumentLayout(type, {
      sheet: {
        type: "handlebars",
        template:
          '<tarp-item-grid field="inventory" capacity="8"></tarp-item-grid><tarp-reference field="weapon"></tarp-reference>',
      },
    }),
  );
  for (const template of [
    '<tarp-field field="hp"></tarp-field>',
    '<tarp-slot name="x"></tarp-slot>',
    '<tarp-reference field="hp"></tarp-reference>',
    '<tarp-reference field="weapon" value="物品/甲"></tarp-reference>',
    '<tarp-item-grid field="inventory" capacity="NaN"></tarp-item-grid>',
    '<tarp-item-grid field="inventory" capacity="201"></tarp-item-grid>',
  ])
    assert.throws(() => validateDocumentLayout(type, { sheet: { type: "handlebars", template } }));
  assert.throws(() =>
    validateDocumentLayout(type, {
      sheet: { type: "handlebars", template: "{{values.hp}}", components: {} },
    }),
  );
});

test("角色卡宿主宽度可省略，显式值仅接受有界整数像素", () => {
  const type = validateDocumentType("角色", {});
  const sheet = { type: "handlebars", template: "{{name}}" };
  assert.equal(validateDocumentLayout(type, { sheet }).sheet?.width, undefined);
  for (const width of [240, 360, 480, 960])
    assert.equal(validateDocumentLayout(type, { sheet: { ...sheet, width } }).sheet?.width, width);
  for (const width of [0, 239, 961, 360.5, "480", null])
    assert.throws(() => validateDocumentLayout(type, { sheet: { ...sheet, width } }), /width/);
  assert.equal(validateDocumentLayout(type, { detail: { ...sheet, width: 480 } }).width, 480);
});

test("详情弹窗宽度适用于 grid、split 与 HBS，拒绝非法值且不覆盖角色卡宽度", () => {
  const type = validateDocumentType("物品", { fields: { hp: { type: "number" } } });
  for (const detail of [
    { type: "grid", fields: ["hp"] },
    { type: "split", fields: ["hp"] },
    { type: "handlebars", template: "{{name}}" },
  ]) {
    assert.equal(validateDocumentLayout(type, { detail }).width, undefined);
    for (const width of [240, 420, 800, 1600]) {
      const layout = validateDocumentLayout(type, {
        detail: { ...detail, width },
        sheet: { type: "handlebars", template: "{{name}}", width: 360 },
      });
      assert.equal(layout.width, width);
      assert.equal(layout.sheet?.width, 360);
    }
    for (const width of [0, 239, 1601, 420.5, "420", null])
      assert.throws(() => validateDocumentLayout(type, { detail: { ...detail, width } }), /width/);
  }
});
