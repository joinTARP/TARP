import { z } from "zod";

import type { DocumentField } from "./document-type";
import { imageAspectSchema } from "./image-aspect";

const fieldKey = z.string().trim().min(1).max(100);

/** 引用集合只配置展示；不会赋予数据修改权限。 */
export const referenceCollectionSchema = z
  .object({
    type: z.literal("ReferenceCollection"),
    referenceField: fieldKey.optional(),
    display: z.enum(["cards", "list", "slots", "sheets"]).default("cards"),
    imageAspect: imageAspectSchema.default("4:3"),
    slotCount: z.number().int().min(1).max(200).optional(),
    quantityField: fieldKey.optional(),
    searchable: z.boolean().default(true),
    switchable: z.boolean().default(true),
    filterField: fieldKey.optional(),
    metadata: z
      .array(
        z
          .object({
            field: fieldKey,
            label: z.string().trim().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict();

export type ReferenceCollectionLayout = z.infer<typeof referenceCollectionSchema>;

export function validateReferenceCollection(
  field: DocumentField,
  config: ReferenceCollectionLayout,
): void {
  if (field.type !== "list") throw new Error("引用集合必须绑定 list 字段");
  if (config.display === "sheets" && field.item?.type !== "reference")
    throw new Error("嵌入文档卡片需要纯引用列表");
  if (field.item?.type === "reference") {
    if (
      config.referenceField ||
      config.filterField ||
      config.quantityField ||
      config.metadata.length
    )
      throw new Error("纯引用列表不能配置条目子字段");
    return;
  }
  if (field.item?.type !== "object") throw new Error("引用集合需要引用列表或包含引用的对象列表");
  const fields = field.item.fields ?? [];
  if (config.quantityField) {
    const quantity = fields.find((child) => child.key === config.quantityField);
    if (!quantity || quantity.type !== "number" || quantity.visibility !== "public")
      throw new Error("quantityField 必须指向公开的 number 子字段");
  }
  const reference = fields.find((child) => child.key === config.referenceField);
  if (!reference || reference.type !== "reference" || reference.visibility !== "public")
    throw new Error("referenceField 必须指向公开的 reference 子字段");
  const keys = config.metadata.map((entry) => entry.field);
  if (new Set(keys).size !== keys.length) throw new Error("metadata 字段不能重复");
  for (const key of [...keys, ...(config.filterField ? [config.filterField] : [])]) {
    const child = fields.find((candidate) => candidate.key === key);
    if (
      !child ||
      child.visibility !== "public" ||
      !["text", "number", "boolean", "enum"].includes(child.type)
    )
      throw new Error(`字段 ${key} 必须是公开的文本、数字、布尔或枚举子字段`);
  }
}
