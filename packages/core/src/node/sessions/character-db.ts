import { basename } from "node:path";

import type { Character } from "@tarp/module/character";
import { documentIdentity } from "@tarp/module/document-path";
import {
  documentMetadataSchema,
  validateDocumentValues,
  type DocumentType,
} from "@tarp/module/document-type";
import { parseDocumentContent } from "@tarp/module/node/document-codec";

import { createIdentityId } from "../identity";
import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState, updateAdventureState } from "./adventure-state";
import { frozenModule } from "./frozen-module";
import { readOverlayDocument } from "./game-overlay";
import { readLaunchConfig, readLaunchProgress, readLaunchRoom } from "./launch-db";
import { gameDirectoryForDatabase } from "./session-paths";
import { fileRevision } from "./state-version";

export function storedTypes(db: SessionDatabase): DocumentType[] {
  // 类型加载时已经规范化；保留数组副本，允许调用方排序而不改变冻结资料顺序。
  return [...frozenModule(db).types];
}
export function readCharacters(db: SessionDatabase): Character[] {
  const types = storedTypes(db);
  const gameRoot = gameDirectoryForDatabase(db);
  return readAdventureState(db).party.characters.map((entry) => {
    const identity = {
      id: entry.id,
      typeId: entry.typeId,
      playerId: entry.playerId,
      sourcePath: entry.sourcePath,
      retired: entry.retired,
    };
    if (entry.sourcePath === null)
      return {
        ...identity,
        ...entry.draft,
        body: entry.draft.body ?? "",
        values: structuredClone(entry.draft.values),
        version: 1,
      };
    const sourcePath = entry.sourcePath;
    const type = types.find((candidate) => candidate.id === entry.typeId);
    if (!type || type.designation !== "character") throw new Error("角色文档类型不存在");
    const file = documentMetadataSchema.parse(
      parseDocumentContent(readOverlayDocument(gameRoot, sourcePath, type), sourcePath),
    );
    validateDocumentValues(type, file);
    const { name, description, body, image: _image, avatar: _avatar, computed, ...values } = file;
    return {
      ...identity,
      name: name ?? basename(documentIdentity(sourcePath)),
      description: description ?? "",
      body: body ?? "",
      values,
      computed,
      version: fileRevision(db, sourcePath),
    };
  });
}
/** 在调用方事务中执行；只识别明确的 designation，不猜测类型名称。 */
export function initializeCharacters(db: SessionDatabase): void {
  const types = storedTypes(db);
  updateAdventureState(db, (selection) => {
    for (const document of frozenModule(db).documents) {
      const type = types.find((t) => t.id === document.docType && t.designation === "character");
      if (!type) continue;
      if (!selection.party.characters.some((character) => character.sourcePath === document.path))
        selection.party.characters.push({
          id: createIdentityId(selection.party.characters.map((character) => character.id)),
          typeId: type.id,
          playerId: null,
          sourcePath: document.path,
          retired: false,
        });
    }
  });
}

export function assertPlayerReady(db: SessionDatabase, playerId: string): void {
  if (!readLaunchConfig(db)) return;
  if (!readLaunchProgress(db, playerId).confirmed || readLaunchRoom(db).opening !== "complete")
    throw new Error("请先确认角色并完成开场");
}
