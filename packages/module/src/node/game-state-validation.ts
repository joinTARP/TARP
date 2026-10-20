import { documentIdentity } from "../schema/document-path";
import {
  documentMetadataSchema,
  validateDocumentValues,
  type DocumentField,
  type DocumentSourceContent,
  type DocumentType,
} from "../schema/document-type";
import type { ModuleDocument } from "../schema/module-document";
import { parseDocumentContent } from "./document-codec";

const MAX_JSON_BYTES = 1024 * 1024;

export function parseGameDocumentContent(
  type: DocumentType,
  source: string,
  path: string,
): DocumentSourceContent {
  if (Buffer.byteLength(source) > MAX_JSON_BYTES) throw new Error("游戏文档超过 1 MiB 限制");
  const parsed = documentMetadataSchema.parse(parseDocumentContent(source, path));
  if (Object.hasOwn(parsed, "doc_type") || Object.hasOwn(parsed, "_runtime"))
    throw new Error("文档不能包含保留字段 doc_type 或 _runtime");
  validateDocumentValues(type, parsed);
  return parsed;
}

export function collectGameDocumentReferences(
  fields: readonly DocumentField[],
  values: Record<string, unknown>,
): Array<{ value: string; targets: readonly string[] }> {
  const result: Array<{ value: string; targets: readonly string[] }> = [];
  const visit = (field: DocumentField, value: unknown): void => {
    if (field.type === "reference" && typeof value === "string")
      result.push({ value, targets: field.targets ?? [] });
    if (field.type === "object" && value && typeof value === "object" && !Array.isArray(value))
      for (const child of field.fields ?? [])
        visit(child, (value as Record<string, unknown>)[child.key]);
    if (field.type === "list" && Array.isArray(value)) {
      if (field.item?.type === "reference")
        for (const item of value)
          if (typeof item === "string")
            result.push({ value: item, targets: field.item.targets ?? [] });
      if (field.item?.type === "object")
        for (const item of value)
          if (item && typeof item === "object" && !Array.isArray(item))
            for (const child of field.item.fields ?? [])
              visit(child, (item as Record<string, unknown>)[child.key]);
    }
  };
  for (const field of fields) visit(field, values[field.key]);
  return result;
}

/** 初始状态与游戏写入共用字段声明中的引用约束。 */
export function validateGameDocumentReferences(
  type: DocumentType,
  content: Record<string, unknown>,
  records: readonly Pick<ModuleDocument, "path" | "docType">[],
): void {
  const {
    name: _name,
    description: _description,
    image: _image,
    avatar: _avatar,
    body: _body,
    ...values
  } = content;
  for (const reference of collectGameDocumentReferences(type.fields, values)) {
    const identity = documentIdentity(reference.value);
    const row = records.find((candidate) => documentIdentity(candidate.path) === identity);
    if (!row || !reference.targets.includes(row.docType ?? ""))
      throw new Error(`引用不存在或类型不匹配：${reference.value}`);
  }
}

/** 校验原始开局数据；不读取存档，也不以计算后的字段替代文件内容。 */
export function validateInitialGameState(
  documents: readonly ModuleDocument[],
  types: readonly DocumentType[],
  fileContents: ReadonlyMap<string, string>,
): void {
  for (const document of documents) {
    if (!document.valid || !document.contentType || !document.docType) continue;
    const source = fileContents.get(document.path);
    if (source === undefined) throw new Error(`游戏工作区缺少文档：${document.path}`);
  }
  for (const document of documents) {
    const type = types.find((t) => t.id === document.docType);
    const source = fileContents.get(document.path);
    if (type && source !== undefined) {
      try {
        validateGameDocumentReferences(
          type,
          parseGameDocumentContent(type, source, document.path),
          documents,
        );
      } catch (error) {
        throw new Error(
          `${document.path}：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }
}
