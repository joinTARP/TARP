import type { ModuleDocument } from "@shared/desktop-api";
import type { DocumentType } from "@tarp/module/document-type";
import { isDocumentVisible } from "@tarp/module/module-document";
import {
  fieldErrorAtPath,
  getDocumentField,
  hasFieldErrors,
  getPublicDocumentField,
  shouldHideEmptyField,
} from "@tarp/module/public-document-field";
import { displayFieldDefinition } from "@tarp/module/template-layout";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** 预览只取明确配置的公开字段，父字段的可见性同样有效。 */
export function getPreviewFields(
  document: ModuleDocument,
  type: DocumentType | undefined,
  paths: readonly string[],
  library = false,
) {
  if (!library && !isDocumentVisible(document, type)) return [];
  return paths.flatMap((path) => {
    const field =
      displayFieldDefinition(type?.layout?.displayFields, path) ??
      (library ? getDocumentField : getPublicDocumentField)(type?.fields ?? [], path);
    if (!field) return [];
    let value: unknown = document.values;
    for (const key of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (path.startsWith("$display.")) value = document.displayValues?.[path.slice(9)];
    const error =
      (path.startsWith("$display.") ? document.displayErrors?.[path.slice(9)] : undefined) ??
      fieldErrorAtPath(document.fieldErrors, path) ??
      (hasFieldErrors(document.fieldErrors, path)
        ? Object.entries(document.fieldErrors ?? {}).find(
            ([key]) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`),
          )?.[1]
        : undefined);
    if (!error && (value === undefined || shouldHideEmptyField(field, value))) return [];
    const text = error
      ? "计算失败"
      : value === null || value === ""
        ? "暂无数据"
        : Array.isArray(value)
          ? `${value.length} 项`
          : typeof value === "object"
            ? `${Object.keys(value).length} 项`
            : typeof value === "boolean"
              ? value
                ? "是"
                : "否"
              : String(value);
    return [
      {
        path,
        label: field.label,
        text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        ...(error ? { error } : {}),
      },
    ];
  });
}

/** 仅解析模组内完整路径，外部链接与锚点交回普通 Markdown 渲染。 */
export function documentReferencePath(href: string): string | undefined {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/iu.test(href)) return undefined;
  try {
    const path = decodeURIComponent(href).replace(/^\.\//u, "");
    return path;
  } catch {
    return undefined;
  }
}

interface SummaryNode {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly children?: readonly SummaryNode[];
}

function summaryText(node: SummaryNode): string {
  if (node.type === "html" || node.type === "definition") return "";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return " ";
  if (node.value !== undefined) return node.value;
  const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
    node.type,
  )
    ? " "
    : "";
  return node.children?.map(summaryText).join(separator) ?? "";
}

/** 仅为预览补正文摘要，不修改描述，也不影响详情页的正文布局。 */
export function getPreviewDescription(document: ModuleDocument): string | undefined {
  if (fieldErrorAtPath(document.fieldErrors, "description")) return undefined;
  if (document.description?.trim()) return document.description;
  if (!document.body || fieldErrorAtPath(document.fieldErrors, "body")) return undefined;
  const tree = fromMarkdown(document.body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return summaryText(tree).replace(/\s+/gu, " ").trim() || undefined;
}
