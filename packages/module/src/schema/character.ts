import { z } from "zod";

import type { DisplayProjection } from "./display-fields";
import { documentComputationsSchema, type DocumentComputations } from "./document-computations";
import type { DocumentField, DocumentType } from "./document-type";

export const characterDraftSchema = z
  .object({
    typeId: z.string().min(1),
    name: z.string().max(100),
    description: z.string().max(2000).default(""),
    values: z.record(z.string(), z.unknown()),
    computed: documentComputationsSchema.optional(),
  })
  .strict();
export type CharacterDraft = z.infer<typeof characterDraftSchema>;
export interface Character extends DisplayProjection {
  retired?: boolean;
  id: string;
  typeId: string;
  playerId: string | null;
  sourcePath: string | null;
  /** 可移植图片引用；动态建卡预览由客户端本地解析。 */
  image?: string;
  /** 可移植聊天头像引用；显示时通过本机图片入口解析。 */
  avatar?: string;
  name: string;
  description: string;
  body?: string;
  values: Record<string, unknown>;
  /** 展示投影的计算错误，不属于角色原始数据。 */
  fieldErrors?: Readonly<Record<string, string>>;
  computed?: DocumentComputations;
  version: number;
}
/** 玩家界面的字段展示结构；嵌套对象及对象列表同样过滤，不用于同步授权。 */
export function publicFields(fields: readonly DocumentField[]): DocumentField[] {
  return fields
    .filter((f) => f.visibility === "public")
    .map(({ compute: _compute, ...field }) => ({
      ...field,
      ...(field.fields ? { fields: publicFields(field.fields) } : {}),
      ...(field.item?.fields
        ? { item: { ...field.item, fields: publicFields(field.item.fields) } }
        : {}),
    }));
}
/** 生成界面展示与交互结构；渲染线程计算另使用本地完整类型。 */
export function publicDocumentType(type: DocumentType): DocumentType {
  const { creationFlow: _creationFlow, ...rest } = type;
  return { ...rest, fields: publicFields(type.fields) };
}
export function publicValues(
  fields: readonly DocumentField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((f) => f.visibility === "public" && Object.hasOwn(values, f.key))
      .map((f) => {
        let value = values[f.key];
        if (f.type === "object" && value && typeof value === "object")
          value = publicValues(f.fields ?? [], value as Record<string, unknown>);
        if (f.type === "list" && f.item?.type === "object" && Array.isArray(value))
          value = value.map((v) => {
            const row = publicValues(f.item!.fields ?? [], v);
            if (
              f.item?.instance &&
              f.item.fields?.some(
                (child) =>
                  child.key === f.item!.instance!.stateField && child.visibility === "public",
              )
            ) {
              const projection = v.$instance;
              const key = f.item.instance.stateField;
              row[key] = projection?.values ?? (projection?.display ? v[key] : {}) ?? {};
              if (projection?.display) row.$instance = { display: projection.display };
            }
            return row;
          });
        return [f.key, value];
      }),
  );
}
