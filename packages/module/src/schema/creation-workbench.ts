import { z } from "zod";

import type { CharacterDraft } from "./character";
import { fieldValueSchema } from "./document-field-values";
import { documentIdentity, sameDocumentIdentity } from "./document-path";
import type { DocumentType, DocumentField } from "./document-type";
import type { ModuleDocument } from "./module-document";

const safeKey = z
  .string()
  .min(1)
  .max(200)
  .refine((v) =>
    v.split(".").every((k) => k && !["__proto__", "prototype", "constructor"].includes(k)),
  );
const die = z.object({
  count: z.number().int().min(1).max(20),
  sides: z.number().int().min(2).max(1000),
  modifier: z.number().int().default(0),
});
export const creationTaskSchema = z
  .object({
    id: safeKey,
    title: z.string().min(1),
    kind: z.enum([
      "input",
      "choice",
      "reference",
      "roll",
      "table",
      "document",
      "grant",
      "purchase",
    ]),
    bind: safeKey.optional(),
    mode: z.enum(["set", "add", "append"]).default("set"),
    value: z.unknown().optional(),
    dice: die.optional(),
    table: z.string().optional(),
    source: safeKey.optional(),
    optionTypeId: z.string().optional(),
    options: z
      .array(z.string().trim().min(1))
      .refine((options) => new Set(options).size === options.length, "选项不能重复")
      .optional(),
    required: z.boolean().default(true),
    private: z.boolean().default(false),
    budget: z.number().finite().min(0).optional(),
    spendAll: z.boolean().default(false),
    currency: z.string().trim().min(1).optional(),
  })
  .strict();
export type CreationTask = z.infer<typeof creationTaskSchema>;
/** 文档声明显式任务、普通选项或表项，平台不推断字段用途。 */
export const creationDataSchema = z
  .object({
    tasks: z.array(creationTaskSchema).default([]),
    options: z.array(z.string().trim().min(1)).default([]),
    entries: z
      .array(
        z
          .object({
            text: z.string(),
            price: z.number().finite().min(0).optional(),
            tasks: z.array(creationTaskSchema).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type CreationData = z.infer<typeof creationDataSchema>;
export const workbenchSchema = z
  .object({
    stages: z
      .array(
        z
          .object({
            id: safeKey,
            title: z.string().trim().min(1),
            tasks: z.array(creationTaskSchema),
          })
          .strict(),
      )
      .min(1),
    swap: z.array(safeKey).default([]),
  })
  .strict();
export type Workbench = z.infer<typeof workbenchSchema>;
export const creationAnswerSchema = z
  .json()
  .refine((value) => JSON.stringify(value).length <= 10000, "建卡输入过大");
export type CreationAnswer = z.infer<typeof creationAnswerSchema>;

/** 解析声明路径，同时继承父对象的私密性；计算字段及其子字段不允许建卡写入。 */
export function creationField(type: DocumentType, path: string): DocumentField | undefined {
  if (["name", "description"].includes(path) && !type.fields.some((field) => field.key === path))
    return {
      key: path,
      label: path === "name" ? "姓名" : "简介",
      type: "text",
      required: path === "name",
      visibility: "public",
      mutable: false,
    };
  let fields: readonly DocumentField[] | undefined = type.fields;
  let result: DocumentField | undefined;
  let privateField = false;
  for (const key of path.split(".")) {
    result = fields?.find((field) => field.key === key);
    if (!result || result.compute !== undefined) return undefined;
    privateField ||= result.visibility !== "public";
    fields = result.fields;
  }
  return result ? { ...result, visibility: privateField ? "gm" : "public" } : undefined;
}
function taskField(type: DocumentType, task: CreationTask): DocumentField | undefined {
  const field = task.bind ? creationField(type, task.bind) : undefined;
  if (field && task.mode === "append" && field.item)
    return {
      key: field.key,
      label: field.label,
      mutable: false,
      visibility: field.visibility,
      required: true,
      ...field.item,
    };
  return field;
}
/** 工作台控件只接收字段结构，不下发计算脚本。 */
function inputField(field: DocumentField, allowPrivate: boolean): DocumentField {
  const { compute: _compute, ...rest } = field;
  return {
    ...rest,
    ...(field.fields
      ? {
          fields: field.fields
            .filter(
              (child) =>
                child.compute === undefined && (allowPrivate || child.visibility === "public"),
            )
            .map((child) => inputField(child, allowPrivate)),
        }
      : {}),
    ...(field.item?.fields
      ? {
          item: {
            ...field.item,
            fields: field.item.fields
              .filter(
                (child) =>
                  child.compute === undefined && (allowPrivate || child.visibility === "public"),
              )
              .map((child) => inputField(child, allowPrivate)),
          },
        }
      : {}),
  };
}
const creationRecordSchema = z.strictObject({
  dice: z.array(z.number().int().positive()),
  total: z.number().finite(),
});
export type CreationRecord = z.infer<typeof creationRecordSchema>;
export const creationProgressSchema = z.strictObject({
  stage: z.number().int().nonnegative(),
  visited: z.number().int().nonnegative(),
  answers: z.record(z.string(), creationAnswerSchema),
  rolls: z.record(z.string(), creationRecordSchema),
  swap: z.tuple([z.string(), z.string()]).optional(),
  requests: z.array(z.string()),
});
export type CreationProgress = z.infer<typeof creationProgressSchema>;
export interface CreationItem {
  key: string;
  title: string;
  kind: CreationTask["kind"];
  stage: number;
  options: { value: string; label: string; body?: string }[];
  answer?: CreationAnswer;
  field?: DocumentField;
  error?: string;
  result?: unknown;
  record?: CreationRecord;
  source?: string;
  missing: boolean;
  private: boolean;
  budget?: number;
  spendAll?: boolean;
  currency?: string;
}
export interface WorkbenchView {
  stages: { id: string; title: string; complete: boolean }[];
  items: CreationItem[];
  draft: CharacterDraft;
  swap: { path: string; label: string }[];
  missing: string[];
}
export const newCreationProgress = (): CreationProgress => ({
  stage: 0,
  visited: 0,
  answers: {},
  rolls: {},
  requests: [],
});
const identity = (d: ModuleDocument) => documentIdentity(d.path);
function get(values: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      values,
    );
}
function put(
  values: Record<string, unknown>,
  path: string,
  value: unknown,
  mode: CreationTask["mode"],
) {
  safeKey.parse(path);
  const keys = path.split(".");
  let target = values;
  for (const key of keys.slice(0, -1)) {
    const child = (target[key] ??= {});
    if (typeof child !== "object" || Array.isArray(child))
      throw new Error(`字段父路径不是对象：${path}`);
    target = child as Record<string, unknown>;
  }
  const k = keys.at(-1)!;
  if (mode === "add") {
    const current = target[k] ?? 0;
    if (
      typeof current !== "number" ||
      typeof value !== "number" ||
      !Number.isFinite(current + value)
    )
      throw new Error(`数字累加结果无效：${path}`);
    target[k] = current + value;
  } else if (mode === "append")
    target[k] = [
      ...(Array.isArray(target[k]) ? (target[k] as unknown[]) : []),
      structuredClone(value),
    ];
  else target[k] = structuredClone(value);
}

type CreationGenerator = { stage: number; random: (sides: number) => number };

interface EvaluationContext {
  readonly type: DocumentType;
  readonly values: Record<string, unknown>;
  readonly items: CreationItem[];
  readonly documents: readonly ModuleDocument[];
  readonly progress: CreationProgress;
  readonly generate?: CreationGenerator;
  readonly find: (reference: string) => ModuleDocument | undefined;
}

interface TaskFrame {
  readonly key: string;
  readonly stage: number;
  readonly ancestry: string[];
  readonly reference?: string;
  readonly document?: ModuleDocument;
  readonly isPrivate: boolean;
}

function rollTask(
  context: EvaluationContext,
  task: CreationTask,
  data: CreationData | undefined,
  frame: TaskFrame,
): { result?: unknown; missing: boolean } {
  if (task.kind === "table" && !data?.entries.length)
    throw new Error(`随机表不存在或为空：${frame.reference}`);
  const dice =
    task.kind === "table" ? { count: 1, sides: data!.entries.length, modifier: 0 } : task.dice;
  if (!dice) throw new Error(`缺少骰子配置：${task.title}`);
  if (!context.progress.rolls[frame.key] && context.generate?.stage === frame.stage) {
    const rolled = Array.from({ length: dice.count }, () => context.generate!.random(dice.sides));
    context.progress.rolls[frame.key] = {
      dice: rolled,
      total: rolled.reduce((total, value) => total + value, dice.modifier),
    };
  }
  const record = context.progress.rolls[frame.key];
  if (!record) return { missing: true };
  const result = task.kind === "table" ? data!.entries[record.total - 1]?.text : record.total;
  if (result === undefined) throw new Error("随机表结果超出范围");
  return { result, missing: false };
}

function purchaseSelection(answer: CreationAnswer | undefined): Record<string, number> {
  try {
    return z
      .record(z.string().regex(/^(0|[1-9]\d*)$/u), z.number().int().min(0).max(100))
      .parse(answer ?? {});
  } catch {
    throw new Error("物品数量无效");
  }
}

function applyPurchase(
  context: EvaluationContext,
  task: CreationTask,
  answer: CreationAnswer | undefined,
  data: CreationData | undefined,
  frame: TaskFrame,
): { options: CreationItem["options"]; missing: boolean } {
  if (!data?.entries.length || task.budget === undefined) throw new Error("物品预算配置无效");
  const options = data.entries.map((entry, index) => ({
    value: String(index),
    label: `${entry.text} · 价格 ${entry.price}`,
  }));
  const selected = purchaseSelection(answer);
  let spent = 0;
  for (const [index, count] of Object.entries(selected)) {
    const entry = data.entries[Number(index)];
    if (entry?.price === undefined) throw new Error("物品选项无效");
    spent += count * entry.price;
  }
  const difference = spent - task.budget;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(spent), Math.abs(task.budget)) * 8;
  if (!Number.isFinite(spent) || difference > tolerance) throw new Error("超出物品预算");
  for (const [index, count] of Object.entries(selected))
    for (let occurrence = 0; occurrence < count; occurrence++)
      applyTasks(
        context,
        data.entries[Number(index)].tasks,
        `${frame.key}/${index}/${occurrence}`,
        frame.stage,
        [...frame.ancestry, frame.reference!],
        frame.document!.path,
        frame.isPrivate,
      );
  return {
    options,
    missing: answer === undefined || (task.spendAll && Math.abs(difference) > tolerance),
  };
}

function applyTasks(
  context: EvaluationContext,
  tasks: CreationTask[],
  prefix: string,
  stage: number,
  ancestry: string[] = [],
  source?: string,
  inheritedPrivate = false,
): void {
  if (ancestry.length > 12 || context.items.length > 500) throw new Error("建卡规则嵌套过深");
  for (const task of tasks)
    applyTask(context, task, prefix, stage, ancestry, source, inheritedPrivate);
}

function applyTask(
  context: EvaluationContext,
  task: CreationTask,
  prefix: string,
  stage: number,
  ancestry: string[],
  source: string | undefined,
  inheritedPrivate: boolean,
): void {
  const key = `${prefix}/${task.id}`;
  if (context.items.some((item) => item.key === key)) throw new Error(`建卡步骤重复：${key}`);
  const isPrivate = inheritedPrivate || task.private;
  const answer = context.progress.answers[key];
  const reference = task.source ? String(get(context.values, task.source) ?? "") : task.table;
  const document = reference ? context.find(reference) : undefined;
  const data =
    document && ["document", "choice", "table", "purchase"].includes(task.kind)
      ? creationDataSchema.parse(document.values?.creation)
      : undefined;
  const frame: TaskFrame = { key, stage, ancestry, reference, document, isPrivate };
  let options: CreationItem["options"] = (task.options ?? []).map((value) => ({
    value,
    label: value,
  }));
  let result: unknown;
  let missing = false;
  let error: string | undefined;
  const field = taskField(context.type, task);
  const editableField = field ? inputField(field, isPrivate) : undefined;

  if (task.kind === "reference")
    options = context.documents
      .filter((item) => item.valid && item.docType === task.optionTypeId)
      .map((item) => ({ value: identity(item), label: item.title, body: item.body }));
  if (task.kind === "choice" && task.source)
    options = (data?.options ?? []).map((value) => ({ value, label: value }));

  if (task.kind === "roll" || task.kind === "table") {
    ({ result, missing } = rollTask(context, task, data, frame));
  } else if (task.kind === "input") {
    if (!field) throw new Error(`${task.title}：输入没有有效的绑定字段`);
    const parsed = fieldValueSchema({ ...editableField!, required: true }, context.type.id, {
      strict: true,
    }).safeParse(answer === null ? undefined : answer);
    missing = !parsed.success;
    if (parsed.success) result = parsed.data;
    else if (answer !== undefined && answer !== null) error = parsed.error.issues[0]?.message;
  } else if (task.kind === "choice" || task.kind === "reference") {
    missing = typeof answer !== "string" || !options.some((option) => option.value === answer);
    if (!missing) result = answer;
  } else if (task.kind === "purchase") {
    ({ options, missing } = applyPurchase(context, task, answer, data, frame));
  } else if (task.kind === "grant") {
    result = task.source ? get(context.values, task.source) : task.value;
    missing = result === undefined;
  } else if (task.kind === "document") {
    missing = !data;
  }

  context.items.push({
    key,
    title: task.title,
    kind: task.kind,
    stage,
    options,
    answer,
    field: task.kind === "input" ? editableField : undefined,
    error,
    result,
    record: context.progress.rolls[key],
    source: document?.path ?? source,
    missing: missing && (task.required || error !== undefined),
    private: isPrivate,
    budget: task.budget,
    spendAll: task.spendAll,
    currency: task.currency,
  });
  if (result !== undefined && task.bind) {
    if (!field) throw new Error(`${task.title}：绑定字段无效`);
    const resultField = task.kind === "input" ? editableField! : field;
    const parsed = fieldValueSchema({ ...resultField, required: true }, context.type.id, {
      strict: true,
    }).safeParse(result);
    if (!parsed.success)
      throw new Error(`${task.title}：结果类型不匹配：${parsed.error.issues[0]?.message}`);
    if (!isPrivate && containsPrivateValue(resultField, parsed.data))
      throw new Error(`${task.title}：非公开子字段必须由 private 任务单独写入`);
    validateReferences(resultField, parsed.data, context.documents, task.title);
    put(context.values, task.bind, parsed.data, task.mode);
  }

  if (task.kind === "document" && data) {
    if (ancestry.includes(reference!)) throw new Error(`建卡规则循环引用：${reference}`);
    applyTasks(
      context,
      data.tasks,
      `${key}/${reference}`,
      stage,
      [...ancestry, reference!],
      document!.path,
      isPrivate,
    );
  }
  if (task.kind === "table" && result !== undefined) {
    if (ancestry.includes(reference!)) throw new Error(`随机表循环引用：${reference}`);
    const total = context.progress.rolls[key].total;
    applyTasks(
      context,
      data!.entries[total - 1].tasks,
      `${key}/${total}`,
      stage,
      [...ancestry, reference!],
      document!.path,
      isPrivate,
    );
  }
}

function applySwap(config: Workbench, progress: CreationProgress, values: Record<string, unknown>) {
  if (!progress.swap) return;
  const [left, right] = progress.swap;
  if (left === right || !config.swap.includes(left) || !config.swap.includes(right))
    throw new Error("只能交换允许的两项属性");
  const leftValue = get(values, left);
  const rightValue = get(values, right);
  if (typeof leftValue !== "number" || typeof rightValue !== "number")
    throw new Error("请先生成属性");
  put(values, left, rightValue, "set");
  put(values, right, leftValue, "set");
}

/** 对持久化的选择与骰值重新求值；从不在读取时生成随机数。 */
export function evaluateCreation(
  config: Workbench,
  progress: CreationProgress,
  documents: readonly ModuleDocument[],
  type: DocumentType,
  generate?: { stage: number; random: (sides: number) => number },
): WorkbenchView {
  const values: Record<string, unknown> = {};
  const items: CreationItem[] = [];
  const find = (ref: string) =>
    documents.find((document) => sameDocumentIdentity(document.path, ref));
  const context: EvaluationContext = { type, values, items, documents, progress, generate, find };
  config.stages.forEach((stage, index) => applyTasks(context, stage.tasks, stage.id, index));
  applySwap(config, progress, values);
  const name = String(values.name ?? "");
  delete values.name;
  const description = String(values.description ?? "");
  delete values.description;
  return {
    stages: config.stages.map((s, i) => ({
      id: s.id,
      title: s.title,
      complete: !items.some((t) => t.stage === i && t.missing),
    })),
    items,
    draft: { typeId: type.id, name, description, values },
    swap: config.swap.map((path) => ({ path, label: creationField(type, path)?.label ?? path })),
    missing: items.filter((item) => item.missing).map((item) => item.title),
  };
}

function containsPrivateValue(field: DocumentField, value: unknown): boolean {
  if (field.visibility !== "public") return true;
  if (field.type === "object" && value && typeof value === "object")
    return (field.fields ?? []).some((child) => {
      const childValue = (value as Record<string, unknown>)[child.key];
      return childValue !== undefined && containsPrivateValue(child, childValue);
    });
  if (field.type === "list" && field.item && Array.isArray(value))
    return value.some((item) => containsPrivateValue({ ...field, ...field.item }, item));
  return false;
}

function validateReferences(
  field: DocumentField,
  value: unknown,
  documents: readonly ModuleDocument[],
  title: string,
): void {
  if (field.type === "reference") {
    const document =
      typeof value === "string"
        ? documents.find((item) => sameDocumentIdentity(item.path, value))
        : undefined;
    if (!document?.valid || !field.targets?.includes(document.docType!))
      throw new Error(`${title}：文档引用不存在或类型不匹配`);
  } else if (field.type === "object" && value && typeof value === "object") {
    for (const child of field.fields ?? []) {
      const childValue = (value as Record<string, unknown>)[child.key];
      if (childValue !== undefined) validateReferences(child, childValue, documents, title);
    }
  } else if (field.type === "list" && field.item && Array.isArray(value)) {
    for (const item of value)
      validateReferences({ ...field, ...field.item }, item, documents, title);
  }
}

/** 建卡执行资料不会出现在普通文档投影中；只有工作台能按归属返回执行结果。 */
export function validateCreationDocument(type: DocumentType, value: unknown): CreationData {
  const data = creationDataSchema.parse(value);
  const creation = type.fields.find((field) => field.key === "creation");
  const tasks = creation?.fields?.find((field) => field.key === "tasks");
  const entries = creation?.fields?.find((field) => field.key === "entries");
  const entryTasks = entries?.item?.fields?.find((field) => field.key === "tasks");
  if (
    creation?.visibility === "public" &&
    ((data.tasks.length > 0 && tasks?.visibility === "public") ||
      (data.entries.some((entry) => entry.tasks.length > 0) &&
        entries?.visibility === "public" &&
        entryTasks?.visibility === "public"))
  )
    throw new Error(`${type.id}：建卡执行任务列表必须设置 visibility = gm`);
  return data;
}

export function validateWorkbench(
  config: Workbench,
  documents: readonly ModuleDocument[],
  type: DocumentType,
  documentTypes: readonly DocumentType[],
) {
  const find = (reference: string) =>
    documents.find((document) => sameDocumentIdentity(document.path, reference));
  const documentData = (document: ModuleDocument) => {
    const definition = documentTypes.find((candidate) => candidate.id === document.docType);
    if (!definition) throw new Error(`${document.title}：建卡资料类型不存在`);
    return validateCreationDocument(definition, document.values?.creation);
  };
  const visit = (tasks: CreationTask[], ancestors: string[], inheritedPrivate = false) => {
    if (ancestors.length > 12) throw new Error("建卡规则嵌套过深");
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
      throw new Error("建卡任务 ID 重复");
    for (const task of tasks) {
      const target = task.bind ? creationField(type, task.bind) : undefined;
      const resultField = taskField(type, task);
      if (task.bind && !target)
        throw new Error(`${task.title}：绑定字段不存在或为计算字段 ${task.bind}`);
      if (["input", "choice", "reference", "roll", "grant"].includes(task.kind) && !task.bind)
        throw new Error(`${task.title}：此任务必须配置 bind`);
      if (task.mode === "append" && target?.type !== "list")
        throw new Error(`${task.title}：追加目标必须是列表`);
      if (task.mode === "add" && target?.type !== "number")
        throw new Error(`${task.title}：累加目标必须是数字`);
      if (target?.visibility === "gm" && !(task.private || inheritedPrivate))
        throw new Error(`${task.title}：非公开目标必须声明 private`);
      if ((task.private || inheritedPrivate) && target?.visibility === "public")
        throw new Error(`${task.title}：秘密结果不能写入公开字段`);
      if (task.kind === "roll" && (!task.dice || resultField?.type !== "number"))
        throw new Error(`${task.title}：骰子必须配置 dice 并绑定数字字段`);
      if (
        task.kind === "reference" &&
        (resultField?.type !== "reference" || !resultField.targets?.includes(task.optionTypeId!))
      )
        throw new Error(`${task.title}：文档选择必须绑定对应引用字段`);
      if (
        task.kind === "reference" &&
        !documents.some((document) => document.valid && document.docType === task.optionTypeId)
      )
        throw new Error(`${task.title}：引用类型没有文档`);
      if (
        (task.kind === "choice" || (task.kind === "table" && task.bind)) &&
        !["text", "enum"].includes(resultField?.type ?? "")
      )
        throw new Error(`${task.title}：选项或表项正文必须绑定文本或枚举字段`);
      if (
        task.kind === "choice" &&
        !task.source &&
        task.options &&
        resultField?.type === "enum" &&
        task.options.some((option) => !resultField.options?.includes(option))
      )
        throw new Error(`${task.title}：选项不属于目标枚举`);
      if (task.kind === "grant") {
        if (!task.source && task.value === undefined)
          throw new Error(`${task.title}：缺少赋值 value 或 source`);
        if (task.source) {
          const source = creationField(type, task.source);
          if (!source) throw new Error(`${task.title}：赋值来源字段不存在`);
          if (source.visibility !== "public" && !(task.private || inheritedPrivate))
            throw new Error(`${task.title}：非公开来源必须声明 private`);
        }
        if (!task.source && resultField) {
          const parsed = fieldValueSchema({ ...resultField, required: true }, type.id, {
            strict: true,
          }).safeParse(task.value);
          if (!parsed.success)
            throw new Error(`${task.title}：赋值类型不匹配：${parsed.error.issues[0]?.message}`);
          if (!(task.private || inheritedPrivate) && containsPrivateValue(resultField, parsed.data))
            throw new Error(`${task.title}：非公开子字段必须由 private 任务单独写入`);
          validateReferences(resultField, parsed.data, documents, task.title);
        }
      }
      if (task.kind === "document" || (task.kind === "choice" && task.source)) {
        const source = task.source && creationField(type, task.source);
        if (!source || source.type !== "reference")
          throw new Error(`${task.title}：来源必须是引用字段`);
        const sources = documents.filter(
          (document) => document.valid && source.targets?.includes(document.docType!),
        );
        if (!sources.length) throw new Error(`${task.title}：来源类型没有文档`);
        for (const document of sources) {
          const reference = identity(document);
          if (ancestors.includes(reference)) throw new Error("建卡文档循环引用");
          const data = documentData(document);
          if (task.kind === "document")
            visit(data.tasks, [...ancestors, reference], inheritedPrivate || task.private);
          else {
            if (!data.options.length) throw new Error(`${document.title}：缺少选项`);
            if (
              resultField?.type === "enum" &&
              data.options.some((option) => !resultField.options?.includes(option))
            )
              throw new Error(`${document.title}：选项不属于目标枚举`);
          }
        }
      } else if (task.kind === "choice" && !task.options?.length)
        throw new Error(`${task.title}：缺少 options 或 source`);
      if (task.kind === "table" || task.kind === "purchase") {
        const document = task.table ? find(task.table) : undefined;
        if (!document?.valid) throw new Error(`${task.title}：表引用不存在`);
        const reference = identity(document);
        if (ancestors.includes(reference)) throw new Error("随机表循环引用");
        const data = documentData(document);
        if (!data.entries.length) throw new Error("随机表不能为空");
        if (
          task.kind === "purchase" &&
          (task.budget === undefined || data.entries.some((entry) => entry.price === undefined))
        )
          throw new Error(`${task.title}：采购必须声明预算和每项价格`);
        for (const entry of data.entries) {
          if (
            task.kind === "table" &&
            task.bind &&
            resultField?.type === "enum" &&
            !resultField.options?.includes(entry.text)
          )
            throw new Error(`${document.title}：表项正文不属于目标枚举`);
          visit(entry.tasks, [...ancestors, reference], inheritedPrivate || task.private);
        }
      }
    }
  };
  if (new Set(config.stages.map((stage) => stage.id)).size !== config.stages.length)
    throw new Error("建卡阶段 ID 重复");
  if (new Set(config.swap).size !== config.swap.length) throw new Error("交换字段不能重复");
  for (const path of config.swap)
    if (creationField(type, path)?.type !== "number")
      throw new Error(`交换字段必须是可填写的数字：${path}`);
  config.stages.forEach((stage) => visit(stage.tasks, []));
}
