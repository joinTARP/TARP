import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { Character } from "@jointarp/module/character";
import { validateDocumentLayout, validateDocumentType } from "@jointarp/module/document-type";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import { CharacterPreview } from "./CharacterPreview";
import { computedDraftView, roomDraftIdentity } from "./room-draft-view";

async function render(value: ReactNode) {
  const stream = await renderToReadableStream(value);
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!--.*?-->/g, "");
}

const definition = validateDocumentType("角色", {
  fields: {
    hp: { type: "number", label: "体力" },
    background: { type: "reference", label: "过往", targets: ["过往"] },
    story: { type: "text", label: "经历" },
    profile: {
      type: "object",
      fields: { past: { type: "reference", label: "过往", targets: ["过往"] } },
    },
  },
});
const draft = {
  typeId: "角色",
  name: "陆川",
  description: "角色简介",
  values: {
    hp: 8,
    background: "过往/旧标识",
    story: "角色经历",
    profile: { past: "过往/旧标识" },
  },
};
const references = [{ path: "过往/旧标识.md", title: "游侠", docType: "过往" }];

test("角色预览透传双栏布局、图片与引用名称，保留内容顺序", async () => {
  const type = {
    ...definition,
    layout: validateDocumentLayout(definition, {
      detail: {
        type: "split",
        fields: ["hp", "background"],
        contentFields: ["story"],
        order: ["fields", "description", "body"],
      },
    }),
  };
  const html = await render(
    <CharacterPreview
      character={{ ...draft, image: "https://example.test/images/portrait.webp" }}
      type={type}
      references={references}
    />,
  );
  assert.ok(html.includes('aria-label="基础资料"'));
  assert.ok(html.includes('aria-label="详细内容"'));
  assert.equal((html.match(/>陆川<\/h2>/g) ?? []).length, 1);
  assert.equal((html.match(/角色简介/g) ?? []).length, 1);
  assert.ok(html.includes("游侠"));
  assert.ok(html.includes('src="https://example.test/images/portrait.webp"'));
  assert.ok(html.indexOf("体力") < html.indexOf("角色经历"));
  assert.ok(html.indexOf("角色经历") < html.indexOf("角色简介"));
});

test("缺省布局保留字段、简介、正文顺序，根字段与嵌套引用快照以纯文本显示", async () => {
  const html = await render(
    <CharacterPreview
      character={{ ...draft, body: "角色正文" }}
      type={definition}
      references={references}
    />,
  );
  assert.ok(html.indexOf("体力") < html.indexOf("角色简介"));
  assert.ok(html.indexOf("角色简介") < html.indexOf("角色正文"));
  assert.equal((html.match(/陆川/g) ?? []).length, 1);
  assert.equal((html.match(/游侠/g) ?? []).length, 2);
  assert.ok(!html.includes("<button"));
});

const roomDraft: Character = {
  id: "roomDraft",
  typeId: "角色",
  playerId: null,
  sourcePath: null,
  version: 1,
  name: "隐藏真名",
  description: "隐藏说明",
  body: "隐藏正文",
  image: "secret.png",
  avatar: "secret-avatar.png",
  values: { secret: 5 },
};

test("首次草稿与计算错误仅展示安全占位，不泄露原始元数据及字段", () => {
  const pending = computedDraftView(roomDraft);
  assert.equal(pending.name, "正在计算…");
  assert.equal(pending.description, "");
  assert.equal(pending.body, undefined);
  assert.equal(pending.image, undefined);
  assert.equal(pending.avatar, undefined);
  assert.deepEqual(pending.values, {});
  assert.deepEqual(
    computedDraftView(roomDraft, {
      path: "",
      title: roomDraft.name,
      docType: roomDraft.typeId,
      contentType: "json",
      valid: false,
    }),
    pending,
  );
});

test("草稿成功预览准确采用计算结果，身份跨房间、类型、来源隔离", () => {
  const document = {
    path: "",
    title: "未辨识",
    docType: roomDraft.typeId,
    contentType: "json" as const,
    valid: true,
    description: "",
    values: { power: 10 },
  };
  const preview = computedDraftView(roomDraft, document);
  assert.equal(preview.name, "未辨识");
  assert.equal(preview.description, "");
  assert.equal(preview.body, undefined);
  assert.deepEqual(preview.values, { power: 10 });
  const identity = roomDraftIdentity("room-a", roomDraft);
  assert.equal(roomDraftIdentity("room-a", { ...roomDraft, values: { secret: 10 } }), identity);
  assert.notEqual(roomDraftIdentity("room-b", roomDraft), identity);
  assert.notEqual(roomDraftIdentity("room-a", { ...roomDraft, typeId: "物品" }), identity);
  assert.notEqual(
    roomDraftIdentity("room-a", { ...roomDraft, sourcePath: "角色/other.json" }),
    identity,
  );
});
