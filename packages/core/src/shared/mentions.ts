import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";

import { identityIdSchema } from "./identity";

/** 主持消息使用的固定身份，也用于聊天中的主持点名。 */
export const HOST_MENTION_ID = "agent";

export const mentionTargetSchema = z.object({
  id: identityIdSchema,
  kind: z.enum(["host", "player", "companion"]),
  nickname: z.string(),
  characterId: z.string().optional(),
  characterName: z.string().optional(),
  label: z.string(),
  path: z.string().optional(),
  image: z.string().optional(),
  avatar: z.string().optional(),
});
export type MentionTarget = z.infer<typeof mentionTargetSchema>;
export const mentionReplyLimitSchema = z.number().int().min(1).max(32);

export const mentionsSchema = z
  .array(z.object({ id: identityIdSchema, label: z.string() }))
  .max(256);
export type Mention = z.infer<typeof mentionsSchema>[number];
export type MentionRef = { id: string };
interface MentionNode {
  type: string;
  url?: string;
  children?: MentionNode[];
}

/** 所有发言共用身份链接；代码、引用、图片及普通 @文字均不建立点名。 */
export function parseMentionRefs(text: string): MentionRef[] {
  const ids = new Set<string>();
  const visit = (node: MentionNode) => {
    if (["blockquote", "code", "inlineCode", "html", "image"].includes(node.type)) return;
    if (node.type === "link" && node.url?.startsWith("#mention/")) {
      const id = node.url.slice(9);
      if (identityIdSchema.safeParse(id).success && ids.size < 256) ids.add(id);
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(text));
  return [...ids].map((id) => ({ id }));
}

/** 主机按当前候选确认 ID，并保存接收时名称；不信任链接显示文字。 */
export function resolveMentionRefs(value: unknown, targets: readonly MentionTarget[]): Mention[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map(targets.map((target) => [target.id, target]));
  const result = new Map<string, Mention>();
  for (const ref of value) {
    if (!ref || typeof ref.id !== "string") continue;
    const target = byId.get(ref.id);
    if (target) result.set(target.id, { id: target.id, label: target.label });
  }
  return [...result.values()];
}
