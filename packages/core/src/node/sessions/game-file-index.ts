import { createHash } from "node:crypto";

import { documentFormat, documentIdentity, documentTypeId } from "@jointarp/module/document-path";
import type { DocumentType } from "@jointarp/module/document-type";

import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState } from "./adventure-state";
import { storedTypes } from "./character-db";
import { overlayEntries } from "./game-overlay";
import { gameDirectoryForDatabase } from "./session-paths";
import { fileRevision } from "./state-version";

export interface GameFileRecord {
  id: string;
  path: string;
  typeId: string;
  contentType: "json" | "toml" | "markdown";
  revision: number;
}

/** 对外 ID 不暴露可能包含幕后信息的文件名；它不用于校验文件内容。 */
export function gamePathId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 32);
}

export function recognizedType(
  path: string,
  types: readonly DocumentType[],
): DocumentType | undefined {
  if (!/\.(json|toml|md)$/iu.test(path)) return undefined;
  const id = documentTypeId(path);
  return types.find((candidate) => candidate.id === id);
}

function fileRecord(
  path: string,
  type: DocumentType,
  characterIds: ReadonlyMap<string, string>,
  db: SessionDatabase,
): GameFileRecord {
  return {
    id: characterIds.get(path) ?? gamePathId(path),
    path,
    typeId: type.id,
    contentType: documentFormat(path),
    revision: fileRevision(db, path),
  };
}

/** 文档路径由目录本身提供；ID 只对已绑定角色保留独立身份。 */
export function listGameFileRecords(db: SessionDatabase): GameFileRecord[] {
  const root = gameDirectoryForDatabase(db);
  const types = storedTypes(db);
  const characterIds = new Map(
    readAdventureState(db)
      .party.characters.filter((c) => c.sourcePath)
      .map((c) => [c.sourcePath!, c.id]),
  );
  const records: GameFileRecord[] = [];
  const walk = (prefix: string): void => {
    for (const entry of overlayEntries(root, prefix)) {
      if (entry.isSymbolicLink() || entry.name.endsWith(".tmp")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const type = recognizedType(path, types);
        if (type) records.push(fileRecord(path, type, characterIds, db));
      }
    }
  };
  walk("");
  const identities = new Set<string>();
  for (const record of records) {
    const identity = documentIdentity(record.path);
    if (identities.has(identity)) throw new Error(`同名文档格式冲突：${identity}`);
    identities.add(identity);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
