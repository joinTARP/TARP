import type { DocumentType } from "./document-type";
import type { TemplateLayout } from "./template-layout";

/** 平台默认展示为内部预设，不属于模组 HBS 配置协议。 */
export interface PresetLayout {
  type: "preset";
  mode: "detail" | "sheet";
  part?: "primary" | "content";
}
export type DocumentPresentation = TemplateLayout | PresetLayout;
const metadata = new Set(["name", "description", "body", "image", "avatar"]);
export function defaultDocumentFields(type: DocumentType | undefined): readonly string[] {
  const layout = type?.layout;
  if (layout && layout.type !== "handlebars")
    return layout.type === "split" ? [...layout.fields, ...layout.contentFields] : layout.fields;
  return type?.fields.filter((field) => !metadata.has(field.key)).map((field) => field.key) ?? [];
}
export function documentDetailTemplate(
  type: DocumentType | undefined,
  mode: "detail" | "sheet" = "detail",
  part?: "primary" | "content",
): DocumentPresentation {
  const layout = type?.layout;
  if (mode === "detail" && layout?.type === "handlebars")
    return {
      type: "handlebars",
      template: layout.template,
      css: layout.css,
      partials: layout.partials,
    };
  if (mode === "sheet" && layout?.sheet) return layout.sheet;
  return { type: "preset", mode, part };
}
