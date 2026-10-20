import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { AgentDetail } from "../../shared/agent-details";
import { AgentDetailsStream } from "./details-stream";

function message(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    timestamp: 1,
    stopReason: "pending",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("幕后详情流合并推理增量，多步生成独立编号，最终快照补齐文本且移除签名", () => {
  const details = new Map<string, AgentDetail>();
  const stream = new AgentDetailsStream((detail) => details.set(detail.id, detail));
  for (let step = 0; step < 2; step++) {
    const native = message();
    stream.accept({ type: "message_start", message: native });
    stream.accept({
      type: "message_update",
      message: native,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: native },
    });
    for (const delta of ["幕后", "线索"])
      stream.accept({
        type: "message_update",
        message: native,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: native },
      });
    assert.equal(details.get(`thinking:${step}:0`)?.text, "幕后线索");
    native.content = [
      { type: "thinking", thinking: "幕后线索补全", thinkingSignature: "private-signature" },
    ];
    native.stopReason = "stop";
    stream.accept({ type: "message_end", message: native });
  }
  assert.equal(details.size, 2);
  assert.ok(
    [...details.values()].every(
      (detail) => detail.status === "complete" && detail.text === "幕后线索补全",
    ),
  );
  assert.ok(!JSON.stringify([...details.values()]).includes("private-signature"));
});

test("工具详情保留名称、参数、状态和成功正文，失败时保留错误说明", () => {
  const details: AgentDetail[] = [];
  const stream = new AgentDetailsStream((detail) => details.push(detail));
  stream.accept({
    type: "tool_execution_start",
    toolCallId: "one",
    toolName: "read",
    args: { path: "private-path" },
  });
  stream.accept({
    type: "tool_execution_end",
    toolCallId: "one",
    toolName: "read",
    result: {
      content: [{ type: "text", text: "游戏文档不存在" }],
      details: { stack: "不展示的内部细节" },
    },
    isError: true,
  });
  stream.accept({
    type: "tool_execution_start",
    toolCallId: "two",
    toolName: "read",
    args: { path: "notes.json" },
  });
  stream.accept({
    type: "tool_execution_end",
    toolCallId: "two",
    toolName: "read",
    result: {
      content: [
        { type: "text", text: "成功正文", textSignature: "private-signature" },
        { type: "image", data: "base64-image-data", mimeType: "image/png" },
      ],
      details: { stack: "不展示的内部细节" },
    },
    isError: false,
  });
  const argumentsText = '{\n  "path": "private-path"\n}';
  assert.deepEqual(details, [
    { id: "tool:one", kind: "tool", text: "read", arguments: argumentsText, status: "running" },
    {
      id: "tool:one",
      kind: "tool",
      text: "read",
      arguments: argumentsText,
      error: "游戏文档不存在",
      status: "failed",
    },
    {
      id: "tool:two",
      kind: "tool",
      text: "read",
      arguments: '{\n  "path": "notes.json"\n}',
      status: "running",
    },
    {
      id: "tool:two",
      kind: "tool",
      text: "read",
      arguments: '{\n  "path": "notes.json"\n}',
      result: "成功正文\n[图片]",
      status: "complete",
    },
  ]);
  assert.ok(!JSON.stringify(details).includes("private-signature"));
  assert.ok(!JSON.stringify(details).includes("base64-image-data"));
  assert.ok(!JSON.stringify(details).includes("不展示的内部细节"));
});

test("无推理文本的模型不产生虚构的推理记录", () => {
  const details: AgentDetail[] = [];
  const stream = new AgentDetailsStream((detail) => details.push(detail));
  const native = message();
  stream.accept({ type: "message_start", message: native });
  native.content = [{ type: "text", text: "故事正文" }];
  stream.accept({ type: "message_end", message: native });
  assert.deepEqual(details, []);
});
