import { z } from "zod";

import { fieldValueSchema } from "./document-field-values";
import {
  normalizeInstanceDefinition,
  type DocumentField,
  type DocumentType,
  type InstanceDefinition,
} from "./document-type";

export interface InstanceTarget {
  readonly documentType: DocumentType;
  readonly values: Record<string, unknown>;
}
export type InstanceResolver = (reference: string) => InstanceTarget | null;

export function resolveInstanceDefinition(
  field: DocumentField,
  row: Record<string, unknown>,
  resolve: InstanceResolver,
): InstanceDefinition {
  const binding = field.item!.instance!;
  const reference = row[binding.referenceField];
  const target = typeof reference === "string" ? resolve(reference) : null;
  const referenceField = field.item!.fields!.find((child) => child.key === binding.referenceField)!;
  if (!target || !referenceField.targets?.includes(target.documentType.id))
    throw new Error(`实例引用不存在或类型不匹配：${String(reference)}`);
  if (!Object.hasOwn(target.values, "instance"))
    throw new Error(`引用缺少实例定义：${String(reference)}`);
  return normalizeInstanceDefinition(target.values.instance);
}

export function validateInstanceState(
  definition: InstanceDefinition,
  state: unknown,
  resolve?: InstanceResolver,
): void {
  const shape: Record<string, z.ZodType> = {};
  for (const field of definition.fields)
    shape[field.key] =
      field.compute !== undefined
        ? z.never().optional()
        : fieldValueSchema(field, "instance", { strict: true });
  // 嵌套计算字段也属于系统结果，原始状态中不能填写。
  const rejectComputed = (fields: readonly DocumentField[], value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const field of fields) {
      const child = (value as Record<string, unknown>)[field.key];
      if (field.compute !== undefined && Object.hasOwn(value, field.key))
        throw new Error(`不能保存实例计算结果：${field.key}`);
      if (field.type === "object") rejectComputed(field.fields ?? [], child);
      if (field.type === "list" && Array.isArray(child))
        for (const row of child) rejectComputed(field.item?.fields ?? [], row);
    }
  };
  rejectComputed(definition.fields, state);
  z.object(shape).strict().parse(state);
  if (resolve) {
    const visit = (fields: readonly DocumentField[], values: Record<string, unknown>) => {
      for (const field of fields) {
        const value = values[field.key];
        const checkReference = (value: unknown, targets?: readonly string[]) => {
          if (typeof value !== "string") return;
          const target = resolve(value);
          if (!target || !targets?.includes(target.documentType.id))
            throw new Error("实例状态引用不存在或类型不匹配：" + value);
        };
        if (field.type === "reference") checkReference(value, field.targets);
        if (field.type === "object" && value && typeof value === "object")
          visit(field.fields ?? [], value as Record<string, unknown>);
        if (field.type === "list" && Array.isArray(value))
          for (const row of value) {
            if (field.item?.type === "reference") checkReference(row, field.item.targets);
            if (field.item?.type === "object") visit(field.item.fields ?? [], row);
          }
      }
    };
    visit(definition.fields, state as Record<string, unknown>);
  }
}

/** 每个条目按实际引用校验，不能通过替换列表或容器绕过。 */
export function validateInstanceBindings(
  fields: readonly DocumentField[],
  values: Record<string, unknown>,
  resolve: InstanceResolver,
): void {
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "object" && value && typeof value === "object")
      validateInstanceBindings(field.fields ?? [], value as Record<string, unknown>, resolve);
    if (field.type === "list" && field.item?.type === "object" && Array.isArray(value)) {
      for (const row of value) {
        if (field.item.instance)
          validateInstanceState(
            resolveInstanceDefinition(field, row, resolve),
            row[field.item.instance.stateField],
            resolve,
          );
        validateInstanceBindings(field.item.fields ?? [], row, resolve);
      }
    }
  }
}

/** 运行时指针展开实际条目的状态字段；列表的通用结构保持不变。 */
export function instancePointerType(
  type: DocumentType,
  values: Record<string, unknown>,
  pointer: string,
  resolve: InstanceResolver,
): DocumentType {
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const expand = (
    fields: readonly DocumentField[],
    value: Record<string, unknown>,
    index: number,
  ): readonly DocumentField[] =>
    fields.map((field) => {
      if (field.key !== parts[index]) return field;
      if (field.type === "object")
        return {
          ...field,
          fields: expand(
            field.fields ?? [],
            (value[field.key] as Record<string, unknown>) ?? {},
            index + 1,
          ),
        };
      if (field.type !== "list" || field.item?.type !== "object") return field;
      const rows = value[field.key];
      const row = Array.isArray(rows) ? rows[Number(parts[index + 1])] : undefined;
      if (!row) return field;
      let children = field.item.fields ?? [];
      if (field.item.instance) {
        const definition = resolveInstanceDefinition(field, row, resolve);
        children = children.map((child) =>
          child.key === field.item!.instance!.stateField
            ? { ...child, fields: definition.fields }
            : child,
        );
      }
      return { ...field, item: { ...field.item, fields: expand(children, row, index + 2) } };
    });
  return { ...type, fields: expand(type.fields, values, 0) };
}

/** 容器替换也逐项检查已有实例的字段权限；新持有记录显式填写初值。 */
export function assertInstanceChanges(
  fields: readonly DocumentField[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  resolve: InstanceResolver,
  publicOnly = false,
): void {
  const check = (
    fields: readonly DocumentField[],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    path: string,
  ) => {
    for (const field of fields) {
      const old = before[field.key],
        next = after[field.key];
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      if (
        field.compute !== undefined ||
        !field.mutable ||
        (publicOnly && field.visibility !== "public")
      )
        throw new Error(`实例字段不可修改：${path}.${field.key}`);
      if (field.type === "object")
        check(
          field.fields ?? [],
          (old as Record<string, unknown>) ?? {},
          (next as Record<string, unknown>) ?? {},
          `${path}.${field.key}`,
        );
      if (
        field.type === "list" &&
        field.item?.type === "object" &&
        Array.isArray(old) &&
        Array.isArray(next)
      )
        for (let index = 0; index < Math.max(old.length, next.length); index++)
          check(
            field.item.fields ?? [],
            old[index] ?? {},
            next[index] ?? {},
            `${path}.${field.key}[${index}]`,
          );
    }
  };
  for (const field of fields) {
    const old = before[field.key],
      next = after[field.key];
    if (field.type === "object" && old && next)
      assertInstanceChanges(
        field.fields ?? [],
        old as Record<string, unknown>,
        next as Record<string, unknown>,
        resolve,
        publicOnly,
      );
    if (field.type !== "list" || field.item?.type !== "object" || !Array.isArray(next)) continue;
    for (let index = 0; index < next.length; index++) {
      if (
        Array.isArray(old) &&
        old.some((row) => JSON.stringify(row) === JSON.stringify(next[index]))
      )
        continue;
      const previous = Array.isArray(old) ? old[index] : undefined;
      if (!previous) continue;
      if (field.item.instance) {
        const binding = field.item.instance;
        if (previous[binding.referenceField] !== next[index][binding.referenceField]) continue;
        const definition = resolveInstanceDefinition(field, next[index], resolve);
        check(
          definition.fields,
          previous[binding.stateField] ?? {},
          next[index][binding.stateField] ?? {},
          `${field.key}[${index}].${binding.stateField}`,
        );
      }
      assertInstanceChanges(field.item.fields ?? [], previous, next[index], resolve, publicOnly);
    }
  }
}

export function hasInstanceBindings(fields: readonly DocumentField[]): boolean {
  return fields.some(
    (field) =>
      !!field.item?.instance || hasInstanceBindings(field.fields ?? field.item?.fields ?? []),
  );
}
