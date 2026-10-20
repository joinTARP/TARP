import { parseNarrative } from "./narrative";

export interface NarrationLine {
  id: string;
  text: string;
  speakerPath?: string;
  nickname?: string;
}

/** 正文流式输出完成后留一口气，再接下一条消息或流程卡。 */
export function narrationGapMs(_text: string): number {
  return 350;
}

/** 按说话人分段发送消息，正文内的空行保留为段落。 */
export function narrationLines(
  beats: readonly { id: string; title: string; body?: string }[],
): NarrationLine[] {
  return beats.flatMap((beat) => {
    const text = (beat.body || beat.title).trim();
    return parseNarrative(text).map((segment, index) => ({
      id: `${beat.id}:${index}`,
      text: segment.text,
      speakerPath: segment.path,
      nickname: segment.kind === "npc" ? segment.name || "NPC" : "主持人",
    }));
  });
}

/** 开局方案正文交给主持人说。没有简介时用方案名。 */
export function startNarrationBeats(
  starts: readonly { id: string; name: string; description?: string }[],
): { id: string; title: string; body: string }[] {
  return starts.map((start) => ({
    id: `start-${start.id}`,
    title: start.name,
    body: start.description?.trim() || start.name,
  }));
}
