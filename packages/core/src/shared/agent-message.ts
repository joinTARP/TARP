import type { AssistantMessage } from "@earendil-works/pi-ai";

import { companionPlainText } from "./companion";
import {
  publicAssistantSchema,
  type ChatEvent,
  type ChatMessage,
  type PublicAgentEvent,
} from "./game";
import { parseMentionRefs } from "./mentions";
import { parseNarrative } from "./narrative";

/** 严格公开投影：只传递正文和显式允许的工具，不传递思考、签名或供应商私有字段。 */
export function publicAssistant(
  message: AssistantMessage,
  options: { text?: boolean; toolNames?: ReadonlySet<string> } = {},
) {
  const { text = true, toolNames = new Set<string>() } = options;
  const content: AssistantMessage["content"] = [];
  for (const part of message.content) {
    if (text && part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "toolCall" && toolNames.has(part.name))
      content.push({
        type: "toolCall",
        id: part.id,
        name: part.name,
        arguments: part.arguments,
      });
  }
  return publicAssistantSchema.parse({
    ...message,
    content,
  });
}

export function publicAssistantText(message: AssistantMessage): string {
  let text = "";
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "toolCall") {
      const performance =
        part.name === "companion_perform"
          ? part.arguments.text
          : part.name === "companion_request_ruling"
            ? part.arguments.intent
            : undefined;
      if (typeof performance !== "string") continue;
      if (text && !text.endsWith("\n")) text += "\n\n";
      text += performance;
    }
  }
  return text;
}

/** 按工具正文解析身份链接，保持聊天与行动各自的点名边界。 */
export function companionMentionRefs(messages: readonly AssistantMessage[]): unknown[] {
  return messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type !== "toolCall") return [];
      const text =
        part.name === "companion_perform"
          ? part.arguments.text
          : part.name === "companion_request_ruling"
            ? part.arguments.intent
            : undefined;
      return typeof text === "string" ? parseMentionRefs(companionPlainText(text)) : [];
    }),
  );
}

/** 失败请求可以保留供诊断，但不作为成功回合的发言、行动或点名来源。 */
export function successfulAgentMessages(messages: readonly AssistantMessage[]) {
  return messages.filter((item) => item.stopReason !== "error" && item.stopReason !== "aborted");
}

/** 完成后只展示确认内容；运行、失败或停止时保留已经流出的草稿。 */
export function visibleAgentMessages(message: Extract<ChatMessage, { kind: "assistant" }>) {
  return message.status === "complete"
    ? successfulAgentMessages(message.agentMessages)
    : message.agentMessages;
}

/** 队友的玩家可见正文：纯聊天和提交行动均按原话显示。 */
export function companionDisplayText(message: Extract<ChatMessage, { kind: "assistant" }>) {
  return visibleAgentMessages(message).map(publicAssistantText).filter(Boolean).join("\n\n");
}

export function chatText(message: ChatMessage): string {
  if (message.kind === "player" || message.kind === "scripted") return message.text;
  if (message.kind === "assistant" && message.companionId) return companionDisplayText(message);
  if (message.kind === "card") {
    if (message.card.type === "ready")
      return message.status === "complete" ? "已准备" : "准备好了吗？";
    if (message.card.type === "start") return message.card.selectedId ? `已选择开局` : "请选择开局";
    if (message.card.type === "companions") {
      if (message.card.stage === "complete")
        return message.card.selected?.length
          ? `同行队友：${message.card.selected.map((character) => character.name).join("、")}`
          : "独自开始冒险";
      return message.card.stage === "prompt" ? "要添加 AI 队友，一起冒险吗？" : "选择 AI 队友";
    }
    return message.card.selectedLabel ? `已选择${message.card.selectedLabel}` : "请选择你的角色";
  }
  if (message.kind === "dice")
    return `${message.dice.expression}: ${message.dice.total ?? "等待掷骰"}`;
  return visibleAgentMessages(message)
    .map((item) => {
      const text = publicAssistantText(item);
      return parseNarrative(text)
        .map((part) => (part.kind === "npc" ? `${part.name || "NPC"}：${part.text}` : part.text))
        .join("\n\n");
    })
    .join("\n\n");
}

export function applyAgentParts(
  messages: AssistantMessage[],
  events: PublicAgentEvent[],
): AssistantMessage[] {
  const next = [...messages];
  for (const event of events) {
    if (event.type === "message_start") {
      if (event.messageIndex !== next.length) throw new Error("agent 消息顺序不连续");
      next.push(structuredClone(event.message));
      continue;
    }
    const message = next[event.messageIndex];
    if (!message) throw new Error("缺少 agent 消息起点");
    if (event.type === "usage") {
      next[event.messageIndex] = { ...message, usage: structuredClone(event.usage) };
      continue;
    }
    if (event.type === "message_end") {
      next[event.messageIndex] = structuredClone(event.message);
      continue;
    }
    const content = [...message.content];
    if (event.type === "text_start") {
      if (event.contentIndex !== content.length) throw new Error("文本块顺序不连续");
      content.push({ type: "text", text: "" });
    } else if (
      event.type === "toolcall_start" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end"
    ) {
      if (event.type === "toolcall_start") {
        if (event.contentIndex !== content.length) throw new Error("工具块顺序不连续");
        content.push(structuredClone(event.toolCall));
      } else {
        const part = content[event.contentIndex];
        if (part?.type !== "toolCall") throw new Error("缺少工具块起点");
        content[event.contentIndex] = structuredClone(event.toolCall);
      }
    } else {
      const part = content[event.contentIndex];
      if (part?.type !== "text") throw new Error("缺少文本块起点");
      content[event.contentIndex] = {
        type: "text",
        text: event.type === "text_delta" ? part.text + event.delta : event.content,
      };
    }
    next[event.messageIndex] = { ...message, content };
  }
  return next;
}

export function applyChatEvent(messages: ChatMessage[], event: ChatEvent): ChatMessage[] {
  if (event.type === "mode" || event.type === "steering") return messages;
  const id = event.type === "message" ? event.message.id : event.messageId;
  const existing = messages.find((message) => message.id === id);
  if (event.type === "message") {
    if (existing && existing.revision > event.message.revision) return messages;
    return [...messages.filter((message) => message.id !== id), event.message].sort(
      (a, b) => a.sequence - b.sequence,
    );
  }
  if (!existing) throw new Error("需要读取消息快照");
  if (event.revision <= existing.revision) return messages;
  if (
    existing.kind !== "assistant" ||
    existing.attemptId !== event.attemptId ||
    event.revision !== existing.revision + 1
  )
    throw new Error("需要同步消息快照");
  const updated = {
    ...existing,
    revision: event.revision,
    agentMessages: applyAgentParts(existing.agentMessages, event.events),
  };
  return messages.map((message) => (message.id === id ? updated : message));
}
