import { z } from "zod";

import type { DocumentField } from "./document-type";

export const fieldTableSchema = z
  .object({
    type: z.literal("FieldTable"),
    rowKey: z.string().trim().min(1),
    searchable: z.boolean().optional(),
    columns: z
      .array(
        z
          .object({
            field: z.string().trim().min(1),
            label: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    collapsedGroup: z
      .object({
        field: z.string().trim().min(1),
        label: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FieldTableLayout = z.infer<typeof fieldTableSchema>;

export function validateFieldTableRows(value: unknown, config: FieldTableLayout): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("表格内容必须是对象列表");
  const identities = new Set<string>();
  value.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error(`第 ${index + 1} 行必须是对象`);
    const key = (row as Record<string, unknown>)[config.rowKey];
    if (
      !(
        (typeof key === "string" && key.trim()) ||
        (typeof key === "number" && Number.isFinite(key))
      )
    )
      throw new Error(`第 ${index + 1} 行的 ${config.rowKey} 必须是非空行标识`);
    const identity = String(key).trim();
    if (identities.has(identity)) throw new Error(`行标识 ${config.rowKey} 重复：${identity}`);
    identities.add(identity);
  });
}

export function validateFieldTable(field: DocumentField, config: FieldTableLayout): void {
  if (field.type !== "list" || field.item?.type !== "object")
    throw new Error("字段表格需要对象列表");
  const fields = field.item.fields ?? [];
  const identity = fields.find((candidate) => candidate.key === config.rowKey);
  if (
    !identity ||
    identity.visibility !== "public" ||
    !["text", "number", "reference"].includes(identity.type)
  )
    throw new Error("rowKey 必须指向公开的文本、数字或引用字段");
  const keys = config.columns.map((column) => column.field);
  if (new Set(keys).size !== keys.length) throw new Error("表格列不能重复");
  for (const key of keys) {
    const child = fields.find((candidate) => candidate.key === key);
    if (
      !child ||
      child.visibility !== "public" ||
      !["text", "number", "boolean", "enum", "reference"].includes(child.type)
    )
      throw new Error(`表格列 ${key} 必须是公开的标量或引用字段`);
  }
  if (config.collapsedGroup) {
    const child = fields.find((candidate) => candidate.key === config.collapsedGroup?.field);
    if (!child || child.visibility !== "public" || child.type !== "boolean")
      throw new Error("折叠分组必须使用公开的布尔字段，false 条目进入折叠组");
  }
}
