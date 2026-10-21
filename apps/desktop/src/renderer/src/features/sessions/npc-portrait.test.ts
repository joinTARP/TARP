import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { ChatMessage } from "@jointarp/core/shared/game";
import type { ModuleDocument } from "@shared/desktop-api";

import { createNpcPortraitResolver } from "./npc-portrait";
import { npcPortraitDocuments } from "./npc-portrait-documents";

const portrait: ModuleDocument = {
  path: "人物/石启明.json",
  title: "斗篷人",
  image: "https://example.test/images/portrait.webp",
  valid: true,
};

const scripted: ChatMessage = {
  id: "scripted",
  roomId: "room",
  sequence: 1,
  revision: 0,
  kind: "scripted",
  senderId: "host",
  nickname: "陌生人",
  createdAt: "2026-10-06T00:00:00Z",
  status: "complete",
  text: "跟我走。",
  speakerPath: "人物/石启明",
};

function ai(text: string): ChatMessage {
  return {
    ...scripted,
    kind: "assistant",
    agentMessages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
  } as unknown as ChatMessage;
}

test("AI 与预写发言按相同文档身份定位，别名和同名资料不影响关联", () => {
  const other = { ...portrait, path: "人物/另一人.md" };
  const resolve = createNpcPortraitResolver([portrait, other]);
  assert.equal(resolve("人物/石启明"), portrait);
  assert.equal(resolve("人物/石启明.toml"), portrait);
  assert.equal(resolve("斗篷人"), undefined);
  assert.equal(resolve("人物/不存在"), undefined);
  const message = ai('<message npc path="人物/石启明" name="陌生人">\n跟我走。');
  assert.deepEqual(npcPortraitDocuments([message, scripted], [portrait, other]), [portrait]);
});

test("只读取发言路径的公开投影，隐藏、无效和身份冲突的资料不能成为头像或入口", () => {
  const hidden = { ...portrait, visible: false };
  assert.equal(createNpcPortraitResolver([hidden])(portrait.path), undefined);
  assert.equal(
    createNpcPortraitResolver([{ ...portrait, valid: false }])(portrait.path),
    undefined,
  );
  assert.equal(
    createNpcPortraitResolver([portrait, { ...portrait, path: "人物/石启明.md" }])(portrait.path),
    undefined,
  );
  assert.deepEqual(npcPortraitDocuments([], [portrait]), []);
  // 静态资料只用于确定读取路径，隐藏与动态名称由后续公开投影裁定。
  assert.deepEqual(npcPortraitDocuments([scripted], [hidden]), [hidden]);
  assert.deepEqual(npcPortraitDocuments([{ ...scripted, speakerPath: undefined }], [portrait]), []);
  assert.deepEqual(
    npcPortraitDocuments([ai('<message npc name="斗篷人">\n跟我走。')], [portrait]),
    [],
  );
  assert.deepEqual(
    npcPortraitDocuments(
      [ai('<message npc path="人物/石启明" name="玩家">\n跟我走。')],
      [portrait],
      new Set(["玩家"]),
    ),
    [],
  );
});
