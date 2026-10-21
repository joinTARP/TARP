import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ORPCError } from "@orpc/server";
import { publicValues } from "@tarp/module/character";
import { documentFormat, documentIdentity, documentTypeId } from "@tarp/module/document-path";
import type { LaunchConfig } from "@tarp/module/flow";
import type { ModuleDocument } from "@tarp/module/module-document";
import { parseDocumentContent } from "@tarp/module/node/document-codec";

import type { LaunchState } from "../../shared/launch";
import {
  ROOM_MAX_ENTITIES,
  ROOM_MAX_DOCUMENT_BYTES,
  ROOM_MAX_OVERLAY_BYTES,
  type RoomEntityOverlay,
  type RoomBaseline,
  type RoomEntity,
  type RoomLaunchState,
} from "../../shared/room-state";
import { roomEntityOverlays } from "../../shared/room-state-overlay";
import { stableJson } from "../../shared/room-state-schema";
import { readCharacters, storedTypes } from "../sessions/character-db";
import { frozenModule } from "../sessions/frozen-module";
import { listGameFileRecords } from "../sessions/game-file-index";
import { readOverlayDocument } from "../sessions/game-overlay";
import { roomGeneration } from "../sessions/room-changes";
import { gameDirectoryForDatabase, roomDirectoryForDatabase } from "../sessions/session-paths";
import { documentRevision, documentDirtyPaths, fileRevision } from "../sessions/state-version";
import type { SessionDatabase } from "../storage/session-database";

/** 文档路径对应稳定身份，不依赖计算值或玩家角色身份。 */
function roomEntityId(path: string): string {
  return createHash("sha256").update(path.replaceAll("\\", "/")).digest("hex").slice(0, 32);
}

type RawDocument = RoomEntity["document"];
function rawDocument(path: string, source: string): RawDocument {
  const parsed = JSON.parse(stableJson(parseDocumentContent(source, path))) as Record<
    string,
    unknown
  >;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("原始游戏文档必须是对象");
  const { name, description, image, avatar, body, computed, ...values } = parsed;
  if (Buffer.byteLength(stableJson(parsed)) > ROOM_MAX_DOCUMENT_BYTES)
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "原始游戏文档超过 1 MiB 限制" });
  return JSON.parse(
    stableJson({
      path,
      title: typeof name === "string" ? name : documentIdentity(path).split("/").at(-1)!,
      name,
      computed,
      description,
      image,
      avatar,
      body,
      values,
      valid: true,
      docType: documentTypeId(path),
      contentType: documentFormat(path),
    }),
  ) as RawDocument;
}
function entity(document: RawDocument, revision: number): RoomEntity {
  return { id: roomEntityId(document.path), revision, document };
}
const projectionCache = new Map<
  string,
  {
    revision: number;
    stateRevision: number;
    documents: readonly ModuleDocument[];
    count: number;
    characterIds: Set<string>;
    entities: Record<string, RoomEntity>;
    overlays: Record<string, RoomEntityOverlay>;
    overlayRevision: number;
    bytes: number;
    baseline: RoomBaseline;
  }
>();
function overlayBytes(id: string, overlay: RoomEntityOverlay): number {
  const { fields, ...header } = overlay;
  return (
    Buffer.byteLength(id) +
    Buffer.byteLength(stableJson(header)) +
    32 +
    Object.entries(fields).reduce(
      (bytes, [key, value]) =>
        bytes + Buffer.byteLength(key) + Buffer.byteLength(stableJson(value)) + 32,
      0,
    )
  );
}
function setOverlay(
  cached: { overlays: Record<string, RoomEntityOverlay>; overlayRevision: number; bytes: number },
  id: string,
  value: RoomEntityOverlay | undefined,
) {
  const old = cached.overlays[id];
  if (stableJson(old) === stableJson(value)) return;
  if (old) cached.bytes -= overlayBytes(id, old);
  if (value) {
    cached.overlays[id] = value;
    cached.bytes += overlayBytes(id, value);
  } else delete cached.overlays[id];
  cached.overlayRevision++;
}
async function projectModuleDocuments(db: SessionDatabase): Promise<readonly RawDocument[]> {
  const root = join(roomDirectoryForDatabase(db), "module");
  const documents = frozenModule(db).documents;
  const invalid = documents.find((document) => !document.valid);
  if (invalid)
    throw new Error(`冻结模组文档无效：${invalid.path}：${invalid.error ?? "原始内容校验失败"}`);
  return Promise.all(
    documents
      .filter((doc) => doc.docType)
      .map(async (doc) => rawDocument(doc.path, await readFile(join(root, doc.path), "utf8"))),
  );
}
export async function projectEntities(db: SessionDatabase) {
  let cached = projectionCache.get(roomDirectoryForDatabase(db));
  if (!cached) {
    const base = await projectRoomBaseline(db);
    cached = {
      revision: -1,
      stateRevision: -1,
      documents: [],
      count: 0,
      characterIds: new Set(),
      entities: {},
      overlays: {},
      overlayRevision: 0,
      bytes: 0,
      baseline: base,
    };
    projectionCache.set(roomDirectoryForDatabase(db), cached);
  }
  const revision = documentRevision(db);
  const stateVersion = roomGeneration(roomDirectoryForDatabase(db));
  if (cached.revision === revision && cached.stateRevision === stateVersion)
    return {
      entities: cached.entities,
      documents: cached.documents,
      documentRevision: revision,
      overlays: cached.overlays,
      overlayRevision: cached.overlayRevision,
    };
  const previousOverlayRevision = cached.overlayRevision;
  let copied = false;
  const prepareChanges = () => {
    if (copied) return;
    cached.entities = { ...cached.entities };
    cached.overlays = { ...cached.overlays };
    copied = true;
  };
  if (cached.revision !== revision) {
    const records = listGameFileRecords(db);
    if (records.length > ROOM_MAX_ENTITIES)
      throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间原始文档数量超限" });
    const dirty =
      cached.revision < 0
        ? records.map((record) => record.path)
        : documentDirtyPaths(db, cached.revision);
    const types = frozenModule(db).types;
    if (dirty.length) prepareChanges();
    for (const path of dirty) {
      const id = roomEntityId(path);
      const record = records.find((record) => record.path === path);
      if (!record) delete cached.entities[id];
      else {
        const type = types.find((type) => type.id === record.typeId)!;
        cached.entities[id] = entity(
          rawDocument(path, readOverlayDocument(gameDirectoryForDatabase(db), path, type)),
          fileRevision(db, path),
        );
      }
      const oneBase = {
        version: cached.baseline.version,
        entities: cached.baseline.entities[id] ? { [id]: cached.baseline.entities[id]! } : {},
      };
      const one = roomEntityOverlays(
        oneBase,
        cached.entities[id] ? { [id]: cached.entities[id]! } : {},
      );
      setOverlay(cached, id, one[id]);
    }
    cached.count = records.length;
    cached.revision = revision;
    cached.documents = Object.values(cached.entities).map((item) => item.document);
  }
  // 角色归属属于界面索引；原始文档及文档版本保持不变。
  const characters = new Map(
    readCharacters(db)
      .filter((character) => typeof character.sourcePath === "string")
      .map((character) => [character.sourcePath!, character]),
  );
  const characterIds = new Set([...characters.keys()].map((path) => roomEntityId(path!)));
  for (const id of new Set([...cached.characterIds, ...characterIds])) {
    let item = cached.entities[id];
    if (!item) continue;
    const c = characters.get(item.document.path);
    const character = c
      ? {
          id: c.id,
          typeId: c.typeId,
          playerId: c.playerId,
          sourcePath: c.sourcePath,
          retired: c.retired,
          version: c.version,
        }
      : undefined;
    if (stableJson(item.character) !== stableJson(character)) {
      prepareChanges();
      item = { ...item };
      cached.entities[item.id] = item;
      if (character) item.character = character;
      else delete item.character;
      const id = item.id;
      const one = roomEntityOverlays(
        {
          version: cached.baseline.version,
          entities: cached.baseline.entities[id] ? { [id]: cached.baseline.entities[id]! } : {},
        },
        { [id]: item },
      );
      setOverlay(cached, id, one[id]);
    }
  }
  if (cached.overlayRevision !== previousOverlayRevision)
    cached.overlayRevision = previousOverlayRevision + 1;
  cached.characterIds = characterIds;
  cached.stateRevision = stateVersion;
  return {
    entities: cached.entities,
    documents: cached.documents,
    documentRevision: revision,
    overlays: cached.overlays,
    overlayRevision: cached.overlayRevision,
  };
}
/** 写入前以最终原始内容校验容量；调用方须在文件事务锁内调用。 */
export async function assertRoomOverlayAdmission(
  db: SessionDatabase,
  replacements: ReadonlyMap<string, string | null>,
): Promise<void> {
  await projectEntities(db);
  const base = projectionCache.get(roomDirectoryForDatabase(db))!.baseline;
  const cached = projectionCache.get(roomDirectoryForDatabase(db))!;
  let bytes = cached.bytes;
  let count = cached.count;
  for (const [path, source] of replacements) {
    const id = roomEntityId(path);
    if (source === null && cached.entities[id]) count--;
    if (source !== null && !cached.entities[id]) count++;
    const document =
      source === null
        ? undefined
        : entity(rawDocument(path, source), (cached.entities[id]?.revision ?? 0) + 1);
    if (document && cached.entities[id]?.character)
      document.character = cached.entities[id]!.character;
    const overlay = roomEntityOverlays(
      { version: base.version, entities: base.entities[id] ? { [id]: base.entities[id]! } : {} },
      document ? { [id]: document } : {},
    )[id];
    bytes -= cached.overlays[id] ? overlayBytes(id, cached.overlays[id]!) : 0;
    bytes += overlay ? overlayBytes(id, overlay) : 0;
  }
  if (count > ROOM_MAX_ENTITIES)
    throw new ORPCError("PAYLOAD_TOO_LARGE", {
      message: `房间原始文档超过 ${ROOM_MAX_ENTITIES} 份限制`,
    });
  if (bytes > ROOM_MAX_OVERLAY_BYTES)
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间累计文档覆盖超过 8 MiB 限制" });
}

export async function projectRoomBaseline(db: SessionDatabase): Promise<RoomBaseline> {
  const documents = await projectModuleDocuments(db);
  const entities = Object.fromEntries(
    documents.map((document) => [roomEntityId(document.path), entity(document, 1)]),
  );
  const hash = createHash("sha256");
  const root = join(roomDirectoryForDatabase(db), "module");
  const walk = async (prefix: string): Promise<void> => {
    const entries = (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("冻结模组不允许符号链接");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        hash.update(
          stableJson([
            path,
            createHash("sha256")
              .update(await readFile(join(root, path)))
              .digest("hex"),
          ]),
        );
    }
  };
  await walk("");
  return { version: hash.digest("hex"), entities };
}

export function projectLaunch(
  db: SessionDatabase,
  launch: LaunchState | null,
): RoomLaunchState | null {
  if (!launch) return null;
  const {
    config: _config,
    types: _types,
    characters,
    references: _references,
    openingMessage: _openingMessage,
    ...state
  } = launch;
  const sanitizeDraft = (draft: NonNullable<typeof state.progress.draft>) => ({
    ...draft,
    values: publicValues(
      storedTypes(db).find((type) => type.id === draft.typeId)?.fields ?? [],
      draft.values,
    ),
  });
  return {
    ...state,
    progress: {
      ...state.progress,
      ...(state.progress.draft ? { draft: sanitizeDraft(state.progress.draft) } : {}),
    },
    ...(state.workbench
      ? {
          workbench: {
            ...state.workbench,
            draft: sanitizeDraft(state.workbench.draft),
            items: state.workbench.items.map((item) =>
              item.kind === "reference"
                ? { ...item, options: item.options.map(({ body: _body, ...option }) => option) }
                : item,
            ),
          },
        }
      : {}),
    characterIds: [
      ...new Set([
        ...characters.map((character) => character.id),
        ...readCharacters(db)
          .filter((character) => character.playerId && !character.retired)
          .map((character) => character.id),
      ]),
    ],
  };
}

/** 本地玩家流程配置不携带主持执行提示词。 */
export function publicLaunchConfig(config: LaunchConfig): LaunchConfig {
  return {
    ...config,
    gameStarts: config.gameStarts.map(({ aiCompanions: _ai, ...start }) => ({
      ...start,
      opening: { mode: start.opening.mode, beats: [], overrides: {}, instructions: "", prompt: "" },
    })),
  };
}

/** 房间关闭或冻结模组修复后释放累计文档缓存。 */
export function forgetRoomProjection(directory: string): void {
  projectionCache.delete(directory);
}
