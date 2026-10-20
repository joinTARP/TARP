import { documentIdentity } from "./document-path";

export interface NarrativeSegment {
  key: number;
  kind: "narrator" | "npc";
  path?: string;
  name: string;
  text: string;
}

type NarrativeSpeaker = Pick<NarrativeSegment, "kind" | "path" | "name">;

const narratorSpeaker: NarrativeSpeaker = { kind: "narrator", name: "主持人" };

function parseAttributes(source: string) {
  const attrs = new Map<string, string>();
  let rest = source.trim();
  if (!rest) return;
  while (rest) {
    const match = /^([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"\s*/.exec(rest);
    if (!match) return;
    if (attrs.has(match[1])) return;
    attrs.set(match[1], match[2]);
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

/** 整行都是标签时返回说话人。属性损坏的 NPC 标签仍算标签，并退回旁白。 */
function readMarker(value: string): NarrativeSpeaker | undefined {
  if (/^<\/message\s*>$/u.test(value) || /^<message\s+narrator\s*>$/u.test(value))
    return narratorSpeaker;
  const npc = /^<message\s+npc(\s.*)?\s*>$/u.exec(value);
  if (!npc) return /^<message\s+npc(?:\s|>|$)/u.test(value) ? narratorSpeaker : undefined;
  const attrs = parseAttributes(npc[1] ?? "");
  const path = attrs?.get("path")?.trim() ?? "";
  const name = attrs?.get("name")?.trim() ?? "";
  if (
    !attrs ||
    [...attrs.keys()].some((key) => !["path", "name"].includes(key)) ||
    !path ||
    path.length > 1000 ||
    name.length > 80 ||
    /[\\<>\x00-\x1f]/u.test(path) ||
    /^(?:\/|[a-z]+:)/iu.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return narratorSpeaker;
  return { kind: "npc", path: documentIdentity(path), name };
}

/** 尚未换行、仍可能长成整行标签的半截内容。完整标签由 readMarker 处理。 */
function isPendingMarker(value: string): boolean {
  if (!value) return false;
  if ("</message>".startsWith(value) || /^<\/message\s+$/u.test(value)) return true;
  if ("<message".startsWith(value)) return true;
  if (!value.startsWith("<message")) return false;
  const rest = value.slice("<message".length);
  if (!/^\s/u.test(rest)) return false;
  const body = rest.trimStart();
  if (!body || "narrator".startsWith(body) || "npc".startsWith(body)) return true;
  if (body.startsWith("narrator")) return /^\s*$/u.test(body.slice("narrator".length));
  if (body.startsWith("npc")) {
    const after = body.slice(3);
    return after === "" || (/^\s/u.test(after) && !after.includes(">"));
  }
  return false;
}

/** 每个原生 assistant 消息独立解析；历史快照与任意大小的增量使用相同投影。 */
export function parseNarrative(
  text: string,
  playerCharacterNames: ReadonlySet<string> = new Set(),
  playerCharacterPaths: ReadonlySet<string> = new Set(),
  strict = false,
): NarrativeSegment[] {
  const segments: NarrativeSegment[] = [];
  let current: NarrativeSegment = { key: 0, text: "", ...narratorSpeaker };
  let offset = 0;
  let fence: string | undefined;
  const commit = () => {
    if (current.text.trim())
      segments.push({ ...current, text: current.text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "") });
  };
  for (const line of text.split(/(?<=\n)/u)) {
    const value = line.trimEnd();
    const complete = line.endsWith("\n");
    const speaker = fence ? undefined : readMarker(value);
    if (speaker) {
      // 标签行要等换行，避免末尾尚未传完时误切换。
      if (!complete && !strict) break;
      if (strict && /^<message\s+npc/u.test(value) && speaker.kind !== "npc")
        throw new Error("NPC 标签必须提供有效的角色文档 path，可选 name 为公开称呼");
      commit();
      const visibleSpeaker =
        speaker.kind === "npc" &&
        (playerCharacterNames.has(speaker.name) || playerCharacterPaths.has(speaker.path!))
          ? narratorSpeaker
          : speaker;
      current = { key: offset, text: "", ...visibleSpeaker };
    } else if (!fence && !complete && isPendingMarker(value)) {
      // 跨 token 的标签头暂存；停止或断线也不暴露半截协议。
      if (strict) throw new Error("说话人标签不完整");
      break;
    } else {
      if (!fence && strict && /^<\/?message(?:\s|>|$)/u.test(value))
        throw new Error("说话人标签格式错误");
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(value);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1];
        else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length)
          fence = undefined;
      }
      current.text += line;
    }
    offset += line.length;
  }
  commit();
  return segments;
}
