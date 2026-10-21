import type { ModuleDocument } from "@shared/desktop-api";
import type { Character } from "@tarp/module/character";

/** 内容修改仍属于同一草稿；房间、角色类型或来源切换则不能借用旧预览。 */
export function roomDraftIdentity(roomId: string, draft: Character): string {
  return JSON.stringify([roomId, draft.id, draft.typeId, draft.playerId, draft.sourcePath]);
}

/** 原始草稿可能包含受公式隐藏的名称与背景，计算成功前只展示安全占位。 */
export function computedDraftView(draft: Character, document?: ModuleDocument): Character {
  const computed = document?.valid ? document : undefined;
  return {
    ...draft,
    name: computed?.title ?? "正在计算…",
    description: computed?.description ?? "",
    body: computed?.body,
    values: computed?.values ?? {},
    image: computed?.image,
    avatar: computed?.avatar,
    fieldErrors: computed?.fieldErrors,
    displayValues: computed?.displayValues,
    displayErrors: computed?.displayErrors,
  };
}
