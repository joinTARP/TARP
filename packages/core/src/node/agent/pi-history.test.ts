import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { ChatMessage, PiMessageReference } from "../../shared/game";
import { PiHistory } from "./pi-history";
import { PiSessionCache } from "./pi-session-cache";

function assistant(id: string, text = "幕后推理"): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "model",
    api: "test",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      { type: "thinking", thinking: text },
      { type: "toolCall", id, name: "read", arguments: { path: "中文资料.md" } },
    ],
  };
}
function message(
  pi: PiMessageReference,
  companionId?: string,
): Extract<ChatMessage, { kind: "assistant" }> {
  return {
    id: randomUUID(),
    roomId: randomUUID(),
    sequence: 1,
    revision: 1,
    senderId: "agent",
    nickname: "主持人",
    createdAt: new Date().toISOString(),
    kind: "assistant",
    status: "complete",
    agentMessages: [],
    pi,
    companionId,
  };
}
async function fixture() {
  const room = await realpath(await mkdtemp(join(tmpdir(), "tarp-pi-history-")));
  const agent = join(room, "agent");
  await mkdir(agent);
  const path = join(agent, "session.jsonl");
  await writeFile(path, "");
  const cache = new PiSessionCache();
  const manager = await cache.take(path, agent, room);
  onTestFinished(async () => {
    await rm(room, { recursive: true, force: true });
  });
  return { room, agent, path, manager, cache, history: new PiHistory(cache) };
}

test("原生范围保留多步工具结果与压缩前详情，恢复未完成范围不影响已结束消息", async () => {
  const f = await fixture();
  const beforeEntryId = f.manager.getLeafId();
  const first = f.manager.appendMessage(assistant("tool", "压缩前的推理"));
  const completed = message({
    sessionId: f.manager.getSessionId(),
    beforeEntryId,
    afterEntryId: first,
  });
  assert.equal((await f.history.details(f.room, completed))[1].status, "running");
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool",
    toolName: "read",
    isError: false,
    timestamp: Date.now(),
    content: [
      { type: "text", text: "已完成" },
      { type: "image", data: "base64", mimeType: "image/png" },
    ],
  });
  f.manager.appendCompaction("早期内容摘要", first, 1000);
  const pending = message({
    sessionId: f.manager.getSessionId(),
    beforeEntryId: first,
    afterEntryId: first,
  });
  const next = f.manager.appendMessage(assistant("next"));
  const recovered = await f.history.recover(f.room, pending);
  assert.equal(recovered?.afterEntryId, next);
  assert.equal(
    (
      await f.history.details(f.room, {
        ...completed,
        pi: { ...completed.pi!, afterEntryId: next },
      })
    )[1].result,
    "已完成\n[图片]",
  );
  assert.equal((await f.history.details(f.room, completed))[1].status, "running");
  assert.equal(
    (await f.history.details(f.room, { ...pending, pi: recovered }))[0].text,
    "幕后推理",
  );
});

test("会话文件被替换时不误认同名条目，主持与队友范围独立，损坏边界不串到其他消息", async () => {
  const f = await fixture();
  const end = f.manager.appendMessage(assistant("tool"));
  const host = message({
    sessionId: f.manager.getSessionId(),
    beforeEntryId: null,
    afterEntryId: end,
  });
  await f.cache.retain(f.path, f.room, f.manager);
  assert.equal((await f.history.summary(f.room, host))?.toolCalls, 1);
  assert.deepEqual(
    await f.history.details(f.room, { ...host, pi: { ...host.pi!, beforeEntryId: "missing" } }),
    [],
  );
  const companionId = randomUUID();
  const path = join(f.agent, `companion-${companionId}.jsonl`);
  await writeFile(path, "");
  const companion = await f.cache.take(path, f.agent, f.room);
  const companionEnd = companion.appendMessage(assistant("companion"));
  await f.cache.retain(path, f.room, companion);
  const other = message(
    { sessionId: companion.getSessionId(), beforeEntryId: null, afterEntryId: companionEnd },
    companionId,
  );
  assert.equal((await f.history.details(f.room, other))[1].text, "read");
  assert.deepEqual(await f.history.details(f.room, { ...host, companionId }), []);
  await writeFile(
    f.path,
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: f.room,
    }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: end,
        parentId: null,
        message: assistant("replacement", "替换后的内容"),
      }) +
      "\n",
  );
  assert.deepEqual(await f.history.details(f.room, host), []);
  assert.equal(await f.history.summary(f.room, host), undefined);
  await rm(f.path);
  assert.deepEqual(await f.history.details(f.room, host), []);
});
