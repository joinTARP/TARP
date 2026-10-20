import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { AgentDetail } from "../../shared/agent-details";

/** 提取模型可读推理，以及工具名称、参数、成功正文和失败原因；不复制签名、图片数据或内部 details。 */
export class AgentDetailsStream {
  private messageIndex = -1;
  private thinking = new Map<number, string>();
  private toolArguments = new Map<string, string>();
  constructor(private emit: (detail: AgentDetail) => void) {}

  accept(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.messageIndex++;
      this.thinking.clear();
    }
    if (event.type === "message_update") {
      const part = event.assistantMessageEvent;
      if (
        part.type === "thinking_start" ||
        part.type === "thinking_delta" ||
        part.type === "thinking_end"
      ) {
        const text =
          part.type === "thinking_start"
            ? ""
            : part.type === "thinking_end"
              ? part.content
              : (this.thinking.get(part.contentIndex) ?? "") + part.delta;
        this.thinking.set(part.contentIndex, text);
        this.emit({
          id: `thinking:${this.messageIndex}:${part.contentIndex}`,
          kind: "thinking",
          text,
          status: part.type === "thinking_end" ? "complete" : "running",
        });
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
      event.message.content.forEach((part, index) => {
        if (part.type === "thinking" && part.thinking)
          this.emit({
            id: `thinking:${this.messageIndex}:${index}`,
            kind: "thinking",
            text: part.thinking,
            status: failed ? "failed" : "complete",
          });
      });
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const argumentsText =
        event.type === "tool_execution_start"
          ? this.rememberToolArguments(event.toolCallId, event.args)
          : this.toolArguments.get(event.toolCallId);
      const resultText =
        event.type === "tool_execution_end" && !event.isError
          ? formatToolResult(event.result)
          : undefined;
      const errorText =
        event.type === "tool_execution_end" && event.isError
          ? formatToolError(event.result)
          : undefined;
      this.emit({
        id: `tool:${event.toolCallId}`,
        kind: "tool",
        text: event.toolName,
        ...(argumentsText !== undefined ? { arguments: argumentsText } : {}),
        ...(resultText !== undefined ? { result: resultText } : {}),
        ...(errorText !== undefined ? { error: errorText } : {}),
        status:
          event.type === "tool_execution_start" ? "running" : event.isError ? "failed" : "complete",
      });
    }
  }

  /** 结束事件不含参数，开始时记下，避免完成后的覆盖把参数丢掉。 */
  private rememberToolArguments(toolCallId: string, args: unknown) {
    const text = formatToolArguments(args);
    if (text !== undefined) this.toolArguments.set(toolCallId, text);
    return text;
  }
}

function formatToolArguments(args: unknown) {
  if (args === undefined) return undefined;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return undefined;
  }
}

/** 成功结果只保留交给模型的正文。图片只记数量，避免把 base64 写进详情。 */
function formatToolResult(result: unknown) {
  const text = textContent(result);
  const images = imageCount(result);
  const note = images > 0 ? `[图片${images > 1 ? ` ×${images}` : ""}]` : undefined;
  if (text && note) return `${text}\n${note}`;
  return text ?? note;
}

/** 失败结果的正文就是运行时交给模型的错误说明。 */
function formatToolError(result: unknown) {
  const fromContent = textContent(result);
  if (fromContent) return fromContent;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["error", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  if (typeof result === "string" && result.trim()) return result;
  try {
    const json = JSON.stringify(result, null, 2);
    return json && json !== "{}" ? json : undefined;
  } catch {
    return String(result);
  }
}

function imageCount(result: unknown) {
  const content = resultContent(result);
  if (!content) return 0;
  return content.filter(
    (part) => part && typeof part === "object" && "type" in part && part.type === "image",
  ).length;
}

function resultContent(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result)) return undefined;
  const { content } = result;
  return Array.isArray(content) ? content : undefined;
}

function textContent(result: unknown) {
  const content = resultContent(result);
  if (!content) return undefined;
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
      return "text" in part && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}
