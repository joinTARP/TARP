import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";

import type { ReferenceDocument } from "./DocumentReferences";
import type { ReferenceCollectionRow } from "./reference-collection";

/** 搜索针对集合的所有候选引用，不能先按原始名称筛选后再计算。 */
export function roomCollectionCandidates(
  rows: readonly ReferenceCollectionRow[],
  documents?: ReadonlyMap<string, ReferenceDocument>,
): ModuleDocument[] {
  const selected = new Map<string, ModuleDocument>();
  for (const row of rows) {
    const identity = row.reference ? documentIdentity(row.reference) : undefined;
    const document = identity ? documents?.get(identity) : undefined;
    if (identity && document)
      selected.set(identity, { ...document, valid: document.valid ?? true } as ModuleDocument);
  }
  return [...selected.values()];
}

/** 名称和缩略图来自同版计算结果；等待或失效时不能从索引补回真名。 */
export function computedCollectionRows(
  rows: readonly ReferenceCollectionRow[],
  documents: readonly ModuleDocument[],
): ReferenceCollectionRow[] {
  const current = new Map(documents.map((document) => [documentIdentity(document.path), document]));
  return rows.flatMap((row) => {
    if (!row.reference) return [row];
    const document = current.get(documentIdentity(row.reference));
    if (!document || document.visible === false) return [];
    return [
      {
        ...row,
        title: document?.valid ? document.title : "资料暂不可用",
        image: document?.valid ? document.image : undefined,
        path: document?.path,
        unavailable: !document?.valid,
      },
    ];
  });
}
