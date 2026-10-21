import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { ChatMessage } from "@jointarp/core/shared/game";

import { AutomaticSpeechTracker, speechText, splitSpeechText } from "./speech-text";
import { ttsTextLimit } from "./tts";

const message = (id: string, status: "running" | "complete" = "complete") =>
  ({
    id,
    status,
    kind: "scripted",
    text: "故事开始了。",
    roomId: "room",
    sequence: 1,
    revision: 0,
    senderId: "agent",
    nickname: "主持人",
    createdAt: "2026-09-29",
  }) as ChatMessage;

test("自动朗读跳过历史和重放，允许进入房间时仍在生成的消息在完成后播报", () => {
  const tracker = new AutomaticSpeechTracker();
  tracker.seed([message("old"), message("running", "running")]);
  assert.equal(tracker.takeParts(message("old")), undefined);
  assert.equal(tracker.takeParts(message("running", "running")), undefined);
  assert.equal(
    tracker
      .takeParts(message("running"))
      ?.map((part) => part.text)
      .join(""),
    "故事开始了。",
  );
  assert.equal(tracker.takeParts(message("running")), undefined);
  assert.equal(
    tracker
      .takeParts(message("new"))
      ?.map((part) => part.text)
      .join(""),
    "故事开始了。",
  );
  const internal = {
    ...message("private"),
    kind: "assistant",
    internal: true,
    agentMessages: [],
  } as ChatMessage;
  assert.equal(tracker.takeParts(internal), undefined);
  assert.equal(
    tracker.takeParts({ ...message("player"), kind: "player" } as ChatMessage),
    undefined,
  );
});

test("清理展示标记、代码和图片，仅朗读正文；分块不损坏中文与代理对", () => {
  assert.equal(
    speechText(
      "# **酒馆**\n<action>推开门。</action>\n[看这里](https://example.com)\n![配图](图片/图.png)\n```js\nsecret()\n```",
    ),
    "酒馆\n推开门。\n看这里",
  );
  assert.equal(speechText("前往[[地点/营地.json]]。"), "前往营地。");
  const text = "一".repeat(800) + "。" + "二".repeat(400) + "！";
  const chunks = splitSpeechText(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), text);
  const emoji = "🐉".repeat(1200);
  const long = splitSpeechText(emoji);
  assert.equal(long.join(""), emoji);
  assert.ok(
    long.every((chunk) => chunk.length <= ttsTextLimit && !/[\uD800-\uDBFF]$/u.test(chunk)),
  );
  assert.deepEqual(splitSpeechText("  \n "), []);
});

test("公开主持回复按叙述标签分段，NPC 和主持人得到不同声音身份", () => {
  const message = {
    id: "host-message",
    roomId: "123e4567-e89b-42d3-a456-426614174000",
    kind: "assistant",
    status: "complete",
    agentMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '<message narrator>\n门打开了。\n</message>\n<message npc path="角色/老板娘" name="老板娘">\n欢迎光临。\n</message>',
          },
        ],
      },
    ],
  } as unknown as ChatMessage;
  const tracker = new AutomaticSpeechTracker();
  const parts = tracker.takeParts(message)!;
  assert.deepEqual(
    parts.map((part) => [part.speaker.kind, part.speaker.id, part.text]),
    [
      ["host", "", "门打开了。"],
      ["npc", "角色/老板娘", "欢迎光临。"],
    ],
  );
  assert.equal(tracker.takeParts(message), undefined);
});
