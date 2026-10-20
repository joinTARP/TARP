import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

import type { GameSession } from "@tarp/core/shared/session";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

mock.module("./use-room-visible-documents", () => ({ useRoomVisibleDocuments: () => [] }));
const { RoomModule } = await import("./RoomModule");

async function render(value: ReactNode) {
  const stream = await renderToReadableStream(value);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

const session = {
  pages: [{ path: "玩家手册.md", title: "玩家手册", body: "直接说明你的行动。" }],
  documentTypes: [
    { id: "规则", name: "核心规则", fields: [] },
    { id: "地点", name: "地点", fields: [] },
  ],
  documents: [
    {
      path: "规则/伤害.md",
      title: "伤害",
      docType: "规则",
      valid: true,
      body: "从耐久里扣除。",
    },
    {
      path: "地点/墓门.json",
      title: "墓门",
      docType: "地点",
      valid: true,
      description: "石门只留一道缝。",
    },
  ],
} as unknown as GameSession;

test("模组设定复用类型导航和文档卡片，默认不展开其他类型正文", async () => {
  const html = await render(<RoomModule session={session} />);
  assert.ok(html.includes("玩家手册"));
  assert.ok(html.includes("核心规则"));
  assert.ok(html.includes("地点"));
  assert.ok(html.includes("伤害"));
  assert.ok(!html.includes("直接说明你的行动。"));
  assert.ok(!html.includes("墓门"));
  assert.ok(!html.includes("返回模组库"));
});
