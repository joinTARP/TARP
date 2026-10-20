import { test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  advanceFlow,
  backFlow,
  currentNode,
  emptyFlowRun,
  finishIntroductionRun,
  nodeOptions,
  preludeFlowSchema,
  preludeNarration,
  validateFlow,
} from "./flow";

test("序章连续介绍一次听完，重听时整段仍在", () => {
  const flow = preludeFlowSchema.parse({
    steps: [
      { id: "a", type: "introduction", title: "甲", body: "甲" },
      { id: "b", type: "introduction", title: "乙", body: "乙" },
      { id: "c", type: "choice", title: "问", options: [{ id: "x", label: "是", value: "yes" }] },
      { id: "d", type: "introduction", title: "丙", body: "丙" },
    ],
  });
  assert.deepEqual(
    preludeNarration(flow, emptyFlowRun()).map((node) => node.id),
    ["a", "b"],
  );
  const asked = finishIntroductionRun(flow, emptyFlowRun(), []);
  assert.equal(currentNode(flow, asked)?.id, "c");
  const afterChoice = advanceFlow(flow, asked, "yes", []);
  assert.deepEqual(
    preludeNarration(flow, afterChoice).map((node) => node.id),
    ["d"],
  );
  assert.equal(finishIntroductionRun(flow, afterChoice, []).done, true);
  assert.equal(currentNode(flow, backFlow(afterChoice))?.id, "c");
});

test("序章文档选项只允许引用同类型文档，且不能绑定角色字段", () => {
  const documents = [
    { path: "地点/林地.json", title: "林地", docType: "地点", valid: true },
    { path: "地点/城门.json", title: "城门", docType: "地点", valid: true },
    { path: "人物/向导.json", title: "向导", docType: "人物", valid: true },
  ];
  const flow = preludeFlowSchema.parse({
    steps: [
      {
        id: "location",
        type: "choice",
        title: "出发地",
        optionTypeId: "地点",
        optionRoutes: { "地点/林地.json": "forest" },
      },
      { id: "forest", type: "shortText", title: "林地问题" },
    ],
  });
  assert.deepEqual(
    nodeOptions(flow.steps[0], documents).map((o) => o.value),
    ["地点/林地", "地点/城门"],
  );
  validateFlow(flow, documents);
  const bad = structuredClone(flow);
  bad.steps[0].optionRoutes = { "人物/向导.json": "forest" };
  assert.throws(() => validateFlow(bad, documents), /不存在的文档/);
  bad.steps[0].optionRoutes = {};
  assert.equal(
    preludeFlowSchema.safeParse({
      steps: [{ id: "name", title: "姓名", type: "shortText", bind: "name" }],
    }).success,
    false,
  );
});

test("预写正文校验 NPC 文档身份，前置介绍和专属开场使用同一协议", async () => {
  const { validateNarration } = await import("./flow");
  const { validateDocumentType } = await import("./document-type");
  const types = [
    validateDocumentType("人物", { name: "人物", designation: "character", fields: {} }),
  ];
  const documents = [{ path: "人物/卫兵.json", title: "卫兵", docType: "人物", valid: true }];
  validateNarration(
    '<message narrator>\n城门关闭。\n<message npc path="人物/卫兵.toml">\n站住。',
    documents,
    types,
    "序章",
  );
  assert.throws(
    () => validateNarration('<message npc path="人物/失踪者">\n站住。', documents, types, "序章"),
    /台词角色不存在/,
  );
  assert.throws(
    () =>
      validateNarration('<message npc id="guard" name="卫兵">\n站住。', documents, types, "序章"),
    /path/,
  );
});
