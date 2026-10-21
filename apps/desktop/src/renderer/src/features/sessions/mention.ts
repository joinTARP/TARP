import { identityIdSchema } from "@jointarp/core/shared/identity";
import { z } from "zod";

/** 仅编辑器内部使用的文字和原子标签，不进入房间消息协议。 */
const draftPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("mention"), id: identityIdSchema, label: z.string() }),
]);
export const mentionDraftSchema = z.array(draftPartSchema).max(256);
export type MentionDraft = z.infer<typeof mentionDraftSchema>;
export type DraftPart = MentionDraft[number];
export function textDraft(text: string): MentionDraft {
  return text ? [{ type: "text", text }] : [];
}
export function draftText(draft: readonly DraftPart[]): string {
  return draft.map((part) => (part.type === "text" ? part.text : `@${part.label}`)).join("");
}
export function concatDrafts(...drafts: (readonly DraftPart[])[]): MentionDraft {
  const result: MentionDraft = [];
  for (const part of drafts.flat()) {
    if (part.type === "text" && !part.text) continue;
    const last = result.at(-1);
    if (last?.type === "text" && part.type === "text") last.text += part.text;
    else result.push({ ...part });
  }
  return result;
}
export function trimDraft(draft: readonly DraftPart[]): MentionDraft {
  const result = concatDrafts(draft);
  while (result[0]?.type === "text") {
    result[0].text = result[0].text.trimStart();
    if (result[0].text) break;
    result.shift();
  }
  while (result.at(-1)?.type === "text") {
    const last = result.at(-1)! as Extract<DraftPart, { type: "text" }>;
    last.text = last.text.trimEnd();
    if (last.text) break;
    result.pop();
  }
  return result;
}
export function resolveDraft(
  draft: readonly DraftPart[],
  targets: readonly MentionCandidate[],
): MentionDraft {
  const byId = new Map(targets.map((target) => [target.id, target]));
  return concatDrafts(
    draft.map((part) => {
      if (part.type === "text") return part;
      const target = byId.get(part.id);
      return target
        ? { ...part, label: target.name }
        : { type: "text" as const, text: `@${part.label}` };
    }),
  );
}
/** 身份链接同时用于呈现与主机点名解析；编辑器标签只维护草稿。 */
export function draftMarkdown(draft: readonly DraftPart[]): string {
  return draft
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[@${part.label.replace(/[\\[\]()*_`<>]/gu, (value) => (value === "<" ? "&lt;" : value === ">" ? "&gt;" : `\\${value}`))}](#mention/${part.id})`,
    )
    .join("");
}
export function draftRanges(draft: readonly DraftPart[]) {
  let offset = 0;
  return draft.map((part) => {
    const start = offset;
    offset += part.type === "text" ? part.text.length : part.label.length + 1;
    return { part, start, end: offset };
  });
}

export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly image?: string;
  readonly path?: string | null;
  readonly avatar?: string;
}

/** 光标前最近的 @ 片段。前面必须是开头或空白，避免把邮箱或已完成的提及再打开。 */
export function mentionQuery(
  body: readonly DraftPart[],
  caret: number,
): { start: number; query: string } | null {
  caret = Math.max(0, Math.min(caret, draftText(body).length));
  const range = draftRanges(body).find(
    ({ part, start, end }) => part.type === "text" && caret >= start && caret <= end,
  );
  if (!range || range.part.type !== "text") return null;
  const before = range.part.text.slice(0, Math.max(0, caret - range.start));
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: range.start + before.length - query.length - 1, query };
}

export function filterMentions(candidates: readonly MentionCandidate[], query: string) {
  const needle = query.toLocaleLowerCase();
  return candidates.filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle));
}

/** 菜单贴着光标，并留在输入框内；上方空间不够时改到光标下一行。 */
export function placeMentionMenu(
  caret: { left: number; top: number; height: number },
  menu: { width: number; height: number },
  fieldWidth: number,
  viewportTop: number,
) {
  const left = Math.min(Math.max(0, caret.left), Math.max(0, fieldWidth - menu.width));
  const above = viewportTop + caret.top - menu.height - 8 >= 8;
  return {
    left,
    top: above ? caret.top : caret.top + caret.height,
    above,
  };
}
