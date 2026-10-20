import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { publicAssistant } from "../../shared/agent-message";
import type { PublicAgentEvent } from "../../shared/game";

/** 每次生成尝试独立实例，过滤内部内容并为公开文本块重新编号。 */
export class PublicAgentStream {
  private messageIndex = -1;
  private contentIndices = new Map<number, number>();
  private usage = "";
  constructor(
    private emit: (event: PublicAgentEvent) => void,
    private options: { text?: boolean; toolNames?: ReadonlySet<string> } = {},
  ) {}
  accept(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.messageIndex++;
      this.contentIndices = new Map();
      this.usage = JSON.stringify(event.message.usage);
      this.emit({
        type: "message_start",
        messageIndex: this.messageIndex,
        message: publicAssistant({ ...event.message, content: [] }, this.options),
      });
    }
    if (event.type === "message_update") {
      const part = event.assistantMessageEvent;
      if ("partial" in part) {
        const usage = JSON.stringify(part.partial.usage);
        if (usage !== this.usage) {
          this.usage = usage;
          this.emit({
            type: "usage",
            messageIndex: this.messageIndex,
            usage: structuredClone(part.partial.usage),
          });
        }
      }
      if (part.type === "text_start" && this.options.text !== false) {
        const contentIndex = this.contentIndices.size;
        this.contentIndices.set(part.contentIndex, contentIndex);
        this.emit({ type: "text_start", messageIndex: this.messageIndex, contentIndex });
      } else if (
        (part.type === "text_delta" || part.type === "text_end") &&
        this.options.text !== false
      ) {
        const contentIndex = this.contentIndices.get(part.contentIndex);
        if (contentIndex === undefined) return;
        this.emit(
          part.type === "text_delta"
            ? {
                type: "text_delta",
                messageIndex: this.messageIndex,
                contentIndex,
                delta: part.delta,
              }
            : {
                type: "text_end",
                messageIndex: this.messageIndex,
                contentIndex,
                content: part.content,
              },
        );
      } else if (
        part.type === "toolcall_start" ||
        part.type === "toolcall_delta" ||
        part.type === "toolcall_end"
      ) {
        const toolCall = part.partial.content[part.contentIndex];
        if (toolCall?.type !== "toolCall") return;
        const toolNames = this.options.toolNames ?? new Set<string>();
        if (!toolNames.has(toolCall.name)) return;
        let contentIndex = this.contentIndices.get(part.contentIndex);
        if (part.type === "toolcall_start") {
          contentIndex = this.contentIndices.size;
          this.contentIndices.set(part.contentIndex, contentIndex);
        }
        if (contentIndex === undefined) return;
        this.emit({
          type: part.type,
          messageIndex: this.messageIndex,
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.name,
            arguments: structuredClone(toolCall.arguments),
          },
        });
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.emit({
        type: "message_end",
        messageIndex: this.messageIndex,
        message: publicAssistant(event.message, this.options),
      });
    }
  }
}
