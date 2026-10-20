import { test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  evaluateComputedFields as evaluateDocument,
  type ComputedDocumentInput,
} from "./computed-fields";
import { splitDocumentValues } from "./document-computations";
import type { DocumentType } from "./document-type";
import {
  validateDocumentLayout,
  validateDocumentType,
  validateDocumentValues,
} from "./document-type";

// 此处保留已有字段行为断言；文档级可见性由 DocumentEvaluator 场景覆盖。
async function evaluateComputedFields(
  type: DocumentType,
  values: Record<string, unknown>,
  references: Readonly<Record<string, Record<string, unknown> | null>> | null,
  options: { selectedKeys?: readonly string[]; strict?: boolean } = {},
): Promise<Record<string, unknown>> {
  const inputs = new Map<string, ComputedDocumentInput>();
  for (const [identity, value] of Object.entries(references ?? {})) {
    if (value)
      inputs.set(identity, {
        identity,
        documentType: { id: "引用", name: "引用", fields: [] },
        ...splitDocumentValues(value),
      });
  }
  return (
    await evaluateDocument(
      { identity: type.id, documentType: type, ...splitDocumentValues(values) },
      (_, reference) => inputs.get(reference) ?? null,
      options,
    )
  ).values;
}

test("计算失败只隐藏对应字段与依赖字段，不影响正常值，也不能捕获错误后伪造结果", async () => {
  const type = validateDocumentType("失败隐藏", {
    fields: {
      dependent: { type: "number", compute: "$self.wrong + 1" },
      caught: {
        type: "number",
        compute: "(() => { try { return $self.broken; } catch { return 99; } })()",
      },
      wrong: { type: "number", compute: "'错误类型'" },
      broken: { type: "number", compute: "(() => { throw new Error('失败'); })()" },
      missing: { type: "number", compute: "undefined" },
      hidden: { type: "number", compute: "null" },
      hiddenDependent: { type: "number", compute: "$self.hidden + 1" },
      syntax: { type: "number", compute: ")" },
      good: { type: "number", compute: "5" },
      zero: { type: "number", compute: "0" },
      off: { type: "boolean", compute: "false" },
      total: { type: "number", compute: "sum($self.rows, row => row.result)" },
      available: {
        type: "number",
        compute: "sum($self.rows.filter(row => row.value > 1), row => row.result)",
      },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            value: { type: "number" },
            result: { type: "number", compute: "$item.value === 1 ? undefined : $item.value * 2" },
          },
        },
      },
    },
  });
  const input = { rows: [{ value: 1 }, { value: 2 }] };
  const result = await evaluateComputedFields(type, input, {});
  for (const key of [
    "dependent",
    "caught",
    "wrong",
    "broken",
    "missing",
    "hidden",
    "syntax",
    "total",
  ])
    assert.equal(result[key], null, key);
  assert.equal(result.hiddenDependent, 1);
  assert.equal(result.good, 5);
  assert.equal(result.zero, 0);
  assert.equal(result.off, false);
  assert.equal(result.available, 4);
  assert.deepEqual(result.rows, [
    { value: 1, result: null },
    { value: 2, result: 4 },
  ]);
  assert.deepEqual(input, { rows: [{ value: 1 }, { value: 2 }] });
});

test("非有限计算结果展示隐藏且严格校验拒绝，主动 null 仍合法", async () => {
  for (const compute of ["NaN", "Infinity", "-Infinity", "0 / 0", "1 / 0"]) {
    const type = validateDocumentType("非有限结果", {
      fields: {
        value: { type: "number", compute },
        dependent: { type: "number", compute: "$self.value + 1" },
        caught: {
          type: "number",
          compute: "(() => { try { return $self.value; } catch { return 8; } })()",
        },
        good: { type: "number", compute: "5" },
      },
    });
    assert.deepEqual(await evaluateComputedFields(type, {}, {}), {
      value: null,
      dependent: null,
      caught: null,
      good: 5,
    });
    await assert.rejects(evaluateComputedFields(type, {}, {}, { strict: true }), /非有限数值/);
  }
  for (const field of [
    { type: "list", item: { type: "number" }, compute: "[1, Infinity]" },
    { type: "object", fields: { number: { type: "number" } }, compute: "({ number: NaN })" },
  ]) {
    const type = validateDocumentType("嵌套非有限", { fields: { value: field } });
    assert.deepEqual(await evaluateComputedFields(type, {}, {}), { value: null });
    await assert.rejects(evaluateComputedFields(type, {}, {}, { strict: true }), /非有限数值/);
  }
  const type = validateDocumentType("主动隐藏", {
    fields: { value: { type: "number", compute: "null" } },
  });
  assert.deepEqual(await evaluateComputedFields(type, {}, {}, { strict: true }), { value: null });
});

test("合法 null 依赖不受求值顺序影响，也不能掩盖后续真实公式错误", async () => {
  for (const hiddenFirst of [true, false]) {
    for (const fail of [false, true]) {
      const hidden = { type: "number", compute: "null" };
      const result = {
        type: "number",
        compute: fail
          ? '(() => { try { $self.hidden; } catch {} throw new Error("真正错误"); })()'
          : "(() => { try { return $self.hidden ?? 99; } catch { return 99; } })()",
      };
      const type = validateDocumentType("隐藏顺序", {
        fields: hiddenFirst ? { hidden, result } : { result, hidden },
      });
      const expected = { hidden: null, result: fail ? null : 99 };
      assert.deepEqual(await evaluateComputedFields(type, {}, {}), expected);
      if (fail)
        await assert.rejects(evaluateComputedFields(type, {}, {}, { strict: true }), /真正错误/);
      else assert.deepEqual(await evaluateComputedFields(type, {}, {}, { strict: true }), expected);
    }
  }
});

test("结果 getter 可处理合法 null，真实计算失败仍不能捕获后恢复", async () => {
  for (const compute of ["null", "'错误类型'"]) {
    const type = validateDocumentType("访问器隐藏", {
      fields: {
        hidden: { type: "number", compute },
        copy: {
          type: "object",
          fields: { value: { type: "number" } },
          compute: "({ get value() { try { return $self.hidden ?? 99; } catch { return 99; } } })",
        },
        dependent: { type: "number", compute: "$self.copy.value + 1" },
        good: { type: "number", compute: "5" },
      },
    });
    const expected =
      compute === "null"
        ? { hidden: null, copy: { value: 99 }, dependent: 100, good: 5 }
        : { hidden: null, copy: null, dependent: null, good: 5 };
    assert.deepEqual(await evaluateComputedFields(type, {}, {}), expected);
    if (compute === "null")
      assert.deepEqual(await evaluateComputedFields(type, {}, {}, { strict: true }), expected);
    else await assert.rejects(evaluateComputedFields(type, {}, {}, { strict: true }), /hidden/);
  }
});

test("原值与结果独立，所有公式读取只读 $raw，重复计算不修改输入", async () => {
  const type = validateDocumentType("护甲", {
    fields: {
      name: { type: "text", compute: "$self.seen ? $raw.name : '未辨识装备'" },
      armor: { type: "number", compute: "$raw.armor + ($self.bonus ?? 0)" },
      rating: { type: "number", compute: "$self.armor * 2" },
      bonus: { type: "number", mutable: true },
      seen: { type: "boolean", mutable: true },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            value: { type: "number", compute: "$raw.rows[0].value + $self.armor" },
          },
        },
      },
    },
  });
  const original = { name: "皮甲", armor: 6, bonus: 2, seen: false, rows: [{ value: 3 }] };
  const input = validateDocumentValues(type, structuredClone(original));
  for (let round = 0; round < 2; round++) {
    const result = await evaluateComputedFields(type, input, {});
    assert.equal(result.name, "未辨识装备");
    assert.equal(result.armor, 8);
    assert.equal(result.rating, 16);
    assert.deepEqual(result.rows, [{ value: 11 }]);
    assert.deepEqual(input, original);
  }
  assert.throws(() => validateDocumentValues(type, { armor: "错误" }), /armor/);
  assert.throws(
    () =>
      validateDocumentType("错误", {
        fields: { armor: { type: "number", compute: "1", mutable: true } },
      }),
    /不能标记为运行时可修改/,
  );
  for (const compute of ["($raw.armor = 9)", "($raw.rows[0].value = 9)"]) {
    const modifying = validateDocumentType("只读原值", {
      fields: { result: { type: "number", compute } },
    });
    assert.equal((await evaluateComputedFields(modifying, input, {})).result, null);
    assert.deepEqual(input, original);
  }
});

test("名称之外的计算字段允许合法 null，原始字段仍按声明类型校验", async () => {
  const type = validateDocumentType("隐藏", {
    fields: {
      number: { type: "number", compute: "null" },
      text: { type: "text", compute: "null" },
      rows: { type: "list", item: { type: "text" }, compute: "null" },
    },
  });
  const raw = { number: 6, text: "原文", rows: ["原条目"] };
  assert.deepEqual(await evaluateComputedFields(type, raw, {}), {
    number: null,
    text: null,
    rows: null,
  });
  assert.deepEqual(raw, { number: 6, text: "原文", rows: ["原条目"] });
  assert.throws(() => validateDocumentValues(type, { number: null }), /number/);
  const invalid = validateDocumentType("无值", {
    fields: { value: { type: "number", compute: "undefined" } },
  });
  assert.deepEqual(await evaluateComputedFields(invalid, {}, {}), { value: null });
});

test("复制与展开视图保留嵌套合法 null，原值仍严格校验", async () => {
  const item = {
    type: "object",
    fields: {
      value: { type: "number", required: true },
      hidden: { type: "number", compute: "null" },
      details: {
        type: "object",
        fields: {
          secret: { type: "number", compute: "null" },
          active: { type: "boolean", required: true },
        },
      },
    },
  };
  const makeType = (copy = "$self.rows") =>
    validateDocumentType("复制隐藏", {
      fields: {
        rows: { type: "list", item },
        copy: { type: "list", item, compute: copy },
        object: {
          ...item,
          compute: "$self.rows[0]",
        },
      },
    });
  const type = makeType();
  const original = { rows: [{ value: 3, hidden: 6, details: { secret: 7, active: false } }] };
  const input = validateDocumentValues(type, original);
  const result = await evaluateComputedFields(type, input, {});
  const expected = { value: 3, hidden: null, details: { secret: null, active: false } };
  assert.deepEqual(result.rows, [expected]);
  assert.deepEqual(result.copy, [expected]);
  assert.deepEqual(result.object, expected);
  assert.deepEqual(
    (
      await evaluateComputedFields(
        makeType("$self.rows.map(row => ({ ...row }))"),
        input,
        {},
        { strict: true },
      )
    ).copy,
    [expected],
  );
  assert.deepEqual(input, original);
  for (const row of [
    { ...original.rows[0], hidden: null },
    { ...original.rows[0], details: { secret: null, active: false } },
  ])
    assert.throws(() => validateDocumentValues(type, { rows: [row] }), /hidden|secret/);
  for (const copy of [
    "$raw.rows.map(row => ({ ...row, value: null }))",
    "$raw.rows.map(row => ({ ...row, hidden: '错误类型' }))",
    "$raw.rows.map(row => ({ ...row, details: { ...row.details, active: null } }))",
  ])
    assert.equal((await evaluateComputedFields(makeType(copy), input, {})).copy, null);
  const undefinedChild = validateDocumentType("无值子字段", {
    fields: {
      row: {
        type: "object",
        compute: "({})",
        fields: { hidden: { type: "number", compute: "undefined" } },
      },
    },
  });
  assert.deepEqual(await evaluateComputedFields(undefinedChild, {}, {}), { row: { hidden: null } });
});

test("计算表格允许合法 null，有行时仍检查标识，原始表格保持严格校验", async () => {
  const makeType = (compute = "$self.visible ? $raw.rows : null") => {
    const base = validateDocumentType("隐藏表格", {
      fields: {
        visible: { type: "boolean", mutable: true },
        rows: {
          type: "list",
          compute,
          item: { type: "object", fields: { id: { type: "text" }, value: { type: "number" } } },
        },
      },
    });
    return {
      ...base,
      layout: validateDocumentLayout(base, {
        detail: {
          type: "grid",
          fields: ["rows"],
          fieldViews: { rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "value" }] } },
        },
      }),
    };
  };
  const type = makeType();
  const original = { visible: false, rows: [{ id: "a", value: 3 }] };
  const input = validateDocumentValues(type, original);
  assert.deepEqual(await evaluateComputedFields(type, input, {}), { visible: false, rows: null });
  assert.deepEqual(input, original);
  assert.deepEqual(
    (await evaluateComputedFields(type, { ...input, visible: true }, {})).rows,
    original.rows,
  );
  assert.deepEqual((await evaluateComputedFields(type, { visible: true, rows: [] }, {})).rows, []);
  assert.throws(() => validateDocumentValues(type, { rows: null }), /rows/);
  for (const rows of [[{ id: "" }], [{ id: "same" }, { id: "same" }]]) {
    assert.throws(() => validateDocumentValues(type, { visible: false, rows }), /行标识|重复/);
    assert.equal((await evaluateComputedFields(makeType(JSON.stringify(rows)), {}, {})).rows, null);
  }
});

test("表格行标识可依赖列表长度，约束失败仍隐藏已缓存的派生值", async () => {
  const base = validateDocumentType("表格依赖", {
    fields: {
      count: { type: "number", compute: "$self.rows.length" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            source: { type: "text", required: true },
            id: { type: "text", compute: "$item.source + '-' + $self.count" },
          },
        },
      },
    },
  });
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: {
        type: "grid",
        fields: ["rows"],
        fieldViews: { rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "source" }] } },
      },
    }),
  };
  assert.deepEqual(
    await evaluateComputedFields(type, { rows: [{ source: "a" }, { source: "b" }] }, {}),
    {
      count: 2,
      rows: [
        { source: "a", id: "a-2" },
        { source: "b", id: "b-2" },
      ],
    },
  );
  assert.deepEqual(
    await evaluateComputedFields(type, { rows: [{ source: "a" }, { source: "a" }] }, {}),
    {
      count: null,
      rows: null,
    },
  );
  await assert.rejects(
    evaluateComputedFields(
      type,
      { rows: [{ source: "a" }, { source: "a" }] },
      {},
      { strict: true },
    ),
    /重复/,
  );
});

test("计算字段保留根依赖、嵌套条目和前一条目已算出的值，文本只作为数据", async () => {
  const type = validateDocumentType("角色", {
    fields: {
      base: { type: "number" },
      text: { type: "text" },
      total: { type: "number", compute: "$self.twice + 1" },
      twice: { type: "number", compute: "$self.base * 2" },
      label: { type: "text", compute: "$self.text" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            index: { type: "number" },
            value: { type: "number" },
            hard: { type: "number", compute: "floor($item.value / 2)" },
            combined: {
              type: "number",
              compute: "$item.hard + $self.total + ($item.index ? $self.rows[0].hard : 0)",
            },
          },
        },
      },
    },
  });
  const text = '中文换行\n` ${globalThis.injected = 1} "); throw new Error("不是源码"); //';
  const values = await evaluateComputedFields(
    type,
    {
      base: 5,
      text,
      rows: [
        { index: 0, value: 15 },
        { index: 1, value: 9 },
      ],
    },
    {},
  );
  assert.equal(values.total, 11);
  assert.equal(values.twice, 10);
  assert.equal(values.label, text);
  assert.deepEqual(values.rows, [
    { index: 0, value: 15, hard: 7, combined: 18 },
    { index: 1, value: 9, hard: 4, combined: 22 },
  ]);
});

test("引用与元数据只读，引用缺失时字段失败隐藏而不影响普通计算", async () => {
  const type = validateDocumentType("角色", {
    fields: {
      name: { type: "text", compute: "$self.source_name + ':' + load($self.source).name" },
      body: { type: "text", compute: "$self.value > 0 ? $self.source_body : null" },
      description: { type: "text", compute: "null" },
      source_body: { type: "text", visibility: "gm" },
      source_name: { type: "text", visibility: "gm" },
      source: { type: "reference", targets: ["规则"] },
      value: { type: "number", compute: "load($self.source).value" },
      local: { type: "number", compute: "4" },
    },
  });
  const references = { "规则/示例": { value: 7, name: "规则名称" } };
  const values = await evaluateComputedFields(
    type,
    {
      source: "规则/示例",
      source_name: "原名",
      source_body: "正文",
    },
    references,
  );
  assert.equal(values.value, 7);
  assert.equal(values.name, "原名:规则名称");
  assert.equal(values.body, "正文");
  assert.equal(values.description, null);
  assert.deepEqual(await evaluateComputedFields(type, { source: "规则/示例" }, null), {
    source: "规则/示例",
    name: null,
    value: null,
    body: null,
    local: 4,
    description: null,
  });
  const modifying = validateDocumentType("修改引用", {
    fields: { value: { type: "number", compute: '(load("规则/示例").value = 9)' } },
  });
  assert.deepEqual(await evaluateComputedFields(modifying, {}, references), { value: null });
  assert.equal(references["规则/示例"].value, 7);
});

test("同一文档的条目共享计算结果，不同文档使用各自上下文且不能修改根值", async () => {
  const type = validateDocumentType("隔离", {
    fields: {
      seed: { type: "number", compute: "$raw.base + 1" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            isolated: {
              type: "boolean",
              compute:
                "$self.seed === $raw.base + 1 && typeof process === 'object' && this === undefined",
            },
          },
        },
      },
    },
  });
  for (let document = 0; document < 2; document++)
    assert.deepEqual(await evaluateComputedFields(type, { base: document, rows: [{}, {}] }, {}), {
      base: document,
      seed: document + 1,
      rows: [{ isolated: true }, { isolated: true }],
    });
  const modifying = validateDocumentType("只读", {
    fields: {
      base: { type: "number" },
      row: {
        type: "object",
        fields: { value: { type: "number", compute: "($self.base = 9)" } },
      },
    },
  });
  assert.deepEqual(await evaluateComputedFields(modifying, { base: 5, row: {} }, {}), {
    base: 5,
    row: { value: null },
  });
});

test("生成的列表继续计算子字段，根聚合可按需依赖条目，输入不被部分写入", async () => {
  const type = validateDocumentType("批量", {
    fields: {
      total: { type: "number", compute: "sum($self.rows, row => row.hard)" },
      rows: {
        type: "list",
        compute: "Array.from({ length: 100 }, (_, index) => ({ value: index * 2 }))",
        item: {
          type: "object",
          fields: {
            value: { type: "number", required: true },
            hard: { type: "number", compute: "floor($item.value / 2)" },
          },
        },
      },
    },
  });
  const result = await evaluateComputedFields(type, {}, {});
  assert.equal(result.total, 4950);
  assert.deepEqual((result.rows as unknown[])[99], { value: 198, hard: 99 });

  const invalid = validateDocumentType("无效子字段", {
    fields: {
      rows: {
        type: "list",
        compute: "[{ value: 3, hard: 99 }]",
        item: {
          type: "object",
          fields: {
            value: { type: "number" },
            hard: { type: "number", compute: "floor($item.value / 2)" },
          },
        },
      },
    },
  });
  const input = {};
  assert.deepEqual((await evaluateComputedFields(invalid, input, {})).rows, [
    { value: 3, hard: 1 },
  ]);
  assert.deepEqual(input, {});
});

test("缺失引用的失败沿依赖传播，伪造错误不能跳过字段校验", async () => {
  const type = validateDocumentType("单层", {
    fields: {
      derived: { type: "number", compute: "$self.remote + 1" },
      remote: { type: "number", compute: 'load("规则/来源").value' },
      local: { type: "number", compute: "4" },
    },
  });
  assert.deepEqual(await evaluateComputedFields(type, {}, null), {
    local: 4,
    remote: null,
    derived: null,
  });
  const forged = validateDocumentType("伪造", {
    fields: { value: { type: "number", compute: '(() => { throw { code: "NESTED_LOAD" }; })()' } },
  });
  assert.deepEqual(await evaluateComputedFields(forged, {}, null), { value: null });
});

test("循环依赖使字段失效，失败后可继续正常计算", async () => {
  const cyclic = validateDocumentType("循环", {
    fields: {
      a: { type: "number", compute: "$self.b" },
      b: { type: "number", compute: "$self.a" },
    },
  });
  assert.deepEqual(await evaluateComputedFields(cyclic, {}, {}), { a: null, b: null });
  const valid = validateDocumentType("正常", {
    fields: { value: { type: "number", compute: "2 + 3" } },
  });
  assert.deepEqual(await evaluateComputedFields(valid, {}, {}), { value: 5 });
});

test("原生执行不修改宿主原型或全局辅助函数，公式上下文只读", async () => {
  const objectFrozen = Object.isFrozen(Object.prototype);
  const arrayFrozen = Object.isFrozen(Array.prototype);
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const type = validateDocumentType("原生只读", {
    fields: {
      base: { type: "number" },
      failed: { type: "number", compute: "($raw.base = 99)" },
      value: { type: "number", compute: 'floor($self.base + load("规则/示例").value)' },
    },
  });
  const source = { base: 5 };
  const values = await evaluateComputedFields(type, source, { "规则/示例": { value: 7 } });
  assert.deepEqual(values, { base: 5, failed: null, value: 12 });
  assert.deepEqual(source, { base: 5 });
  assert.equal(Object.isFrozen(Object.prototype), objectFrozen);
  assert.equal(Object.isFrozen(Array.prototype), arrayFrozen);
  for (const key of ["$self", "$raw", "$item", "$definition", "load", "sum", "floor"])
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), globals[key]);
});

test("复制可信列表和对象保留子计算，同名原值不会代替子公式结果", async () => {
  const item = {
    type: "object",
    fields: {
      value: { type: "number" },
      doubled: { type: "number", compute: "$item.value * 2" },
    },
  };
  const type = validateDocumentType("复制", {
    fields: {
      rows: { type: "list", item },
      copy: { type: "list", item, compute: "$self.rows" },
      filtered: { type: "list", item, compute: "$self.rows.filter(row => row.value > 0).slice()" },
      object: { ...item, compute: "$self.rows[0]" },
      plain: {
        type: "list",
        item: {
          type: "object",
          fields: {
            value: { type: "number" },
            doubled: { type: "number" },
          },
        },
        compute: "$self.rows",
      },
    },
  });
  const result = await evaluateComputedFields(type, { rows: [{ value: 5 }] }, {});
  for (const key of ["rows", "copy", "filtered", "plain"])
    assert.deepEqual(result[key], [{ value: 5, doubled: 10 }]);
  assert.deepEqual(result.object, { value: 5, doubled: 10 });
  const mixed = validateDocumentType("混合", {
    fields: {
      rows: { type: "list", item },
      copy: { type: "list", item, compute: "[$self.rows[0], { value: 7, doubled: 14 }]" },
    },
  });
  assert.deepEqual((await evaluateComputedFields(mixed, { rows: [{ value: 5 }] }, {})).copy, [
    { value: 5, doubled: 10 },
    { value: 7, doubled: 14 },
  ]);
});

test("文档 computed 覆盖默认公式并生成原本必填的值，嵌套对象和列表共用各自上下文", async () => {
  const type = validateDocumentType("武器", {
    fields: {
      base: { type: "number", required: true, mutable: true },
      attack: { type: "number", compute: "$self.base + 1" },
      rating: { type: "number", required: true },
      stats: {
        type: "object",
        fields: {
          strength: { type: "number" },
          modifier: { type: "number", compute: "0" },
          computed: { type: "text" },
        },
      },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            base: { type: "number" },
            bonus: { type: "number", compute: "1" },
          },
        },
      },
    },
  });
  const source = {
    base: 10,
    stats: { strength: 14, computed: "业务值" },
    rows: [{ base: 2 }, { base: 4 }],
    computed: {
      attack: "$self.base + 5",
      rating: "$self.attack * 2",
      "stats.modifier": "floor(($item.strength - 10) / 2)",
      "rows.bonus": "$item.base + $self.attack",
    },
  };
  const before = structuredClone(source);
  validateDocumentValues(type, source);
  const result = await evaluateComputedFields(type, source, {}, { strict: true });
  assert.equal(result.attack, 15);
  assert.equal(result.rating, 30);
  assert.deepEqual(result.stats, { strength: 14, modifier: 2, computed: "业务值" });
  assert.deepEqual(result.rows, [
    { base: 2, bonus: 17 },
    { base: 4, bonus: 19 },
  ]);
  assert.equal(Object.hasOwn(result, "computed"), false);
  assert.deepEqual(source, before);
  const ordinary = await evaluateComputedFields(
    type,
    { base: 10, rating: 3 },
    {},
    { strict: true },
  );
  assert.equal(ordinary.attack, 11, "同类型其他文档仍使用默认公式");
  assert.equal(ordinary.rating, 3, "没有公式的字段继续使用原值");
});

test("文档公式覆盖拒绝无效配置，类型重载不沿用旧约束", async () => {
  const type = validateDocumentType("覆盖", {
    fields: {
      source: { type: "number", mutable: true },
      value: { type: "number" },
    },
  });
  for (const computed of [
    null,
    [],
    { value: " " },
    { value: 3 },
    { value: "a".repeat(2049) },
    { missing: "1" },
    { "value.child": "1" },
    { "value..child": "1" },
    { "__proto__.value": "1" },
    { source: "1" },
  ]) {
    assert.throws(() => validateDocumentValues(type, { source: 2, computed }), /computed|计算/);
  }
  assert.throws(
    () => validateDocumentType("保留", { fields: { computed: { type: "text" } } }),
    /保留字段/,
  );
  const computed = { value: "1" };
  assert.equal((await evaluateComputedFields(type, { computed }, {})).value, 1);
  // 相同类型 ID 重新加载后，不能复用旧类型的公式权限或结果类型约束。
  const writable = validateDocumentType("覆盖", {
    fields: { value: { type: "number", mutable: true } },
  });
  assert.throws(() => validateDocumentValues(writable, { computed }), /运行时可修改/);
  const text = validateDocumentType("覆盖", { fields: { value: { type: "text" } } });
  await assert.rejects(
    evaluateComputedFields(text, { computed }, {}, { strict: true }),
    /计算结果无效/,
  );
});

test("空值隐藏配置只控制展示，null 可被公式和文档显示条件正常读取", async () => {
  const type = validateDocumentType("空值计算", {
    displayWhen: "$self.absent === null",
    fields: {
      absent: { type: "number", compute: "null" },
      hidden: { type: "number", compute: "null", hideWhenEmpty: true },
      total: { type: "number", compute: "($self.absent ?? 2) + ($self.hidden ?? 3)" },
    },
  });
  const result = await evaluateDocument(
    { identity: "空值计算", documentType: type, values: {} },
    undefined,
    { strict: true },
  );
  assert.deepEqual(result.values, { absent: null, hidden: null, total: 5 });
  assert.equal(result.visible, true);
});

test("合法 null 没有错误，计算失败及其依赖另行记录完整路径，严格保存仍拒绝", async () => {
  const type = validateDocumentType("错误状态", {
    fields: {
      empty: { type: "number", compute: "null", hideWhenEmpty: true },
      bad: { type: "number", compute: "(() => { throw new Error('失败原因'); })()" },
      dependent: { type: "number", compute: "$self.bad ?? 42" },
      good: { type: "number", compute: "0" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            input: { type: "number" },
            result: {
              type: "number",
              compute:
                "$item.input === 0 ? (() => { throw new Error('条目失败'); })() : $item.input * 2",
            },
          },
        },
      },
    },
  });
  const values = { bad: 99, rows: [{ input: 0 }, { input: 2 }] };
  const result = await evaluateDocument({ identity: "错误状态", documentType: type, values });
  assert.deepEqual(result.values, {
    empty: null,
    bad: null,
    dependent: null,
    good: 0,
    rows: [
      { input: 0, result: null },
      { input: 2, result: 4 },
    ],
  });
  assert.deepEqual(Object.keys(result.fieldErrors ?? {}).sort(), [
    "bad",
    "dependent",
    "rows[0].result",
  ]);
  assert.match(result.fieldErrors?.bad ?? "", /失败原因/);
  assert.match(result.fieldErrors?.["rows[0].result"] ?? "", /条目失败/);
  assert.deepEqual(values, { bad: 99, rows: [{ input: 0 }, { input: 2 }] });
  await assert.rejects(
    evaluateDocument({ identity: "错误状态", documentType: type, values }, undefined, {
      strict: true,
    }),
    /失败原因/,
  );
});
