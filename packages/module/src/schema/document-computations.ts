import { z } from "zod";

import type { DocumentField, DocumentType } from "./document-type";
import { validateDocumentTypeRules } from "./document-type-rules";

const pathSchema = z
  .string()
  .refine(
    (path) =>
      path
        .split(".")
        .every(
          (part) => part.length > 0 && !["__proto__", "prototype", "constructor"].includes(part),
        ),
    "计算覆盖必须使用点分隔的字段路径，不能包含空段或保留字段",
  );
export const documentComputationsSchema = z.record(
  pathSchema,
  z
    .string()
    .min(1)
    .max(2048)
    .refine((expression) => expression.trim().length > 0, "公式不能为空"),
);

export type DocumentComputations = Readonly<Record<string, string>>;
export interface DocumentData {
  readonly values: Record<string, unknown>;
  readonly computed?: DocumentComputations;
}

/** 仅在外部文件内容边界拆分；内部 values 不承载公式配置，嵌套同名业务字段保留。 */
export function splitDocumentValues(content: Record<string, unknown>): DocumentData {
  const { computed, ...values } = content;
  return {
    values,
    ...(computed !== undefined ? { computed: computed as DocumentComputations } : {}),
  };
}

/** 落盘或源数据校验时恢复公开的文档格式。 */
export function documentSourceValues(data: DocumentData): Record<string, unknown> {
  return { ...data.values, ...(data.computed !== undefined ? { computed: data.computed } : {}) };
}

const effectiveTypes = new WeakMap<DocumentType, Map<string, DocumentType>>();
const maxCachedCombinations = 128;

/** 为单份文档生成有效字段定义，不修改共享类型；列表子字段覆盖适用于每个条目。 */
export function resolveDocumentComputations(
  type: DocumentType,
  computed?: DocumentComputations,
): DocumentType {
  if (computed === undefined) return type;
  if (!computed || typeof computed !== "object" || Array.isArray(computed))
    throw new Error(`${type.id}.computed：计算覆盖必须是字段路径到公式的对象`);
  // 按配置内容缓存，原值变化、重复解码或键顺序变化都不会重建有效定义。
  // 类型按只读契约使用；重新加载定义会产生新的类型对象和独立缓存。
  const signature = JSON.stringify(
    Object.entries(computed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const cached = effectiveTypes.get(type)?.get(signature);
  if (cached) return cached;
  const parsed = documentComputationsSchema.safeParse(computed);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${type.id}.computed${issue?.path.length ? `.${issue.path.join(".")}` : ""}：${issue?.message ?? "计算覆盖格式无效"}`,
    );
  }
  if (!Object.keys(parsed.data).length) return type;
  const overrides = new Map<DocumentField, string>();
  for (const [path, expression] of Object.entries(parsed.data)) {
    const parts = path.split(".");
    let fields = type.fields;
    let field: DocumentField | undefined;
    for (const part of parts) {
      field = fields.find((candidate) => candidate.key === part);
      if (!field) throw new Error(`${type.id}.computed.${path}：字段未在类型中声明`);
      fields =
        field.type === "object"
          ? (field.fields ?? [])
          : field.type === "list" && field.item?.type === "object"
            ? (field.item.fields ?? [])
            : [];
    }
    if (field!.mutable)
      throw new Error(`${type.id}.computed.${path}：计算字段不能标记为运行时可修改`);
    overrides.set(field!, expression);
  }
  const resolve = (fields: readonly DocumentField[]): DocumentField[] =>
    fields.map((field) => ({
      ...field,
      ...(overrides.has(field) ? { compute: overrides.get(field)!, required: false } : {}),
      ...(field.fields ? { fields: resolve(field.fields) } : {}),
      ...(field.item?.fields
        ? { item: { ...field.item, fields: resolve(field.item.fields) } }
        : {}),
    }));
  const result = { ...type, fields: resolve(type.fields) };
  validateDocumentTypeRules(result);
  let combinations = effectiveTypes.get(type);
  if (!combinations) effectiveTypes.set(type, (combinations = new Map()));
  combinations.set(signature, result);
  if (combinations.size > maxCachedCombinations)
    combinations.delete(combinations.keys().next().value!);
  return result;
}
