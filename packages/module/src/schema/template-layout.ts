import { z } from "zod";

import type { DocumentField, DocumentType } from "./document-type";
import { parseTemplateHtml, validateHandlebarsTemplate } from "./handlebars-template";
import { imageAspectSchema } from "./image-aspect";
import { getDocumentField } from "./public-document-field";
import { referenceCollectionSchema, validateReferenceCollection } from "./reference-collection";

const path = z.string().trim().min(1);
export const templateComponentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("reference"),
      field: path.optional(),
      value: z.string().optional(),
      label: z.string().optional(),
      display: z.enum(["link", "sheet"]).default("link"),
    })
    .strict()
    .refine(
      (value) => Boolean(value.field) !== (value.value !== undefined),
      "引用必须选择 field 或 value",
    ),
  z
    .object({
      type: z.literal("item-grid"),
      field: path,
      capacity: z.number().int().min(0).max(200).default(0),
      referenceField: path.optional(),
      quantityField: path.optional(),
      label: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      field: path,
      imageAspect: imageAspectSchema.optional(),
      alt: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal("markdown"), field: path }).strict(),
]);
export type TemplateComponent = z.infer<typeof templateComponentSchema>;
export const templateLayoutSchema = z
  .object({
    type: z.literal("handlebars"),
    template: z.string().min(1).max(200000),
    css: z.string().max(200000).optional(),
    partials: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/), z.string().max(200000))
      .optional(),
  })
  .strict();
export type TemplateLayout = z.infer<typeof templateLayoutSchema>;
export const displayFieldsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z
    .object({
      type: z.enum(["text", "number", "boolean"]),
      label: path,
      compute: z.string().trim().min(1).max(2048),
      hideWhenEmpty: z.boolean().optional(),
    })
    .strict(),
);
export type DisplayFields = z.infer<typeof displayFieldsSchema>;
export function displayFieldDefinition(
  fields: DisplayFields | undefined,
  path: string,
): DocumentField | undefined {
  if (!path.startsWith("$display.")) return undefined;
  const entry = fields?.[path.slice(9)];
  return entry
    ? {
        key: path,
        label: entry.label,
        type: entry.type,
        hideWhenEmpty: entry.hideWhenEmpty,
        required: false,
        mutable: false,
        visibility: "public",
      }
    : undefined;
}

export function templateComponentNode(
  tag: string,
  attributes: Record<string, string>,
): TemplateComponent | undefined {
  const kind = tag.replace(/^tarp-/, "");
  if (!["reference", "item-grid", "image", "markdown"].includes(kind)) return undefined;
  const names: Record<string, string> = {
    "image-aspect": "imageAspect",
    "reference-field": "referenceField",
    "quantity-field": "quantityField",
  };
  const result: Record<string, unknown> = { type: kind };
  for (const [key, value] of Object.entries(attributes)) {
    if (
      ["class", "style", "id", "title"].includes(key) ||
      key.startsWith("data-") ||
      key.startsWith("aria-")
    )
      continue;
    result[names[key] ?? key] = key === "capacity" ? Number(value) : value;
  }
  return templateComponentSchema.parse(result);
}
export function templateComponents(layout: TemplateLayout): TemplateComponent[] {
  const components: TemplateComponent[] = [];
  for (const source of [layout.template, ...Object.values(layout.partials ?? {})]) {
    const visit = (html: ReturnType<typeof parseTemplateHtml>[number]) => {
      if (html.type !== "tag" && html.type !== "style") return;
      if (
        html.name.startsWith("tarp-") &&
        !Object.values(html.attribs).some((value) => value.includes("{{"))
      ) {
        const component = templateComponentNode(html.name, html.attribs);
        if (component) components.push(component);
      }
      html.children.forEach(visit);
    };
    parseTemplateHtml(source).forEach(visit);
  }
  return components;
}
export function componentFieldPaths(component: TemplateComponent): string[] {
  return component.field ? [component.field] : [];
}
export function itemGridConfig(component: Extract<TemplateComponent, { type: "item-grid" }>) {
  return referenceCollectionSchema.parse({
    type: "ReferenceCollection",
    display: "slots",
    referenceField: component.referenceField,
    quantityField: component.quantityField,
    searchable: false,
    switchable: false,
  });
}
export function validateTemplateComponent(
  type: DocumentType,
  component: TemplateComponent,
  displayFields?: DisplayFields,
): void {
  if (!component.field) return;
  const field: DocumentField | undefined =
    displayFieldDefinition(displayFields, component.field) ??
    getDocumentField(type.fields, component.field) ??
    (["name", "description", "body", "image", "avatar"].includes(component.field)
      ? {
          key: component.field,
          label: component.field,
          type: "text",
          required: false,
          mutable: false,
          visibility: "public",
        }
      : undefined);
  if (!field) throw new Error(`${type.id}.layout：字段 ${component.field} 不存在`);
  if (["image", "markdown"].includes(component.type) && field.type !== "text")
    throw new Error("Markdown 和图片必须绑定文本字段");
  if (component.type === "reference" && field.type !== "reference")
    throw new Error("引用组件必须绑定 reference 字段");
  if (component.type === "item-grid") validateReferenceCollection(field, itemGridConfig(component));
}
export function validateTemplateLayout(
  type: DocumentType,
  layout: TemplateLayout,
  displayFields?: DisplayFields,
): void {
  try {
    validateHandlebarsTemplate(layout.template, layout.partials);
    templateComponents(layout).forEach((component) =>
      validateTemplateComponent(type, component, displayFields),
    );
  } catch (error) {
    throw new Error(`${type.id}.layout：${error instanceof Error ? error.message : String(error)}`);
  }
}
