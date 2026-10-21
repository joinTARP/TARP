import { dirname } from "node:path";

import { publicValues } from "@tarp/module/character";
import {
  DocumentEvaluator,
  resolveModuleDocuments,
  type ParsedModuleDocument,
} from "@tarp/module/document-evaluator";
import { documentIdentity } from "@tarp/module/document-path";
import { visibleDocumentProjection, type ModuleDocument } from "@tarp/module/module-document";
import { publicFieldErrors } from "@tarp/module/public-document-field";

import type { SessionDatabase } from "../storage/session-database";
import { storedTypes } from "./character-db";
import { restoreDocumentReferences, forgetDocumentReferences } from "./document-reference-store";
import {
  readGameDocuments,
  readReferenceDocuments,
  gameInstanceResolver,
  recordForPath,
} from "./game-document-source";
import { withStateLock } from "./state-lock";
import { documentRevision, documentDirtyPaths } from "./state-version";

/** 只投影已计算的快照，不再次执行表达式，也不向玩家暴露幕后字段或错误。 */
export function publicGameDocuments(
  db: SessionDatabase,
  documents: readonly ModuleDocument[],
  { respectVisibility = true }: { respectVisibility?: boolean } = {},
): readonly ModuleDocument[] {
  const types = storedTypes(db);
  return documents.map((document) => {
    if (respectVisibility && document.visible === false) return visibleDocumentProjection(document);
    if (!document.valid)
      return {
        path: document.path,
        docType: document.docType,
        contentType: document.contentType,
        title: "资料暂不可用",
        valid: false,
        error: "计算资料失败",
      };
    const type = types.find((candidate) => candidate.id === document.docType);
    const values =
      !type || !document.values
        ? document.values
        : publicValues(type.fields, document.values as Record<string, unknown>);
    return {
      ...document,
      values,
      fieldErrors: publicFieldErrors(type?.fields ?? [], document.fieldErrors),
    };
  });
}

export async function gameDocumentViews(
  db: SessionDatabase,
  root: string,
  debug = false,
  baseline = false,
): Promise<readonly ModuleDocument[]> {
  const items = await readGameDocuments(db, root, undefined, baseline);
  const resolved = await resolveModuleDocuments(items, { view: debug ? "source" : "public" });
  if (!debug) return publicGameDocuments(db, resolved);
  return resolved.map((document) => {
    if (!document.valid) {
      const source = items.find((item) => item.document.path === document.path);
      return { ...document, values: source?.values, visible: true };
    }
    return { ...document, visible: true };
  });
}

interface GameEvaluationSnapshot {
  revision: number;
  items: Map<string, ParsedModuleDocument>;
  evaluator: DocumentEvaluator;
}
// 同房间的多个数据库连接和权威读取共享一份计算快照。
const gameEvaluators = new Map<string, GameEvaluationSnapshot>();

export async function readGameDocumentSnapshot(
  db: SessionDatabase,
  root: string,
): Promise<readonly ParsedModuleDocument[]> {
  return withStateLock(root, async () => {
    const revision = documentRevision(db);
    let snapshot = gameEvaluators.get(root);
    if (!snapshot || revision < snapshot.revision) {
      snapshot = { revision: -1, items: new Map(), evaluator: new DocumentEvaluator() };
      gameEvaluators.set(root, snapshot);
    }
    if (snapshot.revision !== revision) {
      const dirty =
        snapshot.revision < 0 ? undefined : new Set(documentDirtyPaths(db, snapshot.revision));
      const items = await readGameDocuments(db, root, dirty);
      const removed = dirty
        ? [...dirty].filter((path) => !items.some((item) => item.document.path === path))
        : [];
      const references = await restoreDocumentReferences(db, items, {
        complete: !dirty,
        resolveInstance: gameInstanceResolver(db, root),
        removed: removed.map(documentIdentity),
      });
      if (dirty) for (const path of dirty) snapshot.items.delete(path);
      for (const item of items) snapshot.items.set(item.document.path, item);
      if (dirty) snapshot.evaluator.updateSnapshot(revision, items, removed, references);
      else snapshot.evaluator.setSnapshot(revision, items, references);
      snapshot.revision = revision;
    }
    return [...snapshot.items.values()];
  });
}
export function forgetGameDocumentViews(root: string): void {
  gameEvaluators.delete(root);
  forgetDocumentReferences(dirname(root));
}

export async function readGameDocumentView(
  db: SessionDatabase,
  root: string,
  path: string,
  debug = false,
): Promise<ModuleDocument> {
  return withStateLock(root, async () => {
    if (gameEvaluators.get(root)?.revision !== documentRevision(db))
      await readGameDocumentSnapshot(db, root);
    const record = recordForPath(db, path);
    if (!record) throw new Error(`游戏文档不存在：${path}`);
    const document = await gameEvaluators.get(root)!.evaluator.readDocument(record.path);
    if (debug) return document;
    return (await publicGameDocuments(db, [document]))[0]!;
  });
}

/** 权威工具刷新目标及引用的磁盘内容；计算缓存由本模块统一维护。 */
export async function readAuthoritativeGameDocument(
  db: SessionDatabase,
  root: string,
  path: string,
): Promise<ModuleDocument> {
  // 权威工具读取重新读取目标及其声明的引用，兼容人工编辑且不重算整库。
  const target = (await readGameDocuments(db, root, new Set([path])))[0]!;
  const referenced = await readReferenceDocuments(db, root, target);
  if (gameEvaluators.get(root)?.revision !== documentRevision(db))
    await readGameDocumentSnapshot(db, root);
  const snapshot = gameEvaluators.get(root)!;
  // 核验目标及引用的原始内容；没有变化时仍复用同版本的共享计算任务。
  // 人工编辑不经过提交版本，权威读取也必须看到磁盘上的实际值。
  const changed = [target, ...referenced].filter((item) => {
    const previous = snapshot.items.get(item.document.path);
    return (
      !previous ||
      JSON.stringify([previous.document, previous.values, previous.computed]) !==
        JSON.stringify([item.document, item.values, item.computed])
    );
  });
  if (changed.length) {
    const references = await restoreDocumentReferences(db, changed, {
      resolveInstance: gameInstanceResolver(db, root),
    });
    for (const item of changed) snapshot.items.set(item.document.path, item);
    snapshot.evaluator.updateSnapshot(snapshot.revision, changed, [], references);
  }
  return (
    await publicGameDocuments(db, [await snapshot.evaluator.readDocument(path)], {
      respectVisibility: false,
    })
  )[0]!;
}
