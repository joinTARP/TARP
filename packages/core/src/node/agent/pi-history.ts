import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import type { AgentContext, AgentContextBlock } from "../../shared/agent-context";
import type { AgentDetail } from "../../shared/agent-details";
import type { ChatMessage, PiMessageReference } from "../../shared/game";
import { inputBatchCustomType, inputReceiptSchema, type ReceivedInput } from "./input-batch";
import { PiSessionCache } from "./pi-session-cache";
import { steeringBatchSchema, steeringCustomType, type ReceivedSteering } from "./steering-batch";

type Assistant = Extract<ChatMessage, { kind: "assistant" }>;
export const companionDecisionRetryType = "companion_decision_retry";
export const companionDecisionRetryDetail: AgentDetail = {
  id: companionDecisionRetryType,
  kind: "tool",
  text: "空回复补问（1/1）",
  result: "未收到有效的回应或沉默决定，已发起一次补问。",
  status: "complete",
};
export interface PiMessageSummary {
  provider?: string;
  model?: string;
  toolCalls: number;
}

/** 只沿 Pi 的 parentId 与 byId 索引读取消息范围，不另建文件索引。 */
function messageEntries(manager: SessionManager, reference: PiMessageReference): SessionEntry[] {
  if (manager.getSessionId() !== reference.sessionId || !reference.afterEntryId) return [];
  const entries: SessionEntry[] = [];
  let id: string | null = reference.afterEntryId;
  while (id !== reference.beforeEntryId) {
    if (!id) return [];
    const entry = manager.getEntry(id);
    if (!entry) return [];
    entries.push(entry);
    id = entry.parentId;
  }
  return entries.reverse();
}

/** 与运行共享 SessionManager，缓存只保留由原生条目引用计算的轻量摘要。 */
export class PiHistory {
  private summaries = new WeakMap<SessionManager, Map<string, PiMessageSummary>>();

  constructor(private readonly sessions = new PiSessionCache()) {}

  /** 从最近条目向前找实测用量，遇到压缩边界后不再使用旧读数。 */
  async contextTokens(
    room: string,
    companionId?: string,
    streaming?: { tokens: number; timestamp: number },
  ): Promise<number | null | undefined> {
    const manager = await this.sessions.read(room, companionId);
    let id = manager?.getLeafId();
    while (manager && id) {
      const entry = manager.getEntry(id);
      if (!entry) break;
      if (entry.type === "compaction")
        return streaming && streaming.timestamp > Date.parse(entry.timestamp)
          ? streaming.tokens
          : null;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const tokens = entry.message.usage.input + entry.message.usage.cacheRead;
        if (tokens > 0)
          return streaming && streaming.timestamp >= entry.message.timestamp
            ? streaming.tokens
            : tokens;
      }
      id = entry.parentId;
    }
    return streaming?.tokens;
  }

  /** 只读取原生投影，不重建提示词、不经过请求适配，也不触发模型运行。 */
  async context(room: string, companionId?: string): Promise<AgentContext> {
    const manager = await this.sessions.read(room, companionId);
    const groups: AgentContext["groups"] = [];
    for (const message of manager?.buildSessionContext().messages ?? []) {
      const blocks: AgentContextBlock[] = [];
      const text = (title: string, value: string, kind: AgentContextBlock["kind"] = "text") => {
        if (value) blocks.push({ title, text: value, kind });
      };
      if (message.role === "compactionSummary" || message.role === "branchSummary") {
        text("记忆正文", message.summary);
      } else if (message.role === "bashExecution") {
        text("命令", message.command, "tool");
        text("执行结果", message.output, "tool");
        if (message.excludeFromContext) continue;
      } else {
        if (typeof message.content === "string") text("正文", message.content);
        else
          for (const part of message.content) {
            if (part.type === "text") text("正文", part.text);
            else if (part.type === "thinking")
              text(
                "思考",
                part.redacted || (!part.thinking && part.thinkingSignature)
                  ? "[加密思考内容]"
                  : part.thinking,
                "thinking",
              );
            else if (part.type === "toolCall")
              text(
                `工具调用 · ${part.name}`,
                JSON.stringify({ id: part.id, arguments: part.arguments }, null, 2),
                "tool",
              );
            else if (part.type === "image")
              blocks.push({
                kind: "image",
                title: "图片",
                text: `[图片 · ${part.mimeType}]`,
                imageUrl: `data:${part.mimeType};base64,${part.data}`,
              });
          }
        if (message.role === "system") {
          // sections 的插入顺序就是 Pi 的提示板块注入顺序；null 表示移除。
          for (const [name, value] of Object.entries(message.sections ?? {}))
            blocks.push({
              kind: "text",
              title: `提示板块 · ${name}`,
              text: value ?? "[已移除此板块]",
            });
          for (const tool of message.toolsAdded ?? [])
            text(`工具定义 · ${tool.name}`, JSON.stringify(tool, null, 2), "tool");
          for (const tool of message.toolsRemoved ?? [])
            text("移除工具", JSON.stringify(tool), "tool");
        }
      }
      const titles: Record<string, string> = {
        system: "系统提示",
        user: "输入消息",
        assistant: "AI 回复",
        compactionSummary: "压缩记忆",
        branchSummary: "分支记忆",
        custom: "注入消息",
        bashExecution: "命令执行",
      };
      const title =
        message.role === "toolResult"
          ? `工具结果 · ${message.toolName}${message.isError ? "（失败）" : ""}`
          : message.role === "custom"
            ? `注入消息 · ${message.customType}`
            : (titles[message.role] ?? message.role);
      if (blocks.length) groups.push({ title, blocks });
    }
    return { readAt: new Date().toISOString(), groups };
  }

  async summary(room: string, message: Assistant): Promise<PiMessageSummary | undefined> {
    if (!message.pi) return undefined;
    const manager = await this.sessions.read(room, message.companionId);
    if (!manager || manager.getSessionId() !== message.pi.sessionId) return undefined;
    let summaries = this.summaries.get(manager);
    if (!summaries) {
      summaries = new Map();
      this.summaries.set(manager, summaries);
    }
    const key = JSON.stringify(message.pi);
    const cached = summaries.get(key);
    if (cached) return cached;
    const summary: PiMessageSummary = { toolCalls: 0 };
    for (const entry of messageEntries(manager, message.pi)) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      summary.provider ??= entry.message.provider;
      summary.model ??= entry.message.model;
      summary.toolCalls += entry.message.content.filter((part) => part.type === "toolCall").length;
    }
    summaries.set(key, summary);
    return summary;
  }

  async details(room: string, message: Assistant): Promise<AgentDetail[]> {
    if (!message.pi) return [];
    const manager = await this.sessions.read(room, message.companionId);
    if (!manager) return [];
    return projectDetails(messageEntries(manager, message.pi));
  }

  async recover(room: string, message: Assistant): Promise<PiMessageReference | undefined> {
    if (!message.pi) return undefined;
    const manager = await this.sessions.read(room, message.companionId);
    if (!manager || manager.getSessionId() !== message.pi.sessionId) return message.pi;
    return { ...message.pi, afterEntryId: manager.getLeafId() };
  }

  async inputBatches(room: string): Promise<ReceivedInput[]> {
    const manager = await this.sessions.read(room);
    if (!manager) return [];
    return manager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom_message" || entry.customType !== inputBatchCustomType) return [];
      const receipt = inputReceiptSchema.parse(entry.details);
      return [
        {
          ...receipt,
          reference: {
            sessionId: manager.getSessionId(),
            beforeEntryId: entry.parentId,
            afterEntryId: entry.id,
          },
        },
      ];
    });
  }

  async steeringBatches(room: string): Promise<ReceivedSteering[]> {
    const manager = await this.sessions.read(room);
    if (!manager) return [];
    const branch = manager.getBranch();
    return branch.flatMap((entry, index) => {
      if (entry.type !== "custom_message" || entry.customType !== steeringCustomType) return [];
      const parsed = steeringBatchSchema.safeParse(entry.details);
      if (!parsed.success) throw new Error("插话接收标记损坏");
      const nextBoundary = branch
        .slice(index + 1)
        .findIndex((e) => e.type === "custom_message" && e.customType === steeringCustomType);
      const after = nextBoundary < 0 ? branch.at(-1)! : branch[index + nextBoundary];
      return [
        {
          batch: parsed.data,
          reference: {
            sessionId: manager.getSessionId(),
            beforeEntryId: entry.parentId,
            afterEntryId: after.id,
          },
        },
      ];
    });
  }

  closeRoom(room: string) {
    return this.sessions.closeRoom(room);
  }
}

function projectDetails(entries: readonly SessionEntry[]): AgentDetail[] {
  const details: AgentDetail[] = [];
  let assistantIndex = -1;
  const detailIndex = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === companionDecisionRetryType)
      details.push({ ...companionDecisionRetryDetail });
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      assistantIndex++;
      message.content.forEach((part, index) => {
        if (part.type === "thinking" && part.thinking.trim()) {
          details.push({
            id: `thinking:${assistantIndex}:${index}`,
            kind: "thinking",
            text: part.thinking,
            status:
              message.stopReason === "error" || message.stopReason === "aborted"
                ? "failed"
                : "complete",
          });
        }
        if (part.type === "toolCall") {
          detailIndex.set(part.id, details.length);
          details.push({
            id: `tool:${part.id}`,
            kind: "tool",
            text: part.name,
            arguments: JSON.stringify(part.arguments, null, 2),
            status: "running",
          });
        }
      });
    } else if (message.role === "toolResult") {
      const index = detailIndex.get(message.toolCallId);
      if (index === undefined) continue;
      const previous = details[index];
      const result = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const images = message.content.filter((part) => part.type === "image").length;
      const value = [result, images ? `[图片${images > 1 ? ` ×${images}` : ""}]` : ""]
        .filter(Boolean)
        .join("\n");
      details[index] = {
        ...previous,
        ...(value ? { [message.isError ? "error" : "result"]: value } : {}),
        status: message.isError ? "failed" : "complete",
      };
      // SDK 已将嵌套调用落在父工具结果上；只投影原生记录，不另存返回值。
      for (const call of message.nestedCalls?.calls ?? []) {
        details.push({
          id: `tool:${call.id}`,
          kind: "tool",
          text: call.name,
          ...(call.arguments !== undefined
            ? { arguments: JSON.stringify(call.arguments, null, 2) }
            : {}),
          ...(call.error ? { error: call.error } : {}),
          ...(call.status === "unfinished" ? { error: "调用未完成" } : {}),
          status: call.status === "ok" ? "complete" : "failed",
        });
      }
    }
  }
  return details;
}
