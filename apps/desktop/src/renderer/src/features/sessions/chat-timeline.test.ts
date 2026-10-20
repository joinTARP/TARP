import { test, mock } from "bun:test";
import { strict as assert } from "node:assert";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  advanceTimersByTime,
  getTimerCount,
  useFakeTimers,
  useRealTimers,
} from "@jointarp/module/testing/async";
import type { ChatMessage } from "@tarp/core/shared/game";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../desktop-rpc", () => ({ desktopRpc: { game: {} }, desktopOrpc: {} }));
const { TooltipProvider } = await import("../../components/ui/tooltip");
const { chatTimeline } = await import("./chat-timeline");
const { MessageEntry } = await import("./ChatMessageEntry");
const { DiceCard } = await import("./DiceCard");
const { frameTextBuffer } = await import("./use-frame-text");

import type { GameClient } from "./game-client";

const frames = {
  request: (callback: (time: number) => void) => Number(setTimeout(() => callback(Date.now()), 16)),
  cancel: (id: number) => clearTimeout(id),
  now: () => Date.now(),
};

test("流式更新短间隔合并，持续追加不推迟刷新，也不人为拆开 Markdown 与字素", () => {
  useFakeTimers();
  try {
    const displayed: string[] = [];
    const buffer = frameTextBuffer((text) => displayed.push(text), frames);
    buffer.push("你看见");
    advanceTimersByTime(16);
    const first = "你看见**👩🏽‍🚀向你招手。**";
    buffer.push(first);
    advanceTimersByTime(16);
    assert.deepEqual(displayed, []);
    advanceTimersByTime(16);
    assert.deepEqual(displayed, [first]);
    const final = `${first}\n\n她指了指窗外，雨已经停了。`;
    buffer.push(final);
    advanceTimersByTime(48);
    assert.deepEqual(displayed, [first, final]);
    assert.equal(buffer.pending(), false);
    assert.equal(getTimerCount(), 0);
  } finally {
    useRealTimers();
  }
});

test("停止、正文修订和卸载取消旧尾部，恢复订阅仍能收完已接收的文字", () => {
  useFakeTimers();
  try {
    let displayed = "历史正文";
    const buffer = frameTextBuffer(
      (text) => {
        displayed = text;
      },
      frames,
      displayed,
    );
    buffer.push("历史正文追加的流式内容");
    advanceTimersByTime(32);
    buffer.flush("历史正文追加的流式内容");
    assert.equal(displayed, "历史正文追加的流式内容");
    assert.equal(getTimerCount(), 0);
    buffer.push("新一轮替换正文");
    assert.equal(displayed, "新一轮替换正文");
    buffer.push("新一轮替换正文继续追加");
    buffer.dispose();
    advanceTimersByTime(200);
    assert.equal(displayed, "新一轮替换正文");
    buffer.push("新一轮替换正文继续追加");
    advanceTimersByTime(176);
    assert.equal(displayed, "新一轮替换正文继续追加");
    assert.equal(getTimerCount(), 0);
  } finally {
    useRealTimers();
  }
});

const player = (id: string, minute: number): Extract<ChatMessage, { kind: "player" }> => ({
  id,
  roomId: "room",
  sequence: minute,
  revision: 0,
  kind: "player",
  chatOnly: false,
  senderId: "player",
  nickname: "玩家",
  createdAt: new Date(Date.UTC(2026, 8, 30, 12, minute)).toISOString(),
  status: "complete",
  text: id,
});

const native = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "test",
  model: "test",
  timestamp: 1,
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

test("虚拟窗口外的前一条消息仍决定连续消息分组", () => {
  const messages = [player("first", 0), player("second", 1), player("third", 6)];
  const window = chatTimeline(messages).slice(1);
  assert.equal(window[0].grouped, true);
  assert.equal(window[1].grouped, false);
  assert.equal(
    chatTimeline([messages[0], { ...messages[1], nickname: "新昵称" }])[1].grouped,
    false,
  );
  assert.equal(
    chatTimeline([messages[0], { ...messages[1], senderId: "another" }])[1].grouped,
    false,
  );
  assert.equal(chatTimeline([messages[0], { ...messages[1], status: "failed" }])[1].grouped, false);
  assert.equal(chatTimeline([messages[1], messages[0]])[1].grouped, false);
  assert.equal(
    chatTimeline([messages[0], { ...messages[1], chatOnly: true }])[1].grouped,
    false,
    "行动切换为聊天时重新展示用途标签",
  );
  assert.equal(
    chatTimeline([{ ...messages[0], chatOnly: true }, messages[1]])[1].grouped,
    false,
    "聊天切换为行动时重新展示用途标签",
  );
  assert.equal(
    chatTimeline(messages.slice(0, 2).map((message) => ({ ...message, chatOnly: true })))[1]
      .grouped,
    true,
  );
});

test("只有自己的待提交行动显示改为聊天，转换后旗帜和操作入口一起消失", () => {
  const render = (message: Extract<ChatMessage, { kind: "player" }>, viewer = "player") =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(MessageEntry, {
          message,
          currentPlayerId: viewer,
          grouped: false,
          speechOwner: "room",
          speechId: message.id,
          speechEnabled: false,
          onOpenCharacterCard: () => {},
          onQuickMention: () => {},
          onConvertToChat: () => {},
          resolveNpcPortrait: () => undefined,
        }),
      ),
    );
  const pending = { ...player("pending", 0), pendingAgent: true };
  assert.match(render(pending), /改为聊天/);
  assert.match(render(pending), /aria-label="行动"/);
  assert.doesNotMatch(render(pending, "other"), /改为聊天/);
  assert.doesNotMatch(render({ ...pending, pendingAgent: undefined }), /改为聊天/);
  assert.doesNotMatch(
    render({ ...pending, pendingAgent: undefined, chatOnly: true }),
    /改为聊天|aria-label="行动"/,
  );
});

test("连续预写旁白从播放开始就合并头像，完成与追加下一条不改变已有分组", () => {
  const scripted = (id: string, minute: number): Extract<ChatMessage, { kind: "scripted" }> => ({
    ...player(id, minute),
    kind: "scripted",
    senderId: "agent",
    nickname: "主持人",
    text: id,
  });
  const first = scripted("first", 0);
  const next = scripted("second", 1);
  const playing = chatTimeline([first, { ...next, status: "running" }]);
  const finished = chatTimeline([first, next]);
  assert.equal(playing[1].grouped, true, "第二条播放时不先挂载一个会在完成后消失的头像");
  assert.deepEqual(
    playing.map(({ key, grouped }) => ({ key, grouped })),
    finished.map(({ key, grouped }) => ({ key, grouped })),
  );
  const appended = chatTimeline([first, next, { ...scripted("third", 2), status: "running" }]);
  assert.deepEqual(
    appended.map((entry) => entry.grouped),
    [false, true, true],
  );
  assert.deepEqual(appended.slice(0, 2), finished);

  const npc = { ...next, nickname: "卫兵", speakerPath: "人物/卫兵.json" };
  assert.equal(chatTimeline([first, npc])[1].grouped, false, "旁白切换到 NPC 时展示头像");
  assert.equal(chatTimeline([npc, { ...npc, id: "npc-next", status: "running" }])[1].grouped, true);
  assert.equal(
    chatTimeline([npc, { ...npc, id: "other", speakerPath: "人物/另一名卫兵.json" }])[1].grouped,
    false,
    "同名但不同人物不共用头像",
  );
  assert.equal(chatTimeline([first, { ...next, status: "failed" }])[1].grouped, false);
});

test("开场初始化显示普通主持消息，完成后隐藏；队友内部思考与准备卡不占行", () => {
  const hidden: ChatMessage = {
    ...player("internal", 0),
    kind: "assistant",
    internal: true,
    agentMessages: [],
  };
  const ready: ChatMessage = {
    ...player("ready", 0),
    kind: "card",
    card: { type: "ready", players: [] },
  };
  assert.deepEqual(
    chatTimeline([
      ready,
      hidden,
      { ...hidden, id: "thinking", status: "running" },
      { ...hidden, id: "companion-thinking", companionId: "companion", status: "running" },
      { ...hidden, id: "failed", status: "failed" },
      player("visible", 1),
    ]).map((entry) => entry.key),
    ["thinking", "failed", "visible"],
  );
});

test("推理开关显示队友运行中和未发言的历史回合，关闭后恢复隐藏", () => {
  const thinking: ChatMessage = {
    ...player("thinking", 0),
    kind: "assistant",
    companionId: "companion",
    internal: true,
    status: "running",
    agentMessages: [],
  };
  const silent: ChatMessage = { ...thinking, id: "silent", status: "complete" };
  const spoken: ChatMessage = { ...silent, id: "spoken", internal: false };
  const messages = [thinking, silent, spoken];
  assert.deepEqual(
    chatTimeline(messages, false).map((entry) => entry.key),
    ["spoken"],
  );
  const shown = chatTimeline(messages, true);
  assert.deepEqual(
    shown.map((entry) => entry.key),
    ["thinking", "silent", "spoken"],
  );
  assert.deepEqual(
    shown.map((entry) => entry.detailsMessage),
    messages,
  );
  assert.deepEqual(
    chatTimeline(messages, false).map((entry) => entry.key),
    ["spoken"],
  );
});

test("检定切分的叙述只在首段显示完整推理，前插历史保留消息键，旧回合骰子独立保留", () => {
  const assistant: ChatMessage = {
    ...player("assistant", 1),
    kind: "assistant",
    attemptId: "attempt",
    agentMessages: [native("请进行检定"), native("你发现了入口")],
  };
  const dice: ChatMessage = {
    ...player("dice", 2),
    kind: "dice",
    dice: {
      expression: "1d20",
      reason: "察觉",
      deadline: 0,
      rolls: [18],
      total: 18,
      sourceMessageId: assistant.id,
      sourceAttemptId: assistant.attemptId,
      afterMessageIndex: 0,
    },
  };
  const entries = chatTimeline([assistant, dice]);
  const beforeDice = chatTimeline([
    { ...assistant, agentMessages: assistant.agentMessages.slice(0, 1) },
  ]);
  assert.equal(entries[0].key, beforeDice[0].key, "检定卡到来不重建已经显示的正文");
  assert.deepEqual(
    entries.map((entry) => entry.message.kind),
    ["assistant", "dice", "assistant"],
  );
  assert.equal(entries[0].detailsMessage, assistant);
  assert.equal(entries[2].detailsMessage, undefined);
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 3);
  assert.deepEqual(
    chatTimeline([player("older", 0), assistant, dice])
      .slice(1)
      .map((entry) => entry.key),
    entries.map((entry) => entry.key),
  );
  assert.deepEqual(
    chatTimeline([{ ...assistant, attemptId: "new-attempt" }, dice]).map(
      (entry) => entry.message.kind,
    ),
    ["assistant", "dice"],
  );
  const nextDice: ChatMessage = {
    ...dice,
    id: "next-dice",
    dice: { ...dice.dice, afterMessageIndex: 1 },
  };
  const continued = chatTimeline([
    { ...assistant, agentMessages: [...assistant.agentMessages, native("下一次检定后继续")] },
    dice,
    nextDice,
  ]);
  assert.equal(continued[2].key, entries[2].key, "后续检定不重建先前的续写分段");
  assert.equal(new Set(continued.map((entry) => entry.key)).size, continued.length);
});

test("未完成检定失败后保留失败卡，主持终止状态与重试回合仍可见", () => {
  const assistant: Extract<ChatMessage, { kind: "assistant" }> = {
    ...player("assistant", 1),
    kind: "assistant",
    attemptId: "attempt",
    status: "running",
    agentMessages: [native("请进行检定")],
  };
  const dice: Extract<ChatMessage, { kind: "dice" }> = {
    ...player("dice", 2),
    kind: "dice",
    status: "failed",
    error: "主持已终止，本次掷骰未完成。",
    dice: {
      expression: "1d20",
      reason: "察觉",
      deadline: Date.now() + 30_000,
      sourceMessageId: assistant.id,
      sourceAttemptId: assistant.attemptId,
      afterMessageIndex: 0,
    },
  };
  for (const status of ["running", "failed"] as const) {
    const entries = chatTimeline([{ ...assistant, status }, dice]);
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ["assistant", "dice", "assistant:1"],
    );
    assert.equal(entries[1].message, dice);
    assert.equal(entries[2].message.status, status);
  }
  assert.deepEqual(
    chatTimeline([{ ...assistant, attemptId: "retry" }, dice]).map((entry) => entry.key),
    ["assistant", "dice"],
  );
});

test("失败骰子不显示点数、倒计时或可操作按钮，完成结果仍保留", () => {
  const dice: Extract<ChatMessage, { kind: "dice" }> = {
    ...player("dice", 1),
    kind: "dice",
    status: "failed",
    error: "主持已终止，本次掷骰未完成。",
    dice: {
      expression: "1d20",
      reason: "察觉",
      deadline: Date.now() + 30_000,
      targetPlayerId: "player",
    },
  };
  const render = (message: typeof dice) =>
    renderToStaticMarkup(
      createElement(DiceCard, {
        message,
        player: { id: "player", nickname: "玩家" },
        client: {} as GameClient,
      }),
    );
  const failed = render(dice);
  assert.ok(failed.includes("掷骰失败"));
  assert.ok(failed.includes(dice.error!));
  for (const hidden of ["undefined", "自动掷骰", "掷骰结果", "<button"])
    assert.ok(!failed.includes(hidden));
  const completed = render({
    ...dice,
    status: "complete",
    error: undefined,
    dice: { ...dice.dice, rolls: [18], total: 18 },
  });
  assert.ok(completed.includes("掷骰结果"));
  assert.ok(completed.includes("18 = 18"));
});
