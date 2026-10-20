import { schema, t } from "@colyseus/schema";

/** 固定平台结构；模组的每个顶层字段独立编码，值保持 JSON 语义。 */
export const EntityStateSchema = schema(
  {
    header: t.string(),
    fields: t.map("string"),
  },
  "GameDocumentV1",
);

export const RoomStateSchema = schema(
  {
    sections: t.map("string"),
    entities: t.map(EntityStateSchema),
  },
  "GameDocumentOverlayV1",
);

/** JSON 键顺序不影响同步；undefined 与 JSON 序列化行为一致。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
