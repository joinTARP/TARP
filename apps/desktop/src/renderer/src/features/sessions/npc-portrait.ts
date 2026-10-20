import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";

export type NpcPortraitResolver = (path: string) => ModuleDocument | undefined;

/** 只按文档身份关联公开投影，不用称呼猜测人物。 */
export function createNpcPortraitResolver(
  documents: readonly ModuleDocument[],
): NpcPortraitResolver {
  const byPath = new Map<string, ModuleDocument | undefined>();
  for (const document of documents) {
    if (!document.valid || document.visible === false) continue;
    const path = documentIdentity(document.path);
    byPath.set(path, byPath.has(path) ? undefined : document);
  }
  return (path) => byPath.get(documentIdentity(path));
}
