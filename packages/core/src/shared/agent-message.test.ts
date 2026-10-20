import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { PublicAgentStream } from "../node/agent/public-stream";
import { applyChatEvent, chatText, companionDisplayText } from "./agent-message";
import type { ChatMessage, PublicAgentEvent } from "./game";

function native(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test-model",
    timestamp: 1,
    stopReason: "pending",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const base: ChatMessage = {
  id: "message",
  roomId: "room",
  sequence: 1,
  senderId: "agent",
  nickname: "主持人",
  createdAt: "now",
  kind: "assistant",
  agentMessages: [],
  revision: 1,
  attemptId: "first",
  status: "running",
};

test("重试成功只展示确认的发言，失败中止仍保留已流出的草稿", () => {
  const firstId = "123e4567-e89b-42d3-a456-426614174000";
  const secondId = "123e4567-e89b-42d3-a456-426614174001";
  const failed: AssistantMessage = {
    ...native(),
    stopReason: "error",
    content: [
      {
        type: "toolCall",
        id: "failed",
        name: "companion_perform",
        arguments: { text: `[@乙](#mention/${firstId}) 失败草稿` },
      },
    ],
  };
  const confirmed: AssistantMessage = {
    ...native(),
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "confirmed",
        name: "companion_perform",
        arguments: { text: `[@甲](#mention/${secondId}) 确认发言` },
      },
    ],
  };
  const message = {
    ...base,
    kind: "assistant" as const,
    status: "complete" as const,
    companionId: "companion",
    agentMessages: [failed, confirmed],
  };
  assert.equal(companionDisplayText(message), `[@甲](#mention/${secondId}) 确认发言`);
  assert.equal(chatText(message), `[@甲](#mention/${secondId}) 确认发言`);
  assert.equal(
    companionDisplayText({
      ...message,
      status: "running",
      agentMessages: [
        {
          ...native(),
          content: [
            {
              type: "toolCall",
              id: "ascii",
              name: "companion_perform",
              arguments: { text: "@abc" },
            },
          ],
        },
      ],
    }),
    "@abc",
  );
  assert.equal(
    companionDisplayText({
      ...message,
      status: "running",
      agentMessages: [
        {
          ...native(),
          content: [
            {
              type: "toolCall",
              id: "partial",
              name: "companion_perform",
              arguments: { text: `请问 [@甲](#mention/${secondId.slice(0, 12)}` },
            },
          ],
        },
      ],
    }),
    `请问 [@甲](#mention/${secondId.slice(0, 12)}`,
  );
  assert(
    companionDisplayText({
      ...message,
      status: "failed",
    }).includes(`[@乙](#mention/${firstId}) 失败草稿`),
  );
});

test("pi 公开适配保留原生模型及用量，隔离思考工具和签名，处理多步与内容索引重用", () => {
  const events: PublicAgentEvent[] = [];
  const adapter = new PublicAgentStream((event) => events.push(event));
  for (const text of ["第一段", "第二段"]) {
    const message = native();
    adapter.accept({ type: "message_start", message });
    adapter.accept({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "秘密",
        partial: message,
      },
    });
    adapter.accept({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: message },
    });
    adapter.accept({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: text, partial: message },
    });
    adapter.accept({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: text, partial: message },
    });
    message.content = [
      { type: "thinking", thinking: "秘密", thinkingSignature: "secret-signature" },
      { type: "text", text },
      { type: "toolCall", id: "tool", name: "read", arguments: { secret: "幕后资料" } },
    ];
    message.errorMessage = "private-error";
    message.stopReason = "stop";
    adapter.accept({ type: "message_end", message });
    message.content[1] = { type: "text", text: "后续修改不应影响已发事件" };
  }
  const result = applyChatEvent([base], {
    type: "agent",
    cursor: 3,
    messageId: base.id,
    attemptId: "first",
    revision: 2,
    events,
  });
  assert.equal(chatText(result[0]), "第一段\n\n第二段");
  assert.equal(result[0].kind === "assistant" && result[0].agentMessages[1].usage.totalTokens, 3);
  for (const secret of ["秘密", "signature", "幕后资料", "private-error", "partial"])
    assert.ok(!JSON.stringify(events).includes(secret));
});

test("公开工具白名单保留原生调用事件，并用修复后的参数对象更新正文", () => {
  const events: PublicAgentEvent[] = [];
  const adapter = new PublicAgentStream((event) => events.push(event), {
    text: false,
    toolNames: new Set(["companion_perform"]),
  });
  const message = native();
  const toolCall = {
    type: "toolCall" as const,
    id: "say-1",
    name: "companion_perform",
    arguments: { text: "" },
  };
  message.content = [toolCall];
  adapter.accept({ type: "message_start", message });
  adapter.accept({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
  });
  toolCall.arguments.text = "我在";
  adapter.accept({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '\"我在',
      partial: message,
    },
  });
  toolCall.arguments.text = "我在，跟紧我。";
  adapter.accept({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: message,
    },
  });
  message.content.push({ type: "text", text: "不应公开的普通文本" });
  message.content.push({ type: "toolCall", id: "read-1", name: "read", arguments: {} });
  message.stopReason = "toolUse";
  adapter.accept({ type: "message_end", message });

  const result = applyChatEvent([base], {
    type: "agent",
    cursor: 3,
    messageId: base.id,
    attemptId: "first",
    revision: 2,
    events,
  });
  assert.equal(chatText(result[0]), "我在，跟紧我。");
  assert.equal(
    events.find((event) => event.type === "toolcall_delta")?.toolCall.arguments.text,
    "我在",
  );
  assert.ok(!JSON.stringify(events).includes("不应公开"));
  assert.ok(!JSON.stringify(events).includes('"read"'));
});

test("同一轮的多次队友表演按调用顺序合并为多个段落", () => {
  const message = native();
  message.content = [
    {
      type: "toolCall",
      id: "perform-1",
      name: "companion_perform",
      arguments: { text: "<action>蹲到浅坑边，伸出手。</action>" },
    },
    {
      type: "toolCall",
      id: "perform-2",
      name: "companion_perform",
      arguments: { text: "抓住我的手，先别乱动！" },
    },
    {
      type: "toolCall",
      id: "ruling-1",
      name: "companion_request_ruling",
      arguments: { intent: "在陆川配合后把他拉出浅坑" },
    },
  ];
  const chat: ChatMessage = {
    ...base,
    agentMessages: [message],
    status: "complete",
  };
  assert.equal(
    chatText(chat),
    "<action>蹲到浅坑边，伸出手。</action>\n\n抓住我的手，先别乱动！\n\n在陆川配合后把他拉出浅坑",
  );
  assert.equal(
    companionDisplayText(chat),
    "<action>蹲到浅坑边，伸出手。</action>\n\n抓住我的手，先别乱动！\n\n在陆川配合后把他拉出浅坑",
  );
});

test("队友裁定请求的 intent 正文在工具调用完成前已可显示", () => {
  const events: PublicAgentEvent[] = [];
  const adapter = new PublicAgentStream((event) => events.push(event), {
    text: false,
    toolNames: new Set(["companion_request_ruling"]),
  });
  const message = native();
  const toolCall = {
    type: "toolCall" as const,
    id: "ruling-stream",
    name: "companion_request_ruling",
    arguments: { intent: "" },
  };
  message.content = [toolCall];
  adapter.accept({ type: "message_start", message });
  adapter.accept({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
  });
  toolCall.arguments.intent = "推开石门";
  adapter.accept({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '"推开石门',
      partial: message,
    },
  });
  const result = applyChatEvent([base], {
    type: "agent",
    cursor: 3,
    messageId: base.id,
    attemptId: "first",
    revision: 2,
    events,
  });
  assert.ok(result[0].kind === "assistant");
  assert.equal(companionDisplayText(result[0]), "推开石门");
});

test("重复增量不重复追加，缺段触发快照恢复，重试隔离旧 attempt，旧快照不覆盖新版", () => {
  const initial = {
    type: "agent" as const,
    cursor: 2,
    messageId: base.id,
    attemptId: "first",
    revision: 2,
    events: [
      { type: "message_start" as const, messageIndex: 0, message: native() },
      { type: "text_start" as const, messageIndex: 0, contentIndex: 0 },
      { type: "text_delta" as const, messageIndex: 0, contentIndex: 0, delta: "你好" },
    ],
  };
  const once = applyChatEvent([base], initial);
  assert.equal(applyChatEvent(once, initial), once);
  assert.throws(() => applyChatEvent(once, { ...initial, revision: 4 }));
  assert.throws(() => applyChatEvent([], initial));
  const reset = { ...base, revision: 4, attemptId: "second" };
  const retried = applyChatEvent(once, { type: "message", cursor: 4, message: reset });
  assert.equal(chatText(retried[0]), "");
  assert.equal(applyChatEvent(retried, initial), retried);
  assert.throws(() => applyChatEvent(retried, { ...initial, revision: 5 }));
  assert.equal(applyChatEvent(retried, { type: "message", cursor: 1, message: base }), retried);
});

test("流式思考期间同步实测用量，同一快照不重复发送，终态替换而非累加", () => {
  const events: PublicAgentEvent[] = [];
  const adapter = new PublicAgentStream((event) => events.push(event));
  const message = native();
  adapter.accept({ type: "message_start", message });
  message.usage = { ...message.usage, input: 120, cacheRead: 30, output: 5, totalTokens: 155 };
  for (let i = 0; i < 2; i++)
    adapter.accept({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "私密推理",
        partial: message,
      },
    });
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  const project = () =>
    applyChatEvent([base], {
      type: "agent",
      cursor: 3,
      messageId: base.id,
      attemptId: "first",
      revision: 2,
      events,
    })[0];
  const live = project();
  assert(live.kind === "assistant");
  assert.equal(live.agentMessages[0].usage.totalTokens, 155);
  message.usage.output = 10;
  message.usage.totalTokens = 160;
  assert.equal(live.agentMessages[0].usage.totalTokens, 155);
  message.stopReason = "stop";
  adapter.accept({ type: "message_end", message });
  const final = project();
  assert(final.kind === "assistant");
  assert.equal(final.agentMessages[0].usage.totalTokens, 160);
  assert.equal(JSON.stringify(events).includes("私密推理"), false);
});
