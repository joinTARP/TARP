import type { RoomBaseline, RoomEntity, RoomEntityOverlay } from "./room-state";
import { stableJson } from "./room-state-schema";

/** 对原始文档的顶层键取差异；对象及数组整体覆盖。 */
export function roomEntityOverlays(
  baseline: RoomBaseline,
  entities: Readonly<Record<string, RoomEntity>>,
) {
  const result: Record<string, RoomEntityOverlay> = Object.create(null);
  for (const [id, entity] of Object.entries(entities)) {
    const base = baseline.entities[id];
    if (!base) {
      result[id] = {
        created: true,
        revision: entity.revision,
        ...(entity.character ? { character: entity.character } : {}),
        document: Object.fromEntries(
          Object.entries(entity.document).filter(([key]) => key !== "values"),
        ),
        removedDocument: [],
        fields: entity.document.values,
        removedFields: [],
      };
      continue;
    }
    const fields = Object.fromEntries(
      Object.entries(entity.document.values).filter(
        ([key, value]) => stableJson(value) !== stableJson(base.document.values[key]),
      ),
    );
    const removedFields = Object.keys(base.document.values).filter(
      (key) => !Object.hasOwn(entity.document.values, key),
    );
    const document = Object.fromEntries(
      Object.entries(entity.document).filter(
        ([key, value]) =>
          key !== "values" &&
          stableJson(value) !==
            stableJson((base.document as unknown as Record<string, unknown>)[key]),
      ),
    );
    const removedDocument = Object.keys(base.document).filter(
      (key) => key !== "values" && !Object.hasOwn(entity.document, key),
    );
    const characterChanged = stableJson(entity.character) !== stableJson(base.character);
    if (
      Object.keys(document).length ||
      removedDocument.length ||
      Object.keys(fields).length ||
      removedFields.length ||
      characterChanged
    )
      result[id] = {
        revision: entity.revision,
        ...(characterChanged ? { character: entity.character ?? null } : {}),
        fields,
        removedFields,
        document,
        removedDocument,
      };
  }
  for (const id of Object.keys(baseline.entities)) {
    if (!Object.hasOwn(entities, id))
      result[id] = {
        deleted: true,
        document: {},
        removedDocument: [],
        fields: {},
        removedFields: [],
      };
  }
  return result;
}

export function applyRoomEntityOverlay(
  id: string,
  base: RoomEntity | undefined,
  overlay: RoomEntityOverlay,
): RoomEntity | undefined {
  if (overlay.deleted) return undefined;
  if (!base && !overlay.created) throw new Error("房间覆盖缺少模组实体基线");
  const revision = overlay.revision ?? (overlay.created ? undefined : base?.revision);
  if (revision === undefined || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error("实体状态无效");
  const values = { ...(overlay.created ? undefined : base?.document.values), ...overlay.fields };
  for (const key of overlay.removedFields) delete values[key];
  const document = {
    ...(overlay.created ? undefined : base?.document),
    ...overlay.document,
    values,
  } as RoomEntity["document"];
  for (const key of overlay.removedDocument) {
    if (key === "values") throw new Error("房间文档字段必须通过字段删除列表移除");
    delete (document as unknown as Record<string, unknown>)[key];
  }
  const character =
    overlay.character === undefined
      ? overlay.created
        ? undefined
        : base?.character
      : (overlay.character ?? undefined);
  return { id, revision, ...(character ? { character } : {}), document };
}
