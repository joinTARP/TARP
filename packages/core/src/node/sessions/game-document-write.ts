import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { Character } from "@jointarp/module/character";
import { hasComputedFields } from "@jointarp/module/computed-fields";
import {
  resolveDocumentComputations,
  documentSourceValues,
} from "@jointarp/module/document-computations";
import {
  resolveModuleDocuments,
  type ParsedModuleDocument,
} from "@jointarp/module/document-evaluator";
import { documentFormat, documentIdentity } from "@jointarp/module/document-path";
import type { DocumentType } from "@jointarp/module/document-type";
import {
  assertInstanceChanges,
  instancePointerType,
  validateInstanceBindings,
} from "@jointarp/module/instance-state";
import { stringifyDocumentContent } from "@jointarp/module/node/document-codec";
import {
  parseGameDocumentContent as parseContent,
  validateGameDocumentReferences,
} from "@jointarp/module/node/game-state-validation";

import { assertRoomOverlayAdmission } from "../game/room-state-projection";
import { createIdentityId } from "../identity";
import type { SessionDatabase } from "../storage/session-database";
import { stageFileAtomic } from "../storage/write-file-atomic";
import { readAdventureState, updateAdventureState } from "./adventure-state";
import { assertGameWritable } from "./adventure-status";
import { storedTypes } from "./character-db";
import { stageDocumentReferences } from "./document-reference-store";
import { applyGameDocumentPatch, type GameDocumentPatch } from "./game-document-patch";
import { normalizeGamePath, newGameDocumentPath } from "./game-document-path";
import {
  checkedRoot,
  typeFromPath,
  gameInstanceResolver,
  documentTitle,
  recordForPath,
  verifyCurrent,
  readReferenceDocuments,
} from "./game-document-source";
import { readGameDocumentSnapshot, forgetGameDocumentViews } from "./game-document-views";
import { gamePathId, listGameFileRecords, type GameFileRecord } from "./game-file-index";
import { readOverlayDocument, encodeOverlay } from "./game-overlay";
import { assertMutablePointer, applyPointer } from "./game-pointers";
import { withStateLock } from "./state-lock";
import { bumpFileRevisions } from "./state-version";

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function syncCharacterIndex(db: SessionDatabase, record: GameFileRecord, type: DocumentType): void {
  if (type.designation !== "character") return;
  updateAdventureState(db, (state) => {
    const index = state.party.characters.findIndex((item) => item.id === record.id);
    const previous = state.party.characters[index];
    const character = {
      id: record.id,
      typeId: record.typeId,
      sourcePath: record.path,
      playerId: previous?.playerId ?? null,
      retired: previous?.retired ?? false,
    };
    if (index < 0) state.party.characters.push(character);
    else state.party.characters[index] = character;
  });
}

async function stageGameFile(rootPath: string, path: string, source: string, create: boolean) {
  const root = await checkedRoot(rootPath);
  const parent = join(root, dirname(path));
  if (!inside(root, parent)) throw new Error("路径超出游戏工作区");
  await mkdir(parent, { recursive: true });
  if ((await realpath(parent)) !== parent) throw new Error("游戏工作区不允许符号链接");
  const target = join(root, path);
  if (create) {
    try {
      await lstat(target);
      throw new Error("游戏文件已存在但未登记，拒绝覆盖");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return stageFileAtomic(target, source, { mode: 0o600 });
}

interface GameDocumentWrite {
  path: string;
  documentId?: string;
  content: Record<string, unknown>;
  create: boolean;
}

/** 同一批次先按最终文档集合校验和暂存，再依次发布；不提供跨文件回滚。 */
async function commitFiles(
  db: SessionDatabase,
  root: string,
  writes: readonly GameDocumentWrite[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  assertGameWritable(db);
  const types = storedTypes(db);
  const records = listGameFileRecords(db);
  const characterIds = new Set(readAdventureState(db).party.characters.map((c) => c.id));
  const identities = new Set(records.map((record) => documentIdentity(record.path)));
  const seen = new Set<string>();
  const prepared = writes.map((write) => {
    const existing = recordForPath(db, write.path);
    const path = write.create
      ? newGameDocumentPath(write.path, types)
      : (existing?.path ?? normalizeGamePath(write.path));
    const identity = documentIdentity(path);
    if (seen.has(identity)) throw new Error(`同一批次不能重复修改同一文档：${path}`);
    seen.add(identity);
    const type = typeFromPath(path, types);
    if (write.create && existing) throw new Error(`游戏文档已存在：${path}`);
    if (write.create && identities.has(identity))
      throw new Error(`同名游戏文档已存在，不能通过另一种格式重复创建：${path}`);
    if (!write.create && !existing) throw new Error(`游戏文档不存在：${path}`);
    const source = stringifyDocumentContent(write.content, path);
    const parsed = parseContent(type, source, path);
    const { name, description, image, avatar, body, computed, ...values } = parsed;
    const record: GameFileRecord = existing
      ? { ...existing, revision: existing.revision + 1 }
      : {
          id:
            write.documentId ??
            (type.designation === "character" ? createIdentityId(characterIds) : gamePathId(path)),
          path,
          typeId: type.id,
          contentType: documentFormat(path),
          revision: 1,
        };
    if (type.designation === "character") characterIds.add(record.id);
    if (write.create) {
      identities.add(identity);
      records.push(record);
    }
    const candidate: ParsedModuleDocument = {
      identity: documentIdentity(path),
      documentType: type,
      values,
      computed,
      document: {
        path,
        docType: type.id,
        contentType: documentFormat(path),
        title: documentTitle(name, path),
        description: typeof description === "string" ? description : undefined,
        image: typeof image === "string" ? image : undefined,
        avatar: typeof avatar === "string" ? avatar : undefined,
        body: typeof body === "string" ? body : undefined,
        valid: true,
      },
    };
    return {
      path,
      type,
      parsed,
      source,
      record,
      candidate,
      create: write.create,
      encoded: encodeOverlay(root, path, type, parsed),
    };
  });
  const candidates = new Map(prepared.map((item) => [item.candidate.identity, item.candidate]));
  const resolveInstance = gameInstanceResolver(db, root, candidates);
  for (const item of prepared) {
    validateInstanceBindings(item.type.fields, item.parsed, resolveInstance);
    if (!item.create) {
      const previous = parseContent(
        item.type,
        readOverlayDocument(root, item.path, item.type),
        item.path,
      );
      assertInstanceChanges(item.type.fields, previous, item.parsed, resolveInstance);
    }
    validateGameDocumentReferences(
      item.type,
      item.parsed,
      records.map((record) => ({ path: record.path, docType: record.typeId })),
    );
    if (hasComputedFields(item.type, item.candidate.computed)) {
      const items = await readReferenceDocuments(db, root, item.candidate, candidates);
      const resolved = await resolveModuleDocuments([...items, item.candidate], {
        view: "public",
        strictComputations: true,
        identities: new Set([item.candidate.identity]),
      });
      const checked = resolved[resolved.length - 1]!;
      if (!checked.valid) throw new Error(`${item.path}：${checked.error ?? "候选文档计算失败"}`);
    }
    signal?.throwIfAborted();
  }
  await assertRoomOverlayAdmission(db, new Map(prepared.map((item) => [item.path, item.source])));
  signal?.throwIfAborted();
  await readGameDocumentSnapshot(db, root);
  signal?.throwIfAborted();
  const staged: Awaited<ReturnType<typeof stageGameFile>>[] = [];
  let references: Awaited<ReturnType<typeof stageDocumentReferences>> | undefined;
  const published: typeof prepared = [];
  const syncPublished = (items: typeof prepared) => {
    bumpFileRevisions(
      db,
      items.map((item) => ({ path: item.path, created: item.create })),
    );
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        syncCharacterIndex(db, item.record, item.type);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };
  try {
    for (const item of prepared) {
      staged.push(await stageGameFile(root, item.path, item.encoded, item.create));
      signal?.throwIfAborted();
    }
    references = await stageDocumentReferences(db, [...candidates.values()], resolveInstance);
    signal?.throwIfAborted();
    // 开始发布后不因用户取消主动中断；文件系统错误仍可能造成部分成功。
    for (let index = 0; index < prepared.length; index++) {
      await staged[index]!.publish();
      published.push(prepared[index]!);
    }
    await references.publish();
  } catch (error) {
    for (const file of staged) await file.discard();
    await references?.discard();
    if (published.length) {
      forgetGameDocumentViews(root);
      const syncErrors = syncPublished(published);
      const savedPaths = published.map((item) => item.path);
      const pendingPaths = prepared.slice(published.length).map((item) => item.path);
      throw new Error(
        `游戏文档已保存，但${pendingPaths.length ? "批次发布失败" : "文档依赖索引保存失败"}；` +
          `已保存：${JSON.stringify(savedPaths)}；未保存：${JSON.stringify(pendingPaths)}。` +
          (syncErrors.length ? "关联房间状态同步也失败。" : "") +
          "没有跨文件回滚；重新读取时将按原始文档修复索引，请先 read 核对，不能整批重复提交。",
        { cause: syncErrors.length ? new AggregateError([error, ...syncErrors]) : error },
      );
    }
    throw error;
  }
  const syncErrors = syncPublished(prepared);
  if (syncErrors.length) {
    throw new Error(
      `游戏文档全部已保存，但关联房间状态同步失败；请先 read 核对，不能重复结算。已保存：${JSON.stringify(prepared.map((item) => item.path))}`,
      { cause: new AggregateError(syncErrors) },
    );
  }
  return prepared.map((item) => ({
    id: item.record.id,
    path: item.path,
    revision: item.record.revision,
    content: item.parsed,
  }));
}

async function commitFile(
  args: GameDocumentWrite & {
    db: SessionDatabase;
    root: string;
    signal?: AbortSignal;
  },
) {
  return (await commitFiles(args.db, args.root, [args], args.signal))[0]!;
}

export async function writeGameDocument(
  db: SessionDatabase,
  root: string,
  input: {
    signal?: AbortSignal;
    path: string;
    content: Record<string, unknown>;
    documentId?: string;
  },
) {
  return withStateLock(root, () => commitFile({ db, root, ...input, create: true }));
}

export interface GameDocumentUpdate {
  path: string;
  patch: GameDocumentPatch;
}

export function batchUpdateGameDocuments(
  db: SessionDatabase,
  root: string,
  input: { updates: readonly GameDocumentUpdate[]; signal?: AbortSignal },
) {
  return withStateLock(root, async () => {
    input.signal?.throwIfAborted();
    if (!input.updates.length || input.updates.length > 50)
      throw new Error("一次批量提交须包含 1 到 50 个文档更新");
    const writes: GameDocumentWrite[] = [];
    for (const update of input.updates) {
      const record = recordForPath(db, update.path);
      if (!record) throw new Error(`游戏文档不存在：${update.path}`);
      const path = record.path;
      const type = typeFromPath(path, storedTypes(db));
      const content = parseContent(type, await verifyCurrent(db, root, record), path);
      writes.push({
        path,
        content: applyGameDocumentPatch(
          type,
          content,
          update.patch,
          gameInstanceResolver(db, root),
        ),
        create: false,
      });
    }
    return commitFiles(db, root, writes, input.signal);
  });
}

export async function patchGameDocument(
  db: SessionDatabase,
  root: string,
  input: { path: string; patch: GameDocumentPatch; signal?: AbortSignal },
) {
  return (
    await batchUpdateGameDocuments(db, root, {
      signal: input.signal,
      updates: [{ path: input.path, patch: input.patch }],
    })
  )[0]!;
}

async function updateGameDocumentUnlocked(
  db: SessionDatabase,
  root: string,
  input: {
    signal?: AbortSignal;
    path: string;
    changes: readonly { op: "set" | "remove"; path: string; value?: unknown }[];
    publicOnly?: boolean;
  },
) {
  input.signal?.throwIfAborted();
  const record = recordForPath(db, input.path);
  if (!record) throw new Error("游戏文档不存在");
  const path = record.path;
  const type = typeFromPath(path, storedTypes(db));
  const source = await verifyCurrent(db, root, record);
  const content = parseContent(type, source, path);
  const before = structuredClone(content);
  const resolveInstance = gameInstanceResolver(db, root);
  for (const change of input.changes) {
    assertMutablePointer(
      instancePointerType(type, content, change.path, resolveInstance),
      change.path,
      input.publicOnly ?? false,
      change.op,
    );
    applyPointer(content, change.path, change.op, change.value);
  }
  assertInstanceChanges(type.fields, before, content, resolveInstance, input.publicOnly ?? false);
  return commitFile({
    db,
    root,
    ...input,
    path,
    content,
    create: false,
  });
}

export async function materializeCharacter(
  db: SessionDatabase,
  root: string,
  character: Character,
): Promise<void> {
  if (character.sourcePath) return;
  const path = `${character.typeId}/${character.id}.json`;
  const type = storedTypes(db).find((candidate) => candidate.id === character.typeId);
  if (!type) throw new Error("角色文档类型不存在");
  const metadata: Record<string, unknown> = {
    name: character.name,
    ...(character.description ? { description: character.description } : {}),
    ...(character.body ? { body: character.body } : {}),
  };
  // 草稿的展示标题不写回计算字段；实际来源由普通字段保存。
  for (const field of resolveDocumentComputations(type, character.computed).fields) {
    if (field.compute !== undefined) delete metadata[field.key];
  }
  await writeGameDocument(db, root, {
    documentId: character.id,
    path,
    content: { ...metadata, ...documentSourceValues(character) },
  });
}

export function updateGameDocument(
  db: SessionDatabase,
  root: string,
  input: Parameters<typeof updateGameDocumentUnlocked>[2],
  assertCurrent?: () => void | Promise<void>,
) {
  return withStateLock(root, async () => {
    // 跨文档授权条件在持有提交锁后复核，避免授权检查与提交之间状态发生变化。
    await assertCurrent?.();
    return updateGameDocumentUnlocked(db, root, input);
  });
}
