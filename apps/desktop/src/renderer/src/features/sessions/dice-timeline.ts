import type { ChatMessage } from "@jointarp/core/shared/game";

/** 同一 AI 回合可能先提出检定，掷骰后再继续；按调用位置展开公开正文。 */
export function diceTimeline(messages: ChatMessage[]): { key: string; message: ChatMessage }[] {
  const assistants = new Map(
    messages.filter((item) => item.kind === "assistant").map((item) => [item.id, item]),
  );
  const linked = new Map<string, Extract<ChatMessage, { kind: "dice" }>[]>();
  const embedded = new Set<string>();
  for (const item of messages) {
    if (item.kind !== "dice" || !item.dice.sourceMessageId) continue;
    const source = assistants.get(item.dice.sourceMessageId);
    if (!source || source.attemptId !== item.dice.sourceAttemptId) continue;
    const entries = linked.get(source.id) ?? [];
    entries.push(item);
    linked.set(source.id, entries);
    embedded.add(item.id);
  }
  return messages.flatMap((message) => {
    if (embedded.has(message.id)) return [];
    const dice = linked.get(message.id);
    if (message.kind !== "assistant" || !dice?.length) return [{ key: message.id, message }];
    const result: { key: string; message: ChatMessage }[] = [];
    let start = 0;
    for (const item of dice) {
      const end = Math.min(message.agentMessages.length, (item.dice.afterMessageIndex ?? -1) + 1);
      const chunk = message.agentMessages.slice(start, end);
      if (chunk.some((entry) => entry.content.some((part) => part.type === "text" && part.text)))
        result.push({
          key: start === 0 ? message.id : `${message.id}:${start}`,
          message: { ...message, agentMessages: chunk, status: "complete" },
        });
      result.push({ key: item.id, message: item });
      start = end;
    }
    if (
      start < message.agentMessages.length ||
      (message.status !== "complete" &&
        (message.status !== "running" || dice.every((item) => item.status !== "running")))
    )
      result.push({
        // 后续检定到来时，这段尾部会成为已完成分段，仍沿用同一标识。
        key: start === 0 ? message.id : `${message.id}:${start}`,
        message: { ...message, agentMessages: message.agentMessages.slice(start) },
      });
    return result;
  });
}
