import { chatText, publicAssistantText } from "@jointarp/core/shared/agent-message";
import type { ChatMessage } from "@jointarp/core/shared/game";
import { parseNarrative } from "@jointarp/core/shared/narrative";

import type { TtsSpeaker } from "./tts";
import { ttsTextLimit } from "./tts";

/** 朗读公开正文，移除展示协议、代码和图片地址。 */
export function speechText(source: string): string {
  return source
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/gu, "")
    .replace(/\[\[([^\]]+)\]\]/gu, (_, path: string) =>
      path
        .split("/")
        .at(-1)!
        .replace(/\.(json|toml|md)$/iu, ""),
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/[*_~`]/gu, "")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "小于")
    .replace(/&gt;/gu, "大于")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function messageSpeechText(message: ChatMessage): string {
  if (
    message.kind === "card" ||
    message.kind === "dice" ||
    (message.kind === "assistant" && message.internal)
  )
    return "";
  return speechText(chatText(message));
}

export interface SpeechPart {
  text: string;
  speaker: TtsSpeaker;
  key: string;
  name?: string;
}

/** 文本分段和 UI 的叙述分段共用同一解析器，NPC 不会被主持人声音吞并。 */
function messageSpeechParts(
  message: ChatMessage,
  playerCharacterNames: ReadonlySet<string> = new Set(),
  playerCharacterPaths: ReadonlySet<string> = new Set(),
): SpeechPart[] {
  if (message.kind === "scripted") {
    const text = speechText(message.text);
    return text
      ? [
          {
            text,
            key: "0",
            speaker: {
              roomId: message.roomId,
              kind: message.speakerPath ? "npc" : "host",
              id: message.speakerPath ?? "",
            },
          },
        ]
      : [];
  }
  if (message.kind !== "assistant" || message.internal) return [];
  if (message.companionId) {
    const text = messageSpeechText(message);
    return text
      ? [
          {
            text,
            key: "0",
            speaker: {
              roomId: message.roomId,
              kind: "companion",
              id: message.companionId,
            },
          },
        ]
      : [];
  }
  return message.agentMessages.flatMap((item, index) =>
    parseNarrative(publicAssistantText(item), playerCharacterNames, playerCharacterPaths).flatMap(
      (part) => {
        const text = speechText(part.text);
        return text
          ? [
              {
                text,
                key: `${index}:${part.key}`,
                name: part.name,
                speaker: {
                  roomId: message.roomId,
                  kind: part.kind === "npc" ? "npc" : "host",
                  id: part.kind === "npc" ? part.path! : "",
                },
              },
            ]
          : [];
      },
    ),
  );
}

/** 优先按句断开，超长句按 Unicode 字符切开，并满足 RPC 字符数上限。 */
export function splitSpeechText(text: string): string[] {
  const result: string[] = [];
  let pending = "";
  for (const sentence of text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? []) {
    if (pending.length + sentence.length > ttsTextLimit && pending.trim()) {
      result.push(pending.trim());
      pending = "";
    }
    for (const char of sentence) {
      if (pending.length + char.length > ttsTextLimit) {
        if (pending.trim()) result.push(pending.trim());
        pending = "";
      }
      pending += char;
    }
  }
  if (pending.trim()) result.push(pending.trim());
  return result;
}

/** 仅新完成的公开 AI / 剧本消息触发自动播报；重连重放不会再次触发。 */
export class AutomaticSpeechTracker {
  private seen = new Set<string>();
  seed(messages: readonly ChatMessage[]) {
    for (const message of messages) if (message.status !== "running") this.seen.add(message.id);
  }
  takeParts(
    message: ChatMessage,
    playerCharacterNames?: ReadonlySet<string>,
    playerCharacterPaths?: ReadonlySet<string>,
  ): SpeechPart[] | undefined {
    if (message.status !== "complete" || this.seen.has(message.id)) return;
    this.seen.add(message.id);
    const parts = messageSpeechParts(message, playerCharacterNames, playerCharacterPaths);
    return parts.length ? parts : undefined;
  }
}
