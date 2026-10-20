import { z } from "zod";

import type { DocumentField, ScalarFieldType } from "./document-type";

const fieldValueSchemas = {
  text: z.string(),
  number: z.number().finite(),
  boolean: z.boolean(),
} as const;

interface FieldValueSchemaOptions {
  strict?: boolean;
  phase?: "source" | "resolved";
}

function scalarValueSchema(type: ScalarFieldType, options?: readonly string[]): z.ZodType {
  if (type === "enum") {
    return z.string().refine((value) => options?.includes(value) ?? false, "必须是 options 之一");
  }
  if (type === "reference") {
    return z.string().refine((value) => value.trim().length > 0, "引用不能为空");
  }
  return fieldValueSchemas[type];
}

function objectValueSchema(
  fields: readonly DocumentField[],
  documentTypeId: string,
  options: FieldValueSchemaOptions,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const child of fields) {
    shape[child.key] = fieldValueSchema(child, documentTypeId, options);
  }
  return options.strict ? z.object(shape).strict() : z.object(shape).passthrough();
}

/** 原值严格按类型校验；计算视图中只有声明 compute 的字段允许 null，嵌套规则相同。 */
export function fieldValueSchema(
  field: DocumentField,
  documentTypeId: string,
  options: FieldValueSchemaOptions = {},
): z.ZodType {
  let schema: z.ZodType;
  if (field.type === "list") {
    if (!field.item) throw new Error(`${documentTypeId}.${field.key}：list 字段缺少 item 元素类型`);
    schema = z.array(
      field.item.type === "object"
        ? objectValueSchema(
            field.item.fields ?? [],
            documentTypeId,
            field.item.instance && options.phase !== "resolved"
              ? { ...options, strict: true }
              : options,
          )
        : scalarValueSchema(field.item.type, field.item.options),
    );
  } else if (field.type === "object") {
    if (!field.fields) throw new Error(`${documentTypeId}.${field.key}：object 字段缺少 fields`);
    schema = field.fields.length
      ? objectValueSchema(field.fields, documentTypeId, options)
      : z.record(z.string(), z.unknown());
  } else {
    schema = scalarValueSchema(field.type, field.options);
  }

  if (field.required && field.type === "text")
    schema = fieldValueSchemas.text.refine((value) => value.trim().length > 0, "不能为空");
  if (options.phase === "resolved" && field.compute !== undefined) schema = schema.nullable();
  return field.required ? schema : schema.optional();
}

/** 按声明过的点路径读取对象字段，不解释字段业务含义。 */
export function readDocumentPath(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
