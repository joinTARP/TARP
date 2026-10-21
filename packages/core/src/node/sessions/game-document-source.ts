import { lstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";

import { resolveDocumentComputations } from "@tarp/module/document-computations";
import type { ParsedModuleDocument } from "@tarp/module/document-evaluator";
import { documentFormat, documentIdentity, documentTypeId } from "@tarp/module/document-path";
import type { DocumentType } from "@tarp/module/document-type";
import type { InstanceResolver } from "@tarp/module/instance-state";
import { parseGameDocumentContent as parseContent } from "@tarp/module/node/game-state-validation";

import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState } from "./adventure-state";
import { storedTypes } from "./character-db";
import { readDocumentReferences } from "./document-reference-store";
import { frozenModule } from "./frozen-module";
import { resolveGameDocumentPath } from "./game-document-path";
import {
  gamePathId,
  recognizedType,
  listGameFileRecords,
  type GameFileRecord,
} from "./game-file-index";
import { overlayPath, readOverlayDocument, layerPath, moduleRoot } from "./game-overlay";
import { gameDirectoryForDatabase } from "./session-paths";
import { fileRevision } from "./state-version";

export async function checkedRoot(root: string): Promise<string> {
  const actual = await realpath(root);
  const stat = await lstat(actual);
  if (!stat.isDirectory()) throw new Error("无效的游戏工作区");
  return actual;
}

export function typeFromPath(path: string, types: readonly DocumentType[]): DocumentType {
  const id = documentTypeId(path);
  if (!id || !/\.(json|toml|md)$/iu.test(path))
    throw new Error("游戏文档须使用 类型/分组/名称.json、.toml 或 .md");
  const type = types.find((candidate) => candidate.id === id);
  if (!type) throw new Error(`未注册的文档类型：${id}`);
  return type;
}

export function gameInstanceResolver(
  db: SessionDatabase,
  root: string,
  candidates: ReadonlyMap<string, ParsedModuleDocument> = new Map(),
): InstanceResolver {
  return (reference) => {
    const candidate = candidates.get(documentIdentity(reference));
    if (candidate) return candidate;
    const record = recordForPath(db, reference);
    if (!record) return null;
    const type = typeFromPath(record.path, storedTypes(db));
    return {
      documentType: type,
      values: parseContent(type, readOverlayDocument(root, record.path, type), record.path),
    };
  };
}

export function documentTitle(name: unknown, path: string): string {
  return typeof name === "string" && name.trim() ? name : basename(documentIdentity(path));
}

export function recordForPath(db: SessionDatabase, path: string): GameFileRecord | undefined {
  const root = gameDirectoryForDatabase(db);
  const resolved = resolveGameDocumentPath(root, path, storedTypes(db));
  if (!resolved) return undefined;
  path = resolved;
  let target: string;
  try {
    target = overlayPath(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!lstatSync(target).isFile()) return undefined;
  const type = recognizedType(path, storedTypes(db));
  if (!type) return undefined;
  const character = readAdventureState(db).party.characters.find(
    (item) => item.sourcePath === path,
  );
  return {
    id: character ? character.id : gamePathId(path),
    path,
    typeId: type.id,
    contentType: documentFormat(path),
    revision: fileRevision(db, path),
  };
}

export async function verifyCurrent(
  db: SessionDatabase,
  root: string,
  record: GameFileRecord,
): Promise<string> {
  return readOverlayDocument(root, record.path, typeFromPath(record.path, storedTypes(db)));
}

/** 读取并校验当前文件；调用方可在同一份原始快照上覆盖角色，再统一计算。 */
export async function readGameDocuments(
  db: SessionDatabase,
  root: string,
  paths?: ReadonlySet<string>,
  baseline = false,
): Promise<readonly ParsedModuleDocument[]> {
  const types = storedTypes(db);
  const records = baseline
    ? frozenModule(db)
        .documents.filter((document) => document.docType && document.contentType)
        .map((document) => ({
          id: gamePathId(document.path),
          path: document.path,
          typeId: document.docType!,
          contentType: document.contentType!,
          revision: 1,
        }))
    : listGameFileRecords(db);
  return Promise.all(
    records
      .filter(
        (record) =>
          (!paths || paths.has(record.path)) &&
          (!baseline || layerPath(moduleRoot(root), record.path)),
      )
      .map(async (record) => {
        const source = baseline
          ? await readFile(layerPath(moduleRoot(root), record.path)!, "utf8")
          : await verifyCurrent(db, root, record);
        const type = types.find((candidate) => candidate.id === record.typeId);
        if (!type) throw new Error(`游戏文档类型不存在：${record.typeId}`);
        const content = parseContent(type, source, record.path);
        const { name, description, image, avatar, body, computed, ...values } = content;
        return {
          identity: documentIdentity(record.path),
          documentType: type,
          values,
          computed,
          document: {
            path: record.path,
            id: record.id,
            revision: baseline ? 1 : record.revision,
            title: documentTitle(name, record.path),
            docType: record.typeId,
            contentType: record.contentType,
            description: typeof description === "string" ? description : undefined,
            image: typeof image === "string" ? image : undefined,
            avatar: typeof avatar === "string" ? avatar : undefined,
            body: typeof body === "string" ? body : undefined,
            valid: true,
          },
        };
      }),
  );
}

/** 读取传递引用的原始快照；只遍历声明且类型匹配的引用，候选根覆盖自身旧版本。 */
export async function readReferenceDocuments(
  db: SessionDatabase,
  root: string,
  target: ParsedModuleDocument,
  candidates: ReadonlyMap<string, ParsedModuleDocument> = new Map(),
): Promise<ParsedModuleDocument[]> {
  const index = new Map(
    listGameFileRecords(db).map((record) => [documentIdentity(record.path), record]),
  );
  const visited = new Set([target.identity]);
  const result: ParsedModuleDocument[] = [];
  let frontier = [target];
  while (frontier.length) {
    const paths = new Set<string>();
    const pending: ParsedModuleDocument[] = [];
    for (const owner of frontier) {
      for (const [reference, types] of readDocumentReferences(
        db,
        owner,
        gameInstanceResolver(db, root, candidates),
      )) {
        const identity = documentIdentity(reference);
        const candidate = candidates.get(identity);
        if (candidate && !visited.has(identity) && types.has(candidate.documentType.id)) {
          visited.add(identity);
          pending.push(candidate);
          continue;
        }
        const record = index.get(identity);
        if (visited.has(identity) || !record || !types.has(record.typeId)) continue;
        visited.add(identity);
        paths.add(record.path);
      }
    }
    if (!paths.size && !pending.length) break;
    frontier = [...pending, ...(await readGameDocuments(db, root, paths))];
    result.push(...frontier);
  }
  return result;
}

/** 读取登记文件的原始正文；仅供主进程状态投影与初始化使用。 */
export async function readStateDocument(db: SessionDatabase, root: string, path: string) {
  const record = recordForPath(db, path);
  if (!record) throw new Error("状态文档不存在");
  const type = typeFromPath(record.path, storedTypes(db));
  const content = parseContent(type, await verifyCurrent(db, root, record), record.path);
  return {
    ...record,
    type: resolveDocumentComputations(type, content.computed),
    content,
  };
}
