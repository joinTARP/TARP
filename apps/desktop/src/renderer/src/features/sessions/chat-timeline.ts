import type { ChatMessage } from "@jointarp/core/shared/game";

import { diceTimeline } from "./dice-timeline";

export interface ChatTimelineEntry {
  key: string;
  message: ChatMessage;
  grouped: boolean;
  detailsMessage?: ChatMessage;
}

/** 先整理完整时间线，再截取可见窗口，避免分组和推理入口随滚动变化。 */
export function chatTimeline(messages: ChatMessage[], showReasoning = false): ChatTimelineEntry[] {
  const originals = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const timeline = diceTimeline(messages);
  const entries: ChatTimelineEntry[] = [];
  for (let index = 0; index < timeline.length; index++) {
    const { key, message } = timeline[index];
    if (
      (message.kind === "assistant" &&
        message.internal &&
        !(showReasoning && message.companionId) &&
        (message.status === "complete" ||
          (message.status === "running" && Boolean(message.companionId)))) ||
      (message.kind === "card" && message.card.type === "ready")
    )
      continue;

    const previous = timeline[index - 1]?.message;
    const continuousNarration =
      message.kind === "scripted" &&
      previous?.kind === "scripted" &&
      message.speakerPath === previous.speakerPath;
    const created = new Date(message.createdAt);
    const prior = previous ? new Date(previous.createdAt) : null;
    entries.push({
      key,
      message,
      grouped: Boolean(
        previous &&
        prior &&
        message.kind !== "assistant" &&
        previous.kind === message.kind &&
        previous.senderId === message.senderId &&
        previous.nickname === message.nickname &&
        (message.kind !== "player" ||
          previous.kind !== "player" ||
          previous.chatOnly === message.chatOnly) &&
        (message.kind !== "scripted" || continuousNarration) &&
        (previous.status === "complete" ||
          (continuousNarration && previous.status === "running")) &&
        (message.status === "complete" || (continuousNarration && message.status === "running")) &&
        !message.pendingAgent &&
        created.toDateString() === prior.toDateString() &&
        created.getTime() >= prior.getTime() &&
        created.getTime() - prior.getTime() < 5 * 60_000,
      ),
      detailsMessage:
        message.kind === "assistant" && !seen.has(message.id)
          ? originals.get(message.id)
          : undefined,
    });
    seen.add(message.id);
  }
  return entries;
}
