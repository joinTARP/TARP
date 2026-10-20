import { test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  creationField,
  evaluateCreation,
  newCreationProgress,
  validateWorkbench,
  workbenchSchema,
} from "./creation-workbench";
import { validateDocumentType, validateDocumentValues } from "./document-type";

/** 建卡算法的最小配置，直接声明平台字段和任务，不依赖示例文件或游戏规则。 */
function fixture() {
  const type = validateDocumentType("测试角色", {
    designation: "character",
    fields: {
      role: { type: "enum", options: ["测绘员", "记录员"], required: true },
      hp: { type: "number", label: "耐力", required: true },
      attributes: {
        type: "object",
        fields: Object.fromEntries(
          ["vigor", "agility", "insight"].map((key) => [key, { type: "number", required: true }]),
        ),
      },
    },
    creationFlow: {
      workbench: {
        stages: [
          {
            id: "identity",
            title: "身份",
            tasks: [
              { id: "name", title: "姓名", kind: "input", bind: "name" },
              {
                id: "role",
                title: "职责",
                kind: "choice",
                bind: "role",
                options: ["测绘员", "记录员"],
              },
            ],
          },
          {
            id: "attributes",
            title: "数值",
            tasks: [
              { id: "hp", title: "耐力", kind: "roll", bind: "hp", dice: { count: 1, sides: 8 } },
              ...["vigor", "agility", "insight"].map((key) => ({
                id: key,
                title: key,
                kind: "roll",
                bind: `attributes.${key}`,
                dice: { count: 2, sides: 8 },
              })),
            ],
          },
        ],
      },
    },
  });
  return { type, config: type.creationFlow!.workbench };
}

test("工作台配置可校验，选择和批量掷骰生成合法角色", () => {
  const { type, config } = fixture();
  validateWorkbench(config, [], type, [type]);
  const progress = newCreationProgress();
  progress.answers["identity/name"] = "莉娜";
  progress.answers["identity/role"] = "测绘员";
  const before = evaluateCreation(config, progress, [], type);
  assert(before.missing.includes("耐力"));
  const result = evaluateCreation(config, progress, [], type, {
    stage: 1,
    random: () => 3,
  });
  assert.deepEqual(result.missing, []);
  assert.equal(result.draft.name, "莉娜");
  assert.equal(result.draft.values.hp, 3);
  assert.deepEqual(result.draft.values.attributes, { vigor: 6, agility: 6, insight: 6 });
  validateDocumentValues(type, result.draft.values);
});

test("重复生成和返回浏览保留随机记录，更换选择只重算角色资料", () => {
  const { type, config } = fixture();
  const progress = newCreationProgress();
  progress.answers["identity/name"] = "莉娜";
  progress.answers["identity/role"] = "测绘员";
  evaluateCreation(config, progress, [], type, { stage: 1, random: () => 2 });
  const records = structuredClone(progress.rolls);
  evaluateCreation(config, progress, [], type, {
    stage: 1,
    random: () => {
      throw new Error("不能重掷");
    },
  });
  progress.answers["identity/role"] = "记录员";
  const result = evaluateCreation(config, progress, [], type);
  assert.deepEqual(progress.rolls, records);
  assert.equal(result.draft.values.role, "记录员");
  assert.equal(result.draft.values.hp, 2);
});

test("建卡遵守名称的普通字段声明，计算名称只能由来源字段生成", () => {
  const type = validateDocumentType("计算姓名", {
    designation: "character",
    fields: {
      nickname: { type: "text", required: true },
      name: { type: "text", compute: "'旅人 ' + $self.nickname" },
      description: { type: "text", visibility: "gm" },
    },
  });
  const config = workbenchSchema.parse({
    stages: [
      {
        id: "identity",
        title: "身份",
        tasks: [{ id: "nickname", title: "称呼", kind: "input" as const, bind: "nickname" }],
      },
    ],
    swap: [],
  });
  validateWorkbench(config, [], type, [type]);
  assert.equal(creationField(type, "name"), undefined);
  assert.equal(creationField(type, "description")?.visibility, "gm");
  const progress = newCreationProgress();
  progress.answers["identity/nickname"] = "阿青";
  const result = evaluateCreation(config, progress, [], type);
  assert.deepEqual(result.missing, []);
  assert.equal(result.draft.name, "");
  assert.equal(result.draft.values.nickname, "阿青");
  assert.throws(
    () =>
      validateWorkbench(
        {
          ...config,
          stages: [
            {
              ...config.stages[0],
              tasks: [{ ...config.stages[0].tasks[0], id: "name", title: "姓名", bind: "name" }],
            },
          ],
        },
        [],
        type,
        [type],
      ),
    /计算字段/,
  );
});
