import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { stringifyDocumentContent } from "@tarp/module/node/document-codec";
import { createWorldStateDefinition } from "@tarp/module/testing/world-state";

/** 为文件存档及主持工具测试创建真实的临时模组，同时覆盖 TOML 配置和 JSON 文档。 */
export async function createLaunchTestModule() {
  const root = await mkdtemp(join(tmpdir(), "tarp-launch-fixture-"));
  const modulePath = join(root, "module");
  const sessions = join(root, "sessions");
  const files = {
    "module.toml": {
      name: "开局平台测试",
      description: "独立的角色与开局测试数据。",
      gameStarts: [
        {
          id: "test",
          name: "测试开局",
          characterTypeIds: ["角色"],
          playablePaths: ["角色/测试旅人"],
          allowCreate: false,
          opening: { mode: "scripted", beats: [{ text: "角色抵达试验场。" }] },
        },
      ],
    },
    ".types/世界状态.fields.toml": createWorldStateDefinition(),
    ".types/角色.fields.toml": {
      designation: "character",
      fields: { hp: { type: "number", mutable: true } },
    },
    ".types/地点.fields.toml": { fields: {} },
    "世界状态/世界.json": {
      scenes: [
        {
          id: "yard",
          location: "地点/试验场",
          members: ["角色/测试旅人"],
          activity: "探索",
        },
      ],
    },
    "角色/测试旅人.json": { name: "测试旅人", hp: 8 },
    "角色/测试守卫.json": { name: "测试守卫", hp: 10 },
    "地点/试验场.json": { name: "试验场" },
    "地点/观测站.toml": { name: "观测站" },
    "地点/小桥.json": { name: "小桥" },
  };
  try {
    for (const [path, value] of Object.entries(files)) {
      const target = join(modulePath, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stringifyDocumentContent(value, path));
    }
    return {
      root,
      modulePath,
      sessions,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
