import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";
import { visibleAgentMessages, publicAssistantText } from "@tarp/core/shared/agent-message";
import type { ChatMessage } from "@tarp/core/shared/game";
import { parseNarrative } from "@tarp/core/shared/narrative";

/** 只选取实际发言的文档，图片和名称仍须读取玩家可见投影。 */
export function npcPortraitDocuments(
  messages: readonly ChatMessage[],
  documents: readonly ModuleDocument[],
  playerNames: ReadonlySet<string> = new Set(),
): ModuleDocument[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.kind === "scripted" && message.speakerPath)
      paths.add(documentIdentity(message.speakerPath));
    if (message.kind !== "assistant" || message.internal || message.companionId) continue;
    for (const item of visibleAgentMessages(message))
      for (const segment of parseNarrative(publicAssistantText(item), playerNames))
        if (segment.kind === "npc") paths.add(segment.path!);
  }
  return documents.filter((document) => paths.has(documentIdentity(document.path)));
}
