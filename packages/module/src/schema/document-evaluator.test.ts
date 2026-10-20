import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { splitDocumentValues } from "./document-computations";
import {
  DocumentEvaluator,
  resolveModuleDocuments,
  type ParsedModuleDocument,
} from "./document-evaluator";
import { documentIdentity } from "./document-path";
import { validateDocumentLayout, validateDocumentType, type DocumentType } from "./document-type";
import { visibleDocumentProjection } from "./module-document";

function item(
  path: string,
  type: DocumentType,
  values: Record<string, unknown>,
): ParsedModuleDocument {
  return {
    identity: documentIdentity(path),
    documentType: type,
    ...splitDocumentValues(values),
    document: {
      path,
      title: path,
      docType: type.id,
      contentType: "json",
      body: "正文",
      valid: true,
    },
  };
}
function fixture() {
  const sceneType = validateDocumentType("场景", {
    fields: {
      base: { type: "number" },
      boost: { type: "number", compute: "$self.base * 2" },
    },
  });
  const gearType = validateDocumentType("装备", {
    fields: {
      name: { type: "text", compute: "'力量 ' + $self.power" },
      body: { type: "text", compute: "$self.source_body + ':' + $self.power" },
      source_body: { type: "text", visibility: "gm" },
      scene: { type: "reference", targets: ["场景"] },
      summary: { type: "text", compute: "$self.name + '：' + $self.body" },
      power: { type: "number", compute: "load($self.scene).boost + 1" },
    },
  });
  const scene = item("场景/森林.json", sceneType, { base: 3 });
  const gear = Array.from({ length: 2 }, (_, i) =>
    item(`装备/${i}.json`, gearType, { scene: scene.identity, source_body: "正文" }),
  );
  return { scene, gear, items: [scene, ...gear] };
}

test("文档读取解析共享引用与元数据，带扩展名引用与标识互通并随更新刷新", async () => {
  const { scene, gear, items } = fixture();
  gear[0] = { ...gear[0], values: { ...gear[0].values, scene: scene.document.path } };
  items[1] = gear[0];
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, items);
  const [a, b] = await Promise.all([
    engine.readDocument(gear[0].document.path),
    engine.readDocument(gear[1].document.path),
  ]);
  assert.equal(a.values?.power, 7);
  assert.equal(b.title, "力量 7");
  assert.equal(b.body, "正文:7");
  assert.equal(b.values?.summary, "力量 7：正文:7");
  engine.updateSnapshot(2, [{ ...scene, values: { base: 5 } }]);
  assert.equal((await engine.readDocument(gear[0].document.path)).values?.power, 11);
  assert.equal((await engine.readDocumentName(gear[1].document.path)).title, "力量 11");
  assert.equal((await engine.readDocument(gear[1].document.path)).values?.power, 11);
  const other = item("场景/营地.json", scene.documentType, { base: 8 });
  const switched = { ...gear[0], values: { ...gear[0].values, scene: other.document.path } };
  engine.updateSnapshot(3, [other, switched]);
  assert.equal((await engine.readDocument(switched.identity)).values?.power, 17);
  engine.updateSnapshot(4, [{ ...other, values: { base: 10 } }]);
  assert.equal((await engine.readDocument(switched.identity)).values?.power, 21);
  assert.equal((await engine.readDocument(gear[1].identity)).values?.power, 11);
  const literal = {
    ...switched,
    computed: { power: `load(${JSON.stringify(other.identity)}).boost + 1` },
  };
  engine.updateSnapshot(5, [literal]);
  assert.equal((await engine.readDocument(literal.identity)).values?.power, 21);
  engine.updateSnapshot(6, [
    {
      ...literal,
      values: { ...literal.values, scene: other.identity },
      computed: { power: `load(${JSON.stringify(other.document.path)}).boost + 1` },
    },
  ]);
  assert.equal((await engine.readDocument(literal.identity)).values?.power, 21);
});

test("场景通过多级引用揭露陷阱和物品，撤销后隐藏，引用不执行无关公式", async () => {
  const sceneType = validateDocumentType("场景", {
    displayWhen: "$self.revealed === true",
    fields: {
      revealed: { type: "boolean", mutable: true, visibility: "gm" },
      base: { type: "number" },
      unrelated: { type: "number", compute: "(() => { throw new Error('不应读取无关字段'); })()" },
    },
  });
  const trapType = validateDocumentType("陷阱", {
    displayWhen: "$self.revealed === true",
    fields: {
      scene: { type: "reference", targets: ["场景"] },
      base: { type: "number" },
      revealed: { type: "boolean", compute: "load($self.scene)?.revealed === true" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            value: { type: "number" },
            total: {
              type: "number",
              compute: "$raw.base + $self.base + $item.value + load($self.scene).base",
            },
          },
        },
      },
    },
  });
  const gearType = validateDocumentType("物品", {
    displayWhen: "$self.revealed === true",
    fields: {
      trap: { type: "reference", targets: ["陷阱"] },
      base: { type: "number" },
      revealed: { type: "boolean", compute: "load($self.trap)?.revealed === true" },
      power: { type: "number", compute: "load($self.trap).rows[0].total + $raw.base + $self.base" },
      // 场景未声明为本物品的直接引用，不能越过引用声明任意 load。
      undeclared: { type: "boolean", compute: "load('场景/古墓') === null" },
    },
  });
  const scene = item("场景/古墓.json", sceneType, { revealed: false, base: 3 });
  const trap = item("陷阱/机关.json", trapType, {
    scene: scene.identity,
    base: 5,
    rows: [{ value: 2 }],
  });
  const gear = item("物品/宝珠.json", gearType, { trap: trap.identity, base: 7 });
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, [scene, trap, gear]);
  const hidden = await engine.readDocument(gear.identity);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.values?.power, 29, "隐藏物品仍正常参与内部规则计算，上下文属于各自文档");
  assert.equal(hidden.values?.undeclared, true);
  const projected = visibleDocumentProjection(hidden);
  assert.equal(projected.visible, false);
  assert.equal(projected.values, undefined);
  assert.equal(projected.body, undefined);
  assert.doesNotMatch(projected.title, /宝珠/);
  const strict = await resolveModuleDocuments([scene, trap, gear], {
    view: "source",
    identities: new Set([gear.identity]),
  });
  assert.equal(strict[2].valid, true, "严格读取只检查实际访问的引用字段");
  engine.updateSnapshot(2, [{ ...scene, values: { ...scene.values, revealed: true } }]);
  assert.equal((await engine.readDocument(gear.identity)).visible, true);
  assert.equal((await engine.readDocument(trap.identity)).visible, true);
  assert.equal((await engine.readDocumentName(gear.identity)).visible, true);
  engine.updateSnapshot(3, [{ ...scene, values: { ...scene.values, revealed: false } }]);
  assert.equal((await engine.readDocument(gear.identity)).visible, false);
  assert.equal((await engine.readDocumentName(gear.identity)).visible, false);
  const library = await resolveModuleDocuments([scene, trap, gear], { view: "library" });
  assert.equal(library[2].visible, true);
  assert.equal(library[2].title, gear.document.title);
});

test("文档显示条件只接受布尔值，隐藏不免除业务错误，名称定位先检查条件", async () => {
  for (const displayWhen of [
    "true",
    "false",
    "null",
    "undefined",
    "1",
    "(() => { throw new Error('条件错误'); })()",
  ]) {
    const type = validateDocumentType("条件", {
      displayWhen,
      fields: { value: { type: "number", compute: "5" } },
    });
    const record = item("条件/秘密.json", type, {});
    const publicView = (await resolveModuleDocuments([record], { view: "public" }))[0];
    assert.equal(publicView.visible, displayWhen === "true");
    assert.equal(publicView.values?.value, 5);
    const strict = (await resolveModuleDocuments([record], { view: "source" }))[0];
    assert.equal(strict.valid, displayWhen === "true" || displayWhen === "false");
    const library = (await resolveModuleDocuments([record], { view: "library" }))[0];
    assert.equal(library.visible, true);
  }
  const type = validateDocumentType("条件", {
    displayWhen: "false",
    fields: {
      name: { type: "text", compute: "(() => { throw new Error('隐藏名称不应执行'); })()" },
    },
  });
  const record = item("条件/秘密.json", type, {});
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, [record]);
  assert.equal((await engine.readDocumentName(record.identity)).visible, false);
  assert.equal((await resolveModuleDocuments([record], { view: "source" }))[0].valid, false);
  for (const displayWhen of ["", " ", "a".repeat(2049), true])
    assert.throws(() => validateDocumentType("错误", { displayWhen }), /displayWhen/);
});

test("双向文档引用可以正常计算，跨文档字段循环隐藏并拒绝提交", async () => {
  const makeType = (cyclic: boolean) =>
    validateDocumentType("节点", {
      fields: {
        next: { type: "reference", targets: ["节点"] },
        base: { type: "number" },
        total: {
          type: "number",
          compute: cyclic ? "load($self.next).total + 1" : "load($self.next).base + $raw.base",
        },
      },
    });
  for (const cyclic of [false, true]) {
    const type = makeType(cyclic);
    const a = item("节点/A.json", type, { next: "节点/B", base: 2 });
    const b = item("节点/B.json", type, { next: "节点/A", base: 3 });
    const docs = await resolveModuleDocuments([a, b], { view: "public" });
    assert.equal(docs[0].values?.total, cyclic ? null : 5);
    assert.equal(docs[1].values?.total, cyclic ? null : 5);
    const strict = await resolveModuleDocuments([a, b], { view: "source" });
    assert.equal(strict[0].valid, !cyclic);
    if (cyclic) assert.match(strict[0].error!, /循环依赖/);
  }
});

test("增量输入保留旧读取的一致版本，并与批量权威核心的结果及错误一致", async () => {
  const { scene, gear, items } = fixture();
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, items);
  const previous = engine.readDocument(gear[0].document.path);
  engine.updateSnapshot(2, [{ ...scene, values: { base: 10 } }]);
  assert.equal((await previous).values?.power, 7);
  const current = await engine.readDocument(gear[0].document.path);
  assert.equal(current.values?.power, 21);
  const expected = await resolveModuleDocuments([{ ...scene, values: { base: 10 } }, ...gear], {
    identities: new Set([gear[0].identity]),
    view: "public",
  });
  assert.deepEqual(current, expected[1]);
  const broken = { ...gear[0], values: { scene: "场景/不存在" } };
  engine.updateSnapshot(3, [broken]);
  const error = await engine.readDocument(broken.document.path);
  const errors = await resolveModuleDocuments([broken], { view: "public" });
  assert.deepEqual(error, errors[0]);
  assert.equal(error.valid, true);
  assert.equal(error.title, "未公开资料");
  assert.equal(error.body, undefined);
  assert.equal(error.values?.power, null);
  assert.equal(error.values?.summary, null);
  const added = item("场景/不存在.json", scene.documentType, { base: 4 });
  engine.updateSnapshot(4, [added]);
  assert.equal((await engine.readDocument(broken.identity)).values?.power, 9);
  engine.updateSnapshot(5, [], [added.document.path]);
  assert.equal((await engine.readDocument(broken.identity)).values?.power, null);
  engine.updateSnapshot(6, [], [gear[0].document.path]);
  await assert.rejects(engine.readDocument(gear[0].document.path), /文档不存在/u);
});

test("草稿计算字段与元数据共享房间引用，临时目标不污染索引，版本变化重新计算", async () => {
  const { scene, gear, items } = fixture();
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, items);
  // 故意与真实场景共用 identity，草稿不能替换真实引用目标。
  const draft = {
    ...gear[0],
    identity: scene.identity,
    document: { ...gear[0].document, path: scene.document.path },
  };
  const first = engine.evaluateDocument(draft);
  assert.equal((await first).values?.power, 7);
  assert.equal((await first).title, "力量 7");
  assert.equal((await first).body, "正文:7");
  assert.equal((await engine.readDocument(scene.document.path)).values?.boost, 6);
  const old = engine.evaluateDocument({
    ...draft,
    document: { ...draft.document, title: "旧草稿" },
  });
  engine.updateSnapshot(2, [{ ...scene, values: { base: 8 } }]);
  assert.equal((await old).values?.power, 7);
  assert.equal((await engine.evaluateDocument(draft)).values?.power, 17);
  assert.equal((await engine.readDocument(gear[1].document.path)).values?.power, 17);
  engine.setSnapshot(3, []);
  const missing = await engine.evaluateDocument(draft);
  assert.equal(missing.valid, true);
  assert.equal(missing.title, "未公开资料");
  assert.equal(missing.values?.power, null);
  await assert.rejects(engine.readDocument(draft.document.path), /文档不存在/u);
});

test("NPC别名定位仅访问名称依赖，跳过无关字段、正文与头像计算并随版本刷新", async () => {
  const type = validateDocumentType("参与者", {
    designation: "character",
    fields: {
      name: { type: "text", compute: "$self.alias" },
      image: { type: "text", compute: "(() => { throw new Error('不应读取候选图片'); })()" },
      avatar: { type: "text", compute: "(() => { throw new Error('不应读取候选头像'); })()" },
      body: { type: "text", compute: "(() => { throw new Error('不应读取候选正文'); })()" },
      revealed: { type: "boolean" },
      alias: { type: "text", compute: "$self.revealed ? '向导' : '斗篷人'" },
      unrelated: { type: "text", compute: "(() => { throw new Error('不应定位名称时执行'); })()" },
    },
  });
  const evaluator = new DocumentEvaluator();
  const hidden = item("参与者/人物/秘密.json", type, { revealed: false });
  evaluator.setSnapshot(1, [hidden]);
  const first = evaluator.readDocumentName(hidden.document.path);
  assert.deepEqual(await first, {
    path: hidden.document.path,
    title: "斗篷人",
    visible: true,
    docType: "参与者",
    valid: true,
  });
  assert.deepEqual(await evaluator.readDocumentName(hidden.identity), await first);
  evaluator.updateSnapshot(2, [{ ...hidden, values: { revealed: true } }]);
  assert.equal((await evaluator.readDocumentName(hidden.identity)).title, "向导");
  assert.equal((await first).title, "斗篷人");
});

test("NPC名称定位按需读取引用，公开别名和头像投影随版本一致更新", async () => {
  const sourceType = validateDocumentType("身份线索", {
    fields: {
      name: { type: "text", compute: "$self.label" },
      revealed: { type: "boolean" },
      label: { type: "text", compute: "$self.revealed ? '向导' : '斗篷人'" },
    },
  });
  const npcType = validateDocumentType("参与者", {
    designation: "character",
    fields: {
      hasAliases: {
        type: "boolean",
        compute:
          "['$name', '$description', '$image', '$avatar', '$body'].some(key => Object.hasOwn(load($self.clue), key))",
      },
      name: { type: "text", compute: "load($self.clue).name" },
      image: { type: "text", compute: "$self.revealed ? '公开头像.webp' : null" },
      avatar: { type: "text", compute: "$self.revealed ? $self.source_avatar : null" },
      source_avatar: { type: "text", visibility: "gm" },
      clue: { type: "reference", targets: ["身份线索"] },
      revealed: { type: "boolean" },
    },
  });
  const clue = item("身份线索/线索/身份.json", sourceType, { revealed: true });
  const source = item("参与者/人物/秘密.json", npcType, { clue: clue.identity, revealed: true });
  const npc = { ...source, values: { ...source.values, source_avatar: "专用头像.webp" } };
  const evaluator = new DocumentEvaluator();
  evaluator.setSnapshot(1, [clue, npc]);
  assert.equal((await evaluator.readDocumentName(npc.identity)).title, "向导");
  assert.equal((await evaluator.readDocument(npc.identity)).image, "公开头像.webp");
  assert.equal((await evaluator.readDocument(npc.identity)).values?.hasAliases, false);
  assert.equal((await evaluator.readDocument(npc.identity)).avatar, "专用头像.webp");
  evaluator.updateSnapshot(2, [
    { ...clue, values: { revealed: false } },
    { ...npc, values: { clue: clue.identity, revealed: false, source_avatar: "专用头像.webp" } },
  ]);
  assert.equal((await evaluator.readDocumentName(npc.identity)).title, "斗篷人");
  const current = await evaluator.readDocument(npc.identity);
  assert.equal(current.title, "斗篷人");
  assert.equal(current.image, undefined);
  assert.equal(current.avatar, undefined);
});

test("普通字段与内置名称共享依赖与循环检测，隐藏值不暴露原值", async () => {
  const type = validateDocumentType("线索", {
    fields: {
      name: { type: "text", compute: "$self.label" },
      label: { type: "text", compute: "$self.name" },
    },
  });
  const cyclic = item("线索/秘密.json", type, {});
  const failed = await resolveModuleDocuments([cyclic]);
  assert.equal(failed[0].valid, true);
  assert.equal(failed[0].title, "未公开资料");
  assert.equal(failed[0].values?.label, null);
  assert.equal(failed[0].values?.name, null);
  const privateType = validateDocumentType("人物", {
    fields: {
      name: { type: "text", visibility: "gm" },
      body: { type: "text", visibility: "gm" },
    },
  });
  const hidden = item("人物/真实身份.json", privateType, {});
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, [hidden]);
  assert.equal((await engine.readDocumentName(hidden.identity)).title, "未公开资料");
  const document = await engine.readDocument(hidden.identity);
  assert.equal(document.title, "未公开资料");
  assert.equal(document.body, undefined);
});

test("文档名称与引用目标使用各自覆盖公式，多级依赖变化和覆盖替换刷新结果", async () => {
  const worldType = validateDocumentType("世界", {
    fields: { night: { type: "boolean", mutable: true } },
  });
  const weaponType = validateDocumentType("武器", {
    fields: {
      world: { type: "reference", targets: ["世界"] },
      base: { type: "number" },
      attack: { type: "number", compute: "$self.base" },
      name: { type: "text" },
    },
  });
  const actorType = validateDocumentType("角色", {
    fields: {
      weapon: { type: "reference", targets: ["武器"] },
      attack: { type: "number" },
    },
  });
  const world = item("世界/当前.json", worldType, { night: false });
  const weapon = item("武器/夜刃.json", weaponType, {
    world: world.identity,
    base: 10,
    computed: {
      name: "'攻击 ' + $self.attack",
      attack: "$self.base + (load($self.world)?.night ? 5 : 0)",
    },
  });
  const actor = item("角色/旅人.json", actorType, {
    weapon: weapon.identity,
    computed: { attack: "load($self.weapon).attack" },
  });
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, [world, weapon, actor]);
  assert.equal((await engine.readDocumentName(weapon.identity)).title, "攻击 10");
  assert.equal((await engine.readDocument(actor.identity)).values?.attack, 10);
  engine.updateSnapshot(2, [{ ...world, values: { night: true } }]);
  assert.equal((await engine.readDocumentName(weapon.identity)).title, "攻击 15");
  assert.equal((await engine.readDocument(actor.identity)).values?.attack, 15);
  const replacement = {
    ...weapon,
    computed: { name: "'攻击 ' + $self.attack", attack: "$self.base + 20" },
  };
  engine.updateSnapshot(3, [replacement]);
  assert.equal((await engine.readDocumentName(weapon.identity)).title, "攻击 30");
  assert.equal((await engine.readDocument(actor.identity)).values?.attack, 30);
  engine.updateSnapshot(4, [
    { ...weapon, computed: undefined, values: { world: world.identity, base: 10 } },
  ]);
  assert.equal((await engine.readDocumentName(weapon.identity)).title, weapon.document.title);
  assert.equal((await engine.readDocument(actor.identity)).values?.attack, 10);
});

test("错误投影按公开字段过滤，作者可读完整诊断，重新计算后不保留旧错误", async () => {
  const type = validateDocumentType("诊断", {
    fields: {
      ready: { type: "boolean", visibility: "gm" },
      name: {
        type: "text",
        compute: "$self.ready ? '资料' : (() => { throw new Error('名称秘密'); })()",
      },
      shown: {
        type: "number",
        compute: "$self.ready ? 7 : (() => { throw new Error('秘密公式资料'); })()",
      },
      hidden: {
        type: "number",
        visibility: "gm",
        compute: "(() => { throw new Error('主持字段原因'); })()",
      },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: {
            value: { type: "number", compute: "(() => { throw new Error('条目原因'); })()" },
            secret: {
              type: "number",
              visibility: "gm",
              compute: "(() => { throw new Error('条目秘密'); })()",
            },
          },
        },
      },
    },
  });
  const record = item("诊断/资料.json", type, { ready: false, rows: [{}] });
  const engine = new DocumentEvaluator();
  engine.setSnapshot(1, [record]);
  const name = await engine.readDocumentName(record.identity);
  const projected = await engine.readDocument(record.identity);
  assert.deepEqual(Object.keys(projected.fieldErrors ?? {}).sort(), [
    "name",
    "rows[0].value",
    "shown",
  ]);
  assert.doesNotMatch(JSON.stringify(projected.fieldErrors), /秘密|条目原因/);
  assert.deepEqual(Object.keys(name.fieldErrors ?? {}), ["name"]);
  assert.doesNotMatch(JSON.stringify(name.fieldErrors), /名称秘密/);
  const library = (await resolveModuleDocuments([record], { view: "library" }))[0];
  assert.match(library.fieldErrors?.shown ?? "", /秘密公式资料/);
  assert.match(library.fieldErrors?.["rows[0].secret"] ?? "", /条目秘密/);
  assert.equal(visibleDocumentProjection({ ...projected, visible: false }).fieldErrors, undefined);
  engine.updateSnapshot(2, [{ ...record, values: { ready: true, rows: [] } }]);
  const fixed = await engine.readDocument(record.identity);
  assert.equal(fixed.values?.shown, 7);
  assert.equal(fixed.fieldErrors, undefined);
});

test("展示公式读取公开业务结果，隔离错误与秘密，按版本刷新且不进入源值", async () => {
  const base = validateDocumentType("展示测试", {
    fields: {
      hp: { type: "number" },
      doubled: { type: "number", compute: "$self.hp * 2" },
      broken: { type: "number", compute: "undefined" },
      secret: { type: "text", visibility: "gm" },
      rows: {
        type: "list",
        item: {
          type: "object",
          fields: { value: { type: "number" }, hidden: { type: "text", visibility: "gm" } },
        },
      },
    },
  });
  const formulas = {
    summary: { type: "text", label: "摘要", compute: "self => `值 ${self.doubled}`" },
    privacy: {
      type: "boolean",
      label: "保密",
      compute:
        'self => self.secret === undefined && self.rows[0].hidden === undefined && typeof load === "undefined" && self.$display === undefined',
    },
    nested: {
      type: "number",
      label: "嵌套",
      compute: "self => self.rows.reduce((sum, row) => sum + row.value, 0)",
    },
    caught: {
      type: "number",
      label: "错误不能吞掉",
      compute: "self => { try { return self.broken; } catch { return 0; } }",
    },
    undefined: { type: "text", label: "未定义", compute: "self => undefined" },
    invalid: { type: "number", label: "非法数字", compute: "self => Infinity" },
    syntax: { type: "text", label: "语法", compute: "self => (" },
    mutation: {
      type: "number",
      label: "只读",
      compute: "self => { self.hp = 9; return self.hp; }",
    },
    nullable: { type: "text", label: "空", compute: "self => null" },
  };
  const type = {
    ...base,
    layout: validateDocumentLayout(base, {
      detail: { type: "grid", fields: ["hp"] },
      displayFields: formulas,
    }),
  };
  const source = item("展示测试/角色/测试.json", type, {
    hp: 3,
    secret: "秘密",
    rows: [{ value: 2, hidden: "秘密" }],
  });
  const original = JSON.stringify(source);
  const evaluator = new DocumentEvaluator();
  evaluator.setSnapshot(1, [source]);
  const first = await evaluator.readDocument(source.document.path);
  assert.equal(first.displayValues?.summary, "值 6");
  assert.equal(first.displayValues?.privacy, true);
  assert.equal(first.displayValues?.nested, 2);
  assert.equal(first.displayValues?.nullable, null);
  assert.ok(!first.displayErrors?.nullable);
  for (const key of ["caught", "undefined", "invalid", "syntax", "mutation"])
    assert.ok(first.displayErrors?.[key], key);
  assert.equal(first.values?.hp, 3);
  assert.equal(first.values?.summary, undefined);
  assert.equal(JSON.stringify(source), original);
  evaluator.updateSnapshot(2, [{ ...source, values: { ...source.values, hp: 5 } }]);
  assert.equal(
    (await evaluator.readDocument(source.document.path)).displayValues?.summary,
    "值 10",
  );
});
