import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DocumentData } from "@jointarp/module/document-computations";
import {
  collectReferences,
  type DeclaredReferences,
  type DocumentReferenceIndex,
} from "@jointarp/module/document-references";
import type { DocumentType } from "@jointarp/module/document-type";
import { hasInstanceBindings, type InstanceResolver } from "@jointarp/module/instance-state";
import { z } from "zod";

import type { SessionDatabase } from "../storage/session-database";
import { stageFileAtomic, writeFileAtomic } from "../storage/write-file-atomic";
import { roomDirectoryForDatabase } from "./session-paths";

interface ReferenceDocument extends DocumentData {
  readonly identity: string;
  readonly documentType: DocumentType;
}
interface ReferenceEntry {
  readonly fingerprint: string;
  readonly references: DeclaredReferences;
}
interface ReferenceStore {
  readonly documents: ReadonlyMap<string, ReferenceEntry>;
  readonly needsRebuild: boolean;
}

const stores = new Map<string, ReferenceStore>();
const indexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documents: z.record(
    z.string(),
    z.strictObject({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      references: z.record(z.string(), z.array(z.string())),
    }),
  ),
});

function indexPath(directory: string): string {
  return join(directory, "document-references.json");
}

/** 缺失索引可重建；已有目录、符号链接或特殊文件不能作为索引覆盖。 */
function indexExists(directory: string): boolean {
  try {
    const stat = lstatSync(indexPath(directory));
    if (!stat.isFile()) throw new Error("文档依赖索引必须为普通文件");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function load(directory: string): ReferenceStore {
  if (!indexExists(directory)) return { documents: new Map(), needsRebuild: true };
  const source = readFileSync(indexPath(directory), "utf8");
  try {
    const index = indexSchema.parse(JSON.parse(source));
    return {
      documents: new Map(
        Object.entries(index.documents).map(([identity, entry]) => [
          identity,
          {
            fingerprint: entry.fingerprint,
            references: new Map(
              Object.entries(entry.references).map(([reference, targets]) => [
                reference,
                new Set(targets),
              ]),
            ),
          },
        ]),
      ),
      needsRebuild: false,
    };
  } catch {
    // 这是可重建的派生索引；格式损坏时由完整原始快照重新建立。
    return { documents: new Map(), needsRebuild: true };
  }
}

function store(directory: string): ReferenceStore {
  let current = stores.get(directory);
  if (!current) stores.set(directory, (current = load(directory)));
  return current;
}

function fingerprint(document: ReferenceDocument): string {
  return createHash("sha256")
    .update(JSON.stringify([3, document.documentType, document.computed, document.values]))
    .digest("hex");
}

function sameReferences(a: DeclaredReferences, b: DeclaredReferences): boolean {
  if (a.size !== b.size) return false;
  for (const [reference, targets] of a) {
    const other = b.get(reference);
    if (!other || targets.size !== other.size) return false;
    for (const target of targets) if (!other.has(target)) return false;
  }
  return true;
}

function encode(documents: ReadonlyMap<string, ReferenceEntry>): string {
  const entries = [...documents].sort(([a], [b]) => a.localeCompare(b));
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      documents: Object.fromEntries(
        entries.map(([identity, entry]) => [
          identity,
          {
            fingerprint: entry.fingerprint,
            references: Object.fromEntries(
              [...entry.references]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([reference, targets]) => [reference, [...targets].sort()]),
            ),
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`;
}

export function forgetDocumentReferences(directory: string): void {
  stores.delete(directory);
}

/** 候选校验和权威读取复用匹配的声明；尚未提交的候选不修改索引。 */
export function readDocumentReferences(
  db: SessionDatabase,
  document: ReferenceDocument,
  resolveInstance?: InstanceResolver,
): DeclaredReferences {
  if (resolveInstance && hasInstanceBindings(document.documentType.fields))
    return collectReferences(document.documentType.fields, document.values, resolveInstance);
  const entry = store(roomDirectoryForDatabase(db)).documents.get(document.identity);
  return entry?.fingerprint === fingerprint(document)
    ? entry.references
    : collectReferences(document.documentType.fields, document.values, resolveInstance);
}

/** 先暂存候选图，文档发布成功后再发布索引；关系不变只更新内存指纹。 */
export async function stageDocumentReferences(
  db: SessionDatabase,
  candidates: readonly ReferenceDocument[],
  resolveInstance?: InstanceResolver,
) {
  const directory = roomDirectoryForDatabase(db);
  const exists = indexExists(directory);
  const current = store(directory);
  const documents = new Map(current.documents);
  let changed = !exists || current.needsRebuild;
  for (const document of candidates) {
    const references = collectReferences(
      document.documentType.fields,
      document.values,
      resolveInstance,
    );
    const previous = documents.get(document.identity);
    documents.set(document.identity, { fingerprint: fingerprint(document), references });
    if (!previous || !sameReferences(previous.references, references)) changed = true;
  }
  const staged = changed
    ? await stageFileAtomic(indexPath(directory), encode(documents), { mode: 0o600 })
    : undefined;
  return {
    async publish(): Promise<void> {
      await staged?.publish();
      stores.set(directory, { documents, needsRebuild: false });
    },
    async discard(): Promise<void> {
      await staged?.discard();
    },
  };
}

/** 完整恢复核对指纹并修复索引；增量恢复仅在关系或节点变化时落盘。 */
export async function restoreDocumentReferences(
  db: SessionDatabase,
  records: readonly ReferenceDocument[],
  {
    complete = false,
    removed = [],
    resolveInstance,
  }: { complete?: boolean; removed?: readonly string[]; resolveInstance?: InstanceResolver } = {},
): Promise<DocumentReferenceIndex> {
  const directory = roomDirectoryForDatabase(db);
  const current = complete ? load(directory) : store(directory);
  const documents = new Map(current.documents);
  const references = new Map<string, DeclaredReferences>();
  let changed = current.needsRebuild;
  for (const document of records) {
    const digest = fingerprint(document);
    const previous = documents.get(document.identity);
    const declared =
      previous?.fingerprint === digest &&
      !(resolveInstance && hasInstanceBindings(document.documentType.fields))
        ? previous.references
        : collectReferences(document.documentType.fields, document.values, resolveInstance);
    if (
      !previous ||
      !sameReferences(previous.references, declared) ||
      (complete && previous.fingerprint !== digest)
    )
      changed = true;
    documents.set(document.identity, { fingerprint: digest, references: declared });
    references.set(document.identity, declared);
  }
  const deleted = new Set(removed);
  if (complete)
    for (const identity of documents.keys()) if (!references.has(identity)) deleted.add(identity);
  for (const identity of deleted) if (documents.delete(identity)) changed = true;
  if (changed) {
    indexExists(directory);
    await writeFileAtomic(indexPath(directory), encode(documents), { mode: 0o600 });
  }
  stores.set(directory, { documents, needsRebuild: false });
  return references;
}
