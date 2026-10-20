import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { publicValues } from "../schema/character";
import { evaluateComputedFields, type ComputedDocumentInput } from "../schema/computed-fields";
import { DocumentEvaluator, type ParsedModuleDocument } from "../schema/document-evaluator";
import { documentIdentity } from "../schema/document-path";
import { validateDocumentType, validateDocumentValues } from "../schema/document-type";
import { validateInstanceBindings } from "../schema/instance-state";
import {
  createTestModule,
  type TestAbility,
  type TestCharacterValues,
} from "../testing/test-module";
import { loadDocumentTypes } from "./document-types";
import { loadModuleDocuments } from "./module-documents";

async function fixture() {
  const f = await createTestModule();
  try {
    const types = await loadDocumentTypes(f.modulePath);
    const type = types.find((item) => item.id === "角色")!;
    const documents = await loadModuleDocuments(f.modulePath, types);
    assert.deepEqual(
      documents.filter((document) => !document.valid),
      [],
    );
    const references: Record<string, Record<string, unknown> & { name: string }> =
      Object.fromEntries(
        documents
          .filter((document) => document.docType === "能力")
          .map((document) => [
            documentIdentity(document.path),
            { ...document.values, name: document.title },
          ]),
      );
    const source: TestCharacterValues = JSON.parse(
      await readFile(join(f.modulePath, "角色/向导.json"), "utf8"),
    );
    const resolveAbilities = async (
      input: TestCharacterValues,
      refs = references,
      strict = false,
    ) => {
      const targets = new Map<string, ComputedDocumentInput>(
        Object.entries(refs).map(([identity, values]) => [
          identity,
          { identity, documentType: types.find((item) => item.id === "能力")!, values },
        ]),
      );
      const result = await evaluateComputedFields(
        {
          identity: "角色/向导",
          documentType: type,
          values: validateDocumentValues(type, input),
        },
        (_, reference) => targets.get(reference) ?? null,
        { strict },
      );
      return result.values.abilities as TestAbility[];
    };
    return { ...f, documents, references, source, resolveAbilities };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

test("引用列表计算跟随属性、调整值、显式零覆盖及引用源更新", async () => {
  const f = await fixture();
  try {
    const input: TestCharacterValues = {
      ...f.source,
      stats: { ...f.source.stats, agility: 14, insight: 9 },
      ability_records: [
        { document: "能力/修补", growth: 4 },
        { document: "能力/攀行", bonus: 2 },
        { document: "能力/观察", override: 0 },
        { document: "能力/投掷", bonus: 3 },
      ],
    };
    assert.deepEqual(await f.resolveAbilities(input), [
      { document: "能力/修补", name: "修补", base: 3, value: 7 },
      { document: "能力/攀行", name: "攀行", base: 4, value: 6 },
      { document: "能力/观察", name: "观察", base: 9, value: 0 },
      { document: "能力/投掷", name: "投掷", base: 7, value: 10 },
    ]);
    const updated = structuredClone(f.references);
    updated["能力/修补"].base_value = 6;
    updated["能力/修补"].name = "器具修补";
    assert.deepEqual((await f.resolveAbilities(input, updated))[0], {
      document: "能力/修补",
      name: "器具修补",
      base: 6,
      value: 10,
    });
  } finally {
    await f.cleanup();
  }
});

test("计算列表仅输出有效个人记录，空输入和新增引用无需重复目录", async () => {
  const f = await fixture();
  try {
    for (const character of f.documents.filter((document) => document.docType === "角色")) {
      const raw: TestCharacterValues = JSON.parse(
        await readFile(join(f.modulePath, character.path), "utf8"),
      );
      assert.equal(Object.hasOwn(raw, "abilities"), false);
      assert.equal(
        (character.values!.abilities as TestAbility[]).length,
        raw.ability_records!.length,
      );
      for (const record of raw.ability_records!) {
        assert.equal(Object.hasOwn(record, "base"), false);
        assert.equal(Object.hasOwn(record, "name"), false);
      }
    }
    assert.deepEqual(await f.resolveAbilities({ ...f.source, ability_records: undefined }), []);
    assert.deepEqual(await f.resolveAbilities({ ...f.source, ability_records: [] }), []);
    assert.deepEqual(
      await f.resolveAbilities(
        {
          ...f.source,
          ability_records: [
            { document: "能力/修补" },
            { document: "能力/攀行", bonus: 0 },
            { document: "能力/观察", growth: 0 },
            { document: "能力/新增", growth: 2 },
          ],
        },
        {
          ...f.references,
          "能力/新增": { name: "新增能力", base_value: 10, kind: "fixed" },
        },
      ),
      [{ document: "能力/新增", name: "新增能力", base: 10, value: 12 }],
    );
  } finally {
    await f.cleanup();
  }
});

test("公式错误展示隐藏，写入校验仍拒绝重复记录、负数、失效引用和不适用文档", async () => {
  const f = await fixture();
  try {
    for (const [records, error] of [
      [[{ document: "能力/不存在" }], /无效的能力引用/],
      [[{ document: "能力/索引" }], /无效的能力引用/],
      [[{ document: "能力/修补" }, { document: "能力/修补" }], /能力记录重复/],
      [[{ document: "能力/修补", override: -1 }], /不能为负数/],
      [[{ document: "能力/储备", growth: 1 }], /通过角色字段维护/],
    ] as const) {
      await assert.rejects(
        f.resolveAbilities({ ...f.source, ability_records: [...records] }, f.references, true),
        error,
      );
      assert.equal(await f.resolveAbilities({ ...f.source, ability_records: [...records] }), null);
    }
  } finally {
    await f.cleanup();
  }
});

function instanceFixture() {
  const holderType = validateDocumentType("持有者", {
    fields: {
      world: { type: "reference", targets: ["时钟"], required: true, visibility: "gm" },
      items: {
        type: "list",
        mutable: true,
        item: {
          type: "object",
          instance: { referenceField: "definition", stateField: "state" },
          fields: {
            definition: { type: "reference", targets: ["道具"], required: true },
            location: { type: "text", mutable: true },
          },
        },
      },
      total: { type: "number", compute: "sum($self.items, row => row.state.remaining ?? 0)" },
    },
  });
  const definitionType = validateDocumentType("道具", {
    fields: { factor: { type: "number", mutable: true } },
  });
  const clockType = validateDocumentType("时钟", {
    fields: { elapsed: { type: "number", mutable: true } },
  });
  const input: ComputedDocumentInput = {
    identity: "持有者/甲",
    documentType: holderType,
    values: {
      world: "时钟/当前",
      items: [
        {
          definition: "道具/计时器",
          state: { budget: 20, end: 15, secret: "幕后甲", fixed: "原始编号" },
        },
        {
          definition: "道具/计时器",
          state: { budget: 30, secret: "幕后乙", fixed: "另一编号" },
        },
        { definition: "道具/开关", state: { active: true } },
      ],
    },
  };
  const targets = new Map<string, ComputedDocumentInput>([
    [
      "道具/计时器",
      {
        identity: "道具/计时器",
        documentType: definitionType,
        values: {
          factor: 2,
          instance: {
            fields: {
              budget: { type: "number", required: true, mutable: true },
              end: { type: "number", mutable: true },
              secret: { type: "text", mutable: true, visibility: "gm" },
              fixed: { type: "text", required: true },
              remaining: {
                type: "number",
                compute:
                  "($item.end == null ? $item.budget : max(0, $item.end - load($self.world).elapsed)) * $definition.factor",
              },
              lit: { type: "boolean", compute: "$item.end != null && $item.remaining > 0" },
            },
            display: ["remaining", "lit"],
          },
        },
      },
    ],
    [
      "道具/开关",
      {
        identity: "道具/开关",
        documentType: definitionType,
        values: {
          instance: {
            fields: {
              active: { type: "boolean", required: true, mutable: true },
              status: { type: "text", compute: "$item.active ? '开启' : '关闭'" },
            },
            display: ["status"],
          },
        },
      },
    ],
    ["时钟/当前", { identity: "时钟/当前", documentType: clockType, values: { elapsed: 5 } }],
  ]);
  const resolve = (_: ComputedDocumentInput, reference: string) => targets.get(reference) ?? null;
  const evaluate = () => evaluateComputedFields(input, resolve, { strict: true });
  return { input, targets, holderType, resolve, evaluate };
}

test("同定义的独立实例与混合定义共用计算上下文，世界和定义变化使缓存刷新", async () => {
  const f = instanceFixture();
  const parsed = (input: ComputedDocumentInput): ParsedModuleDocument => ({
    ...input,
    document: {
      path: `${input.identity}.json`,
      docType: input.documentType.id,
      title: input.identity,
      valid: true,
    },
  });
  const evaluator = new DocumentEvaluator();
  evaluator.setSnapshot(1, [parsed(f.input), ...[...f.targets.values()].map(parsed)]);
  const first = await evaluator.readDocument(f.input.identity);
  const rows = first.values!.items as any[];
  assert.equal(rows[0].state.remaining, 20);
  assert.equal(rows[1].state.remaining, 60);
  assert.equal(rows[2].state.status, "开启");
  assert.equal(first.values!.total, 80);
  const clock = f.targets.get("时钟/当前")!;
  evaluator.updateSnapshot(2, [parsed({ ...clock, values: { elapsed: 15 } })]);
  const second = await evaluator.readDocument(f.input.identity);
  assert.equal((second.values!.items as any[])[0].state.remaining, 0);
  assert.equal((second.values!.items as any[])[0].state.lit, false);
  const timer = f.targets.get("道具/计时器")!;
  evaluator.updateSnapshot(3, [parsed({ ...timer, values: { ...timer.values, factor: 3 } })]);
  const third = await evaluator.readDocument(f.input.identity);
  assert.equal((third.values!.items as any[])[1].state.remaining, 90);
  const publicView = publicValues(f.holderType.fields, third.values as Record<string, unknown>);
  assert.equal((publicView.items as any[])[0].state.secret, undefined);
  assert.equal(publicView.world, undefined);
  assert.equal(JSON.stringify(publicView).includes("compute"), false);
  assert.equal((publicView.items as any[])[0].$instance.display[0].value, 0);
  assert.deepEqual(publicValues(f.holderType.fields, publicView), publicView);
  assert.equal((f.input.values.items as any[])[0].state.remaining, undefined);
});

test("实例原始状态拒绝未知字段、计算结果、缺失初值和错误定义", async () => {
  const f = instanceFixture();
  const validate = () =>
    validateInstanceBindings(
      f.holderType.fields,
      f.input.values,
      (reference) => f.targets.get(reference) ?? null,
    );
  validate();
  const row = (f.input.values.items as any[])[0];
  row.state.unknown = 1;
  assert.throws(validate);
  delete row.state.unknown;
  row.state.remaining = 4;
  assert.throws(validate);
  delete row.state.remaining;
  delete row.state.budget;
  assert.throws(validate);
  row.state.budget = 20;
  row.definition = "道具/缺失";
  assert.throws(validate, /实例引用/);
  row.definition = "时钟/当前";
  assert.throws(validate, /类型不匹配/);
  row.definition = "道具/开关";
  assert.throws(validate);
  assert.throws(() =>
    validateDocumentValues(f.holderType, {
      ...f.input.values,
      items: [{ definition: "道具/开关" }],
    }),
  );
  assert.throws(() =>
    validateDocumentValues(f.holderType, {
      ...f.input.values,
      items: [
        {
          definition: "道具/开关",
          state: { active: true },
          $instance: { values: { secret: "伪造" } },
        },
      ],
    }),
  );
});

test("实例循环公式按字段隔离，其他实例和嵌套 $item 仍可计算", async () => {
  const f = instanceFixture();
  const timer = f.targets.get("道具/计时器")!;
  const definition = timer.values.instance as any;
  definition.fields.remaining.compute = "$item.lit ? 1 : 0";
  definition.fields.lit.compute = "$item.remaining > 0";
  definition.fields.nested = {
    type: "object",
    fields: {
      base: { type: "number", required: true },
      doubled: { type: "number", compute: "$item.base * $definition.factor" },
    },
  };
  (f.input.values.items as any[])[0].state.nested = { base: 4 };
  const result = await evaluateComputedFields(f.input, f.resolve);
  assert.equal((result.values.items as any[])[0].state.remaining, null);
  assert.equal((result.values.items as any[])[0].state.nested.doubled, 8);
  assert.equal((result.values.items as any[])[2].state.status, "开启");
  assert.match(result.fieldErrors!["items[0].state.remaining"], /循环依赖/);
  await assert.rejects(f.evaluate, /循环依赖/);
});

test("实例状态自己的引用参与依赖刷新，错误引用被拒绝；主持容器不会泄露公开子字段", async () => {
  const f = instanceFixture();
  const timer = f.targets.get("道具/计时器")!;
  const definition = timer.values.instance as any;
  definition.fields.clock = { type: "reference", targets: ["时钟"], visibility: "gm" };
  definition.fields.reading = {
    type: "number",
    compute: "$item.clock == null ? null : load($item.clock).elapsed",
  };
  definition.display = ["reading", "remaining"];
  const extra = {
    ...f.targets.get("时钟/当前")!,
    identity: "时钟/独立",
    values: { elapsed: 12 },
  };
  f.targets.set(extra.identity, extra);
  const row = (f.input.values.items as any[])[0];
  row.state.clock = extra.identity;
  const parsed = (input: ComputedDocumentInput): ParsedModuleDocument => ({
    ...input,
    document: {
      path: input.identity + ".json",
      docType: input.documentType.id,
      title: input.identity,
      valid: true,
    },
  });
  const evaluator = new DocumentEvaluator();
  evaluator.setSnapshot(1, [parsed(f.input), ...[...f.targets.values()].map(parsed)]);
  assert.equal(
    ((await evaluator.readDocument(f.input.identity)).values!.items as any[])[0].state.reading,
    12,
  );
  evaluator.updateSnapshot(2, [parsed({ ...extra, values: { elapsed: 27 } })]);
  const resolved = (await evaluator.readDocument(f.input.identity)).values as Record<
    string,
    unknown
  >;
  const publicView = publicValues(f.holderType.fields, resolved);
  assert.equal((publicView.items as any[])[0].state.clock, undefined);
  assert.equal((publicView.items as any[])[0].state.reading, 27);
  assert.equal((publicView.items as any[])[0].$instance.display[0].key, "reading");
  const privateFields = f.holderType.fields.map((field) =>
    field.key !== "items"
      ? field
      : {
          ...field,
          item: {
            ...field.item!,
            fields: field.item!.fields!.map((child) =>
              ["state", "definition"].includes(child.key)
                ? { ...child, visibility: "gm" as const }
                : child,
            ),
          },
        },
  );
  const privateView = publicValues(privateFields, resolved);
  assert.equal(Object.hasOwn((privateView.items as any[])[0], "state"), false);
  assert.equal(Object.hasOwn((privateView.items as any[])[0], "$instance"), false);
  row.state.clock = "道具/开关";
  assert.throws(
    () =>
      validateInstanceBindings(
        f.holderType.fields,
        f.input.values,
        (reference) => f.targets.get(reference) ?? null,
      ),
    /实例状态引用/,
  );
  row.state.clock = "时钟/缺失";
  assert.throws(
    () =>
      validateInstanceBindings(
        f.holderType.fields,
        f.input.values,
        (reference) => f.targets.get(reference) ?? null,
      ),
    /实例状态引用/,
  );
  row.state.clock = extra.identity;
  delete timer.values.instance;
  await assert.rejects(f.evaluate, /缺少实例定义/);
});
