import { z } from "zod";

import { validateCreationDocument } from "./creation-workbench";
import {
  documentComputationsSchema,
  resolveDocumentComputations,
  type DocumentComputations,
} from "./document-computations";
import { fieldValueSchema } from "./document-field-values";
import { readDocumentPath } from "./document-field-values";
import {
  documentFieldViewSchema,
  validateDocumentFieldView,
  type DocumentFieldViewLayout,
} from "./document-field-view";
import { validateDocumentTypeRules } from "./document-type-rules";
import { validateFieldTableRows } from "./field-table";
import { creationFlowSchema, type CreationFlow } from "./flow";
import { imageAspectSchema, type ImageAspect } from "./image-aspect";
import { getPublicDocumentField } from "./public-document-field";
import {
  templateLayoutSchema,
  templateComponents,
  componentFieldPaths,
  displayFieldsSchema,
  displayFieldDefinition,
  validateTemplateLayout,
  type TemplateLayout,
  type DisplayFields,
} from "./template-layout";

const scalarFieldTypes = ["text", "number", "boolean", "enum", "reference"] as const;
export type ScalarFieldType = (typeof scalarFieldTypes)[number];
export const documentFieldTypes = [...scalarFieldTypes, "list", "object"] as const;
export type DocumentFieldType = (typeof documentFieldTypes)[number];
export type DocumentContentType = "json" | "toml" | "markdown";
export const documentFieldVisibilities = ["public", "gm"] as const;
export type DocumentFieldVisibility = (typeof documentFieldVisibilities)[number];

/** 通用界面使用的内置文本字段；可在 fields 中声明计算、可见性和校验规则。 */
export const documentMetadataKeys = ["name", "description", "image", "avatar", "body"] as const;
export function isDocumentMetadataKey(key: string): boolean {
  return (documentMetadataKeys as readonly string[]).includes(key);
}
export const documentMetadataSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    image: z.string().trim().min(1).optional(),
    avatar: z.string().trim().min(1).optional(),
    body: z.string().optional(),
    computed: documentComputationsSchema.optional(),
  })
  .passthrough();

export type DocumentSourceContent = z.infer<typeof documentMetadataSchema>;

function validateEnumOptions(
  field: { type: string; options?: string[] },
  context: z.RefinementCtx,
): void {
  if (field.type !== "enum") return;
  if (!field.options || field.options.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "enum 字段必须提供非空 options",
    });
    return;
  }
  if (field.options.some((option) => option.trim().length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "enum 的 options 不能包含空字符串",
    });
  }
  if (new Set(field.options).size !== field.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "enum 的 options 不能重复" });
  }
}

function validateReferenceTargets(
  field: { type: string; targets?: string[] },
  context: z.RefinementCtx,
): void {
  if (field.type !== "reference") return;
  if (!field.targets || field.targets.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "reference 字段必须提供非空 targets",
    });
    return;
  }
  if (field.targets.some((target) => target.trim().length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "reference 的 targets 不能包含空字符串",
    });
  }
  if (new Set(field.targets).size !== field.targets.length) {
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "reference 的 targets 不能重复",
    });
  }
}

const listItemSchema = z
  .object({
    type: z.enum([...scalarFieldTypes, "object"]),
    options: z.array(z.string()).optional(),
    targets: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    instance: z
      .object({
        referenceField: z.string().trim().min(1).max(100),
        stateField: z.string().trim().min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((item, context) => {
    validateEnumOptions(item, context);
    validateReferenceTargets(item, context);
    if (item.instance && item.type !== "object")
      context.addIssue({ code: "custom", path: ["instance"], message: "仅对象列表支持实例绑定" });
    if (item.type === "object" && (!item.fields || Object.keys(item.fields).length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "object 列表元素必须提供非空 fields",
      });
    }
  });

const fieldSchema = z
  .object({
    type: z.enum(documentFieldTypes),
    label: z.string().trim().min(1).optional(),
    required: z.boolean().optional(),
    mutable: z.boolean().default(false),
    visibility: z.enum(documentFieldVisibilities).default("public"),
    hideWhenEmpty: z.boolean().optional(),
    options: z.array(z.string()).optional(),
    targets: z.array(z.string()).optional(),
    item: listItemSchema.optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    compute: z.string().optional(),
  })
  .strict();

const validatedFieldSchema = fieldSchema.superRefine((field, context) => {
  validateEnumOptions(field, context);
  validateReferenceTargets(field, context);
  if (field.type === "list" && !field.item) {
    context.addIssue({
      code: "custom",
      path: ["item"],
      message: "list 字段必须提供 item 元素类型",
    });
  }
  if (field.type === "object" && (!field.fields || Object.keys(field.fields).length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["fields"],
      message: "object 字段必须提供非空 fields",
    });
  }
  if (
    field.compute !== undefined &&
    (field.compute.trim().length === 0 || field.compute.length > 2048)
  ) {
    context.addIssue({
      code: "custom",
      path: ["compute"],
      message: "compute 长度必须为 1 到 2048 个字符",
    });
  }
  if (field.compute !== undefined && field.required) {
    context.addIssue({
      code: "custom",
      path: ["required"],
      message: "计算字段由系统生成，不需要 required",
    });
  }
  if (field.compute !== undefined && field.mutable) {
    context.addIssue({
      code: "custom",
      path: ["mutable"],
      message: "计算字段不能标记为运行时可修改",
    });
  }
});

const layoutSectionSchema = z.enum(["fields", "description", "body"]);
export type DocumentLayoutSection = z.infer<typeof layoutSectionSchema>;
export const defaultDocumentLayoutOrder: readonly DocumentLayoutSection[] = [
  "fields",
  "description",
  "body",
];

const gridLayoutSchema = z
  .object({
    type: z.literal("grid"),
    width: z.number().int().min(240).max(1600).optional(),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
    fields: z.array(z.string().trim().min(1)).min(1),
    fieldViews: z.record(z.string(), documentFieldViewSchema).optional(),
    order: z.array(layoutSectionSchema).min(1).optional(),
  })
  .strict();

const splitLayoutSchema = gridLayoutSchema.extend({
  type: z.literal("split"),
  contentFields: z.array(z.string().trim().min(1)).default([]),
  imageAspect: imageAspectSchema.default("square"),
});
const documentLayoutSchema = z.discriminatedUnion("type", [gridLayoutSchema, splitLayoutSchema]);

const previewFieldsSchema = z.array(z.string().trim().min(1));
export const documentListSchema = z
  .object({
    type: z.enum(["cards", "table"]).default("cards"),
    fields: previewFieldsSchema.max(8).default([]),
    description: z.boolean().default(true),
  })
  .strict();
export const documentCardSchema = z
  .object({
    content: templateLayoutSchema.optional(),
    image: z.enum(["cover", "none"]).default("cover"),
    imageAspect: imageAspectSchema.default("square"),
    descriptionLines: z.number().int().min(0).max(4).default(2),
    fields: previewFieldsSchema.max(6).default([]),
  })
  .strict();
export const documentReferenceSchema = z
  .object({
    style: z.enum(["link", "badge"]).default("link"),
  })
  .strict();
export const documentHoverSchema = z
  .object({
    content: templateLayoutSchema.optional(),
    enabled: z.boolean().default(true),
    width: z.enum(["sm", "md", "lg"]).default("md"),
    image: z.enum(["none", "thumbnail", "cover"]).default("thumbnail"),
    imageAspect: imageAspectSchema.default("square"),
    descriptionLines: z.number().int().min(0).max(6).default(5),
    columns: z.union([z.literal(1), z.literal(2)]).default(2),
    fields: previewFieldsSchema.max(8).default([]),
  })
  .strict();
const documentPresentationSchema = z
  .object({
    detail: z
      .discriminatedUnion("type", [
        gridLayoutSchema,
        splitLayoutSchema,
        templateLayoutSchema.extend({ width: z.number().int().min(240).max(1600).optional() }),
      ])
      .optional(),
    displayFields: displayFieldsSchema.optional(),
    list: documentListSchema.optional(),
    card: documentCardSchema.optional(),
    reference: documentReferenceSchema.optional(),
    hover: documentHoverSchema.optional(),
    sheet: templateLayoutSchema
      .extend({ width: z.number().int().min(240).max(960).optional() })
      .optional(),
  })
  .strict();

export type DocumentCardLayout = z.infer<typeof documentCardSchema>;
export type DocumentListLayout = z.infer<typeof documentListSchema>;
export type DocumentHoverLayout = z.infer<typeof documentHoverSchema>;
export const defaultDocumentCard = documentCardSchema.parse({});
export const defaultDocumentList = documentListSchema.parse({});
export const defaultDocumentHover = documentHoverSchema.parse({});
export const defaultDocumentReference = documentReferenceSchema.parse({});
export type DocumentLayout = (
  | GridDocumentLayout
  | SplitDocumentLayout
  | HandlebarsDocumentLayout
) & {
  readonly card?: DocumentCardLayout;
  readonly list?: DocumentListLayout;
  readonly hover?: DocumentHoverLayout;
  readonly reference?: z.infer<typeof documentReferenceSchema>;
  readonly sheet?: TemplateLayout & { readonly width?: number };
  readonly displayFields?: DisplayFields;
};

/** 规范化运行时使用的类型配置；文档格式由扩展名决定。 */
const documentTypeSchema = z
  .object({
    designation: z.enum(["character", "world_state"]).optional(),
    creationFlow: creationFlowSchema.optional(),
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    image: z.string().trim().min(1).optional(),
    displayWhen: z.string().trim().min(1).max(2048).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface DocumentField {
  readonly key: string;
  readonly label: string;
  readonly type: DocumentFieldType;
  readonly required: boolean;
  readonly mutable: boolean;
  readonly visibility: DocumentFieldVisibility;
  readonly hideWhenEmpty?: boolean;
  readonly compute?: string;
  readonly options?: readonly string[];
  readonly targets?: readonly string[];
  readonly item?: DocumentListItem;
  readonly fields?: readonly DocumentField[];
}

export interface InstanceBinding {
  readonly referenceField: string;
  readonly stateField: string;
}

export interface InstanceDefinition {
  readonly fields: readonly DocumentField[];
  readonly display: readonly string[];
}

export interface DocumentListItem {
  readonly instance?: InstanceBinding;
  readonly type: ScalarFieldType | "object";
  readonly options?: readonly string[];
  readonly targets?: readonly string[];
  readonly fields?: readonly DocumentField[];
}

export interface DocumentType {
  readonly id: string;
  readonly name: string;
  readonly designation?: "character" | "world_state";
  readonly creationFlow?: CreationFlow;
  readonly description?: string;
  readonly image?: string;
  readonly displayWhen?: string;
  readonly fields: readonly DocumentField[];
  readonly layout?: DocumentLayout;
}

export interface GridDocumentLayout {
  readonly width?: number;
  readonly type: "grid";
  readonly columns: 1 | 2 | 3 | 4;
  readonly fields: readonly string[];
  readonly fieldViews?: Readonly<Record<string, DocumentFieldViewLayout>>;
  readonly order: readonly DocumentLayoutSection[];
}

export interface SplitDocumentLayout extends Omit<GridDocumentLayout, "type"> {
  readonly type: "split";
  readonly contentFields: readonly string[];
  readonly imageAspect: ImageAspect;
}

export interface HandlebarsDocumentLayout extends TemplateLayout {
  readonly width?: number;
  readonly fields: readonly string[];
  readonly fieldViews?: Readonly<Record<string, DocumentFieldViewLayout>>;
  readonly order: readonly DocumentLayoutSection[];
}

function normalizeListItem(item: z.infer<typeof listItemSchema>, path: string): DocumentListItem {
  if (item.type === "object") {
    const fields = Object.entries(item.fields ?? {}).map(([key, value]) =>
      normalizeField(key, value, `${path}.fields.${key}`),
    );
    if (item.instance) {
      const { referenceField, stateField } = item.instance;
      if (
        ["$instance", "__proto__", "prototype", "constructor"].includes(stateField) ||
        stateField === referenceField ||
        fields.some((field) => field.key === stateField || field.key === "$instance")
      )
        throw new Error(`${path}.instance：stateField 必须是独立的未声明字段`);
      const reference = fields.find((field) => field.key === referenceField);
      if (
        !reference ||
        reference.type !== "reference" ||
        !reference.required ||
        reference.compute !== undefined
      )
        throw new Error(`${path}.instance：referenceField 必须指向必填的原始 reference 字段`);
      fields.push({
        key: stateField,
        label: "实例状态",
        type: "object",
        fields: [],
        required: true,
        mutable: true,
        visibility: reference.visibility,
      });
    }
    return { type: "object", fields, ...(item.instance ? { instance: item.instance } : {}) };
  }
  return {
    type: item.type,
    ...(item.type === "enum" ? { options: item.options } : {}),
    ...(item.type === "reference" ? { targets: item.targets } : {}),
  };
}

function normalizeField(key: string, value: unknown, path: string): DocumentField {
  const parsed = validatedFieldSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const issuePath = issue?.path.join(".");
    throw new Error(
      `${path}${issuePath ? `.${issuePath}` : ""}：${issue?.message ?? "字段定义无效"}`,
    );
  }
  const field = parsed.data;
  const normalized: DocumentField = {
    key,
    label: field.label ?? key,
    type: field.type,
    required: field.required ?? false,
    mutable: field.mutable,
    visibility: field.visibility,
    ...(field.hideWhenEmpty !== undefined ? { hideWhenEmpty: field.hideWhenEmpty } : {}),
    ...(field.compute !== undefined ? { compute: field.compute } : {}),
    ...(field.type === "enum" ? { options: field.options } : {}),
    ...(field.type === "reference" ? { targets: field.targets } : {}),
    ...(field.type === "list" && field.item
      ? { item: normalizeListItem(field.item, `${path}.item`) }
      : {}),
    ...(field.type === "object"
      ? {
          fields: Object.entries(field.fields ?? {}).map(([childKey, childValue]) =>
            normalizeField(childKey, childValue, `${path}.fields.${childKey}`),
          ),
        }
      : {}),
  };
  return normalized;
}

/** 文档类型 ID 由 .types/ 下的 *.fields.json 或 *.fields.toml 文件名决定。 */
export function validateDocumentType(id: string, value: unknown): DocumentType {
  const parsed = documentTypeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "根节点";
    throw new Error(`${id}.${path}：${issue?.message ?? "格式无效"}`);
  }

  const definition = parsed.data;
  if (definition.creationFlow && definition.designation !== "character")
    throw new Error(`${id}：仅角色类型支持创建流程`);
  const fields = Object.entries(definition.fields ?? {}).map(([key, field]) =>
    normalizeField(key, field, `${id}.fields.${key}`),
  );
  for (const field of fields) {
    if (field.key === "computed" || field.key === "instance")
      throw new Error(`${id}.fields.${field.key}：文档顶层 computed 与 instance 为配置保留字段`);
    if (isDocumentMetadataKey(field.key) && field.type !== "text")
      throw new Error(`${id}.fields.${field.key}：内置展示字段必须是 text 类型`);
  }
  const result: DocumentType = {
    id,
    name: definition.name ?? id,
    designation: definition.designation,
    creationFlow: definition.creationFlow,
    description: definition.description,
    image: definition.image,
    displayWhen: definition.displayWhen,
    fields,
  };
  validateDocumentTypeRules(result);
  return result;
}

/** 布局独立存放于 .types/*.layout.json 或 *.layout.toml，仅影响客户端展示。 */
export function validateDocumentLayout(documentType: DocumentType, value: unknown): DocumentLayout {
  const parsed = documentPresentationSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${documentType.id}.layout.${issue?.path.join(".") || "根节点"}：${issue?.message ?? "布局格式无效"}`,
    );
  }
  const config = parsed.data;
  const displayFields = config.displayFields;
  const resolveType: DocumentType = {
    ...documentType,
    fields: [
      ...documentType.fields,
      ...Object.keys(displayFields ?? {}).map((key) =>
        displayFieldDefinition(displayFields, `$display.${key}`)!,
      ),
    ],
  };
  let detail: GridDocumentLayout | SplitDocumentLayout | HandlebarsDocumentLayout;
  if (config.detail?.type === "handlebars") {
    validateTemplateLayout(documentType, config.detail, displayFields);
    detail = {
      ...config.detail,
      fields: [...new Set(templateComponents(config.detail).flatMap(componentFieldPaths))],
      order: ["fields"],
    };
  } else if (config.detail) detail = validateGridDocumentLayout(resolveType, config.detail);
  else
    detail = {
      type: "grid",
      columns: 2,
      fields: documentType.fields
        .filter((field) => !isDocumentMetadataKey(field.key))
        .map((field) => field.key),
      order: defaultDocumentLayoutOrder,
    };
  for (const template of [config.sheet, config.card?.content, config.hover?.content])
    if (template) validateTemplateLayout(documentType, template, displayFields);
  for (const scene of ["list", "card", "hover"] as const) {
    const paths = config[scene]?.fields ?? [];
    if (new Set(paths).size !== paths.length)
      throw new Error(`${documentType.id}.layout.${scene}.fields：字段不能重复`);
    for (const path of paths) {
      if (displayFieldDefinition(displayFields, path)) continue;
      let candidates: readonly DocumentField[] = documentType.fields;
      for (const key of path.split(".")) {
        const field = candidates.find((candidate) => candidate.key === key);
        if (!field)
          throw new Error(`${documentType.id}.layout.${scene}.fields：字段 ${path} 不存在`);
        candidates = field.fields ?? [];
      }
    }
  }
  return {
    ...detail,
    ...(displayFields ? { displayFields } : {}),
    list: config.list ?? defaultDocumentList,
    card: config.card ?? defaultDocumentCard,
    reference: config.reference ?? defaultDocumentReference,
    hover: config.hover ?? defaultDocumentHover,
    ...(config.sheet ? { sheet: config.sheet } : {}),
  };
}

function validateGridDocumentLayout(
  documentType: DocumentType,
  value: unknown,
): GridDocumentLayout | SplitDocumentLayout {
  const parsed = documentLayoutSchema.safeParse(value);
  const id = documentType.id;
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "根节点";
    throw new Error(`${id}.${path}：${issue?.message ?? "布局格式无效"}`);
  }
  const layout = parsed.data;
  const resolveField = (path: string): DocumentField => {
    const display = documentType.fields.find(
      (field) => field.key === path && path.startsWith("$display."),
    );
    if (display) return display;
    let candidates: readonly DocumentField[] = documentType.fields;
    let found: DocumentField | undefined;
    for (const key of path.split(".")) {
      found = candidates.find((field) => field.key === key);
      if (!found) throw new Error(`${id}.layout：字段 ${path} 不存在`);
      candidates = found.fields ?? [];
    }
    if (!found) throw new Error(`${id}.layout：字段 ${path} 不存在`);
    return found;
  };
  const allFields =
    layout.type === "split" ? [...layout.fields, ...layout.contentFields] : layout.fields;
  if (new Set(allFields).size !== allFields.length) {
    throw new Error(`${id}.layout.fields：字段不能重复`);
  }
  for (const path of allFields) resolveField(path);
  for (const [path, config] of Object.entries(layout.fieldViews ?? {})) {
    if (!allFields.includes(path))
      throw new Error(`${id}.layout.fieldViews：字段 ${path} 未列入布局`);
    let fields: readonly DocumentField[] = documentType.fields;
    for (const key of path.split(".")) {
      const field = fields.find((candidate) => candidate.key === key);
      if (!field || field.visibility !== "public")
        throw new Error(`${id}.layout.fieldViews：字段 ${path} 不是公开字段`);
      fields = field.fields ?? [];
    }
    try {
      validateDocumentFieldView(resolveField(path), config);
    } catch (error) {
      throw new Error(
        `${id}.layout.fieldViews.${path}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const rawOrder = layout.order ?? defaultDocumentLayoutOrder;
  if (new Set(rawOrder).size !== rawOrder.length) {
    throw new Error(`${id}.layout.order：展示区块不能重复`);
  }
  const order = [...rawOrder];
  return {
    ...layout,
    order,
  };
}

/** 按文档类型校验一份内容的字段值；未声明的字段原样保留。 */
export function validateDocumentValues(
  documentType: DocumentType,
  values: unknown,
): Record<string, unknown> {
  documentType = resolveDocumentComputations(
    documentType,
    values && typeof values === "object" && !Array.isArray(values)
      ? (values as { computed?: DocumentComputations }).computed
      : undefined,
  );
  const shape: Record<string, z.ZodType> = {};
  for (const field of documentType.fields) {
    shape[field.key] = fieldValueSchema(field, documentType.id);
  }

  const parsed = z.object(shape).passthrough().safeParse(values);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "根节点";
    throw new Error(`${documentType.id}.${path}：${issue?.message ?? "字段值无效"}`);
  }
  const result = parsed.data;
  if (Object.hasOwn(result, "instance")) normalizeInstanceDefinition(result.instance);
  if (Object.hasOwn(result, "creation")) validateCreationDocument(documentType, result.creation);
  validateDocumentLayoutValues(documentType, result, "source");
  return result;
}

/** 原始字段与计算字段共用行标识约束；合法 null 结果没有表格行可校验。 */
export function validateDocumentLayoutValues(
  type: DocumentType,
  values: Record<string, unknown>,
  phase: "source" | "resolved" = "resolved",
): void {
  const views: [string, DocumentFieldViewLayout][] = Object.entries(type.layout?.fieldViews ?? {});
  for (const [path, config] of views) {
    if (config.type !== "FieldTable") continue;
    const value = readDocumentPath(values, path);
    if (phase === "resolved" && value === null) continue;
    if (phase === "source") {
      const field = getPublicDocumentField(type.fields, path);
      if (field?.item?.fields?.find((child) => child.key === config.rowKey)?.compute !== undefined)
        continue;
    }
    try {
      validateFieldTableRows(value, config);
    } catch (error) {
      throw new Error(
        `${type.id}.${path}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** 序列化后的计算结果按类型校验；名称外允许合法 null，仍拒绝 undefined 和类型错误。 */
export function validateComputedValue(
  documentType: DocumentType,
  field: DocumentField,
  value: unknown,
): unknown {
  const metadata = documentType.fields.includes(field) && isDocumentMetadataKey(field.key);
  const schema = metadata
    ? field.key === "name"
      ? z.string().refine((text) => text.trim().length > 0, "名称不能为空")
      : z.string().nullable()
    : fieldValueSchema({ ...field, required: true }, documentType.id, {
        phase: "resolved",
      }).nullable();
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${documentType.id}.${field.key}：计算结果无效：${issue?.message ?? "类型不匹配"}`,
    );
  }
  return parsed.data;
}

/** 具体引用文档拥有实例规则，不能在实例中再次绑定实例或覆盖公式。 */
export function normalizeInstanceDefinition(value: unknown): InstanceDefinition {
  const source = z
    .object({
      fields: z.record(z.string(), z.unknown()),
      display: z.array(z.string().min(1)).max(8).default([]),
    })
    .strict()
    .parse(value);
  const fields = Object.entries(source.fields).map(([key, field]) =>
    normalizeField(key, field, `instance.fields.${key}`),
  );
  const visit = (fields: readonly DocumentField[]) => {
    for (const field of fields) {
      if (["__proto__", "prototype", "constructor", "computed", "$instance"].includes(field.key))
        throw new Error(`实例字段使用保留名称：${field.key}`);
      if (field.item?.instance) throw new Error("实例定义不支持递归实例绑定");
      visit(field.fields ?? field.item?.fields ?? []);
    }
  };
  visit(fields);
  if (new Set(source.display).size !== source.display.length)
    throw new Error("instance.display 字段不能重复");
  for (const key of source.display) {
    const field = fields.find((field) => field.key === key);
    if (
      !field ||
      field.visibility !== "public" ||
      !["text", "number", "boolean", "enum"].includes(field.type)
    )
      throw new Error(`instance.display 必须指向公开的标量字段：${key}`);
  }
  return { fields, display: source.display };
}
