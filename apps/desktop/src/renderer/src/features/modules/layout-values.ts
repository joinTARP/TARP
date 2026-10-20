import { readDocumentPath } from "@jointarp/module/document-field-values";
import type { DocumentField, DocumentType } from "@jointarp/module/document-type";
import type { ModuleDocument } from "@jointarp/module/module-document";
import {
  fieldErrorAtPath,
  getDocumentField,
  getPublicDocumentField,
} from "@jointarp/module/public-document-field";
import { displayFieldDefinition } from "@jointarp/module/template-layout";

export interface LayoutContext {
  document: ModuleDocument;
  documentType?: DocumentType;
  library?: boolean;
  imagePath?: string;
}
export interface LayoutCell {
  field: DocumentField;
  value: unknown;
  error?: string;
}
const metadataLabels: Record<string, string> = {
  name: "名称",
  image: "图片",
  avatar: "头像",
  description: "简介",
  body: "正文",
};
export function readLayoutCell(context: LayoutContext, path: string): LayoutCell | undefined {
  const { document, documentType, library } = context;
  const display = displayFieldDefinition(documentType?.layout?.displayFields, path);
  if (display)
    return {
      field: display,
      value: document.displayValues?.[path.slice(9)],
      error: document.displayErrors?.[path.slice(9)],
    };
  const declared = getDocumentField(documentType?.fields ?? [], path);
  const field = library ? declared : getPublicDocumentField(documentType?.fields ?? [], path);
  if (declared && !field) return undefined;
  const error = fieldErrorAtPath(document.fieldErrors, path);
  if (Object.hasOwn(metadataLabels, path))
    return {
      field: field ?? {
        key: path,
        label: metadataLabels[path],
        type: "text",
        required: false,
        mutable: false,
        visibility: "public",
      },
      value: path === "name" ? document.title : document[path as "description"],
      error,
    };
  return field ? { field, value: readDocumentPath(document.values, path), error } : undefined;
}
export function layoutText(value: unknown): string {
  return value == null || value === ""
    ? "暂无数据"
    : typeof value === "boolean"
      ? value
        ? "是"
        : "否"
      : Array.isArray(value)
        ? value.map(layoutText).join("、")
        : typeof value === "object"
          ? `${Object.keys(value).length} 项`
          : String(value);
}
