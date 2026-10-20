import {
  resolveDocumentComputations,
  type DocumentData,
  type DocumentComputations,
} from "./document-computations";
import { fieldValueSchema } from "./document-field-values";
import { readDocumentPath } from "./document-field-values";
import type { DocumentField, DocumentType } from "./document-type";
import { validateComputedValue, validateDocumentLayoutValues } from "./document-type";
import { validateFieldTableRows, type FieldTableLayout } from "./field-table";
import {
  hasInstanceBindings,
  resolveInstanceDefinition,
  validateInstanceState,
} from "./instance-state";

function nestedFields(field: DocumentField): readonly DocumentField[] {
  return field.type === "object"
    ? (field.fields ?? [])
    : field.item?.type === "object"
      ? (field.item.fields ?? [])
      : [];
}

function fieldsHaveComputations(fields: readonly DocumentField[]): boolean {
  return fields.some(
    (field) =>
      field.compute !== undefined ||
      field.item?.instance !== undefined ||
      fieldsHaveComputations(nestedFields(field)),
  );
}

export function hasComputedFields(type: DocumentType, computed?: DocumentComputations): boolean {
  type = resolveDocumentComputations(type, computed);
  return type.displayWhen !== undefined || fieldsHaveComputations(type.fields);
}

export interface ComputedDocumentInput extends DocumentData {
  readonly identity: string;
  readonly documentType: DocumentType;
}

export interface ComputedDocumentResult {
  readonly values: Record<string, unknown>;
  readonly visible: boolean;
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

/** 解析器只提供同一快照中的已声明引用；同一目标返回同一输入对象。 */
export type ComputedReferenceResolver = (
  owner: ComputedDocumentInput,
  reference: string,
) => ComputedDocumentInput | null;

interface FieldSpec {
  type: DocumentType;
  field: DocumentField;
  condition?: boolean;
  key: string;
  compute?: string;
  children: FieldSpec[];
  table?: FieldTableLayout;
  visibility?: string;
  label?: string;
  hideWhenEmpty?: boolean;
  summaryOrder?: number;
  instance?: { referenceField: string; stateField: string };
  definitionReference?: string;
  rows?: FieldSpec[][];
}
interface PreparedSource {
  fields: FieldSpec[];
  condition?: FieldSpec;
}
type View = Record<string, unknown>;
interface Owner {
  input: ComputedDocumentInput;
  identity: string;
  raw: View;
  self: View;
  condition?: View;
}
interface CompiledField extends FieldSpec {
  run?: (context: View) => unknown;
  error?: unknown;
  children: CompiledField[];
  rows?: CompiledField[][];
}
interface Cell {
  field: CompiledField;
  owner: Owner;
  path: string;
  state: 0 | 1 | 2 | 3;
  value?: unknown;
  error?: unknown;
  dependents: Set<Cell>;
}

/** 编译器按文档批次注入；客户端可在隔离环境中执行，调度与字段语义保持共用。 */
export type ExpressionCompiler = (
  expression: string,
) => (context: Record<string, unknown>) => unknown;

// Node 校验入口的默认编译器；客户端 Worker 显式注入 SES，不能回退到此入口。
const expressionCache = new Map<string, (context: View) => unknown>();
function compileExpression(expression: string): (context: View) => unknown {
  let run = expressionCache.get(expression);
  if (!run) {
    run = new Function(
      "$context",
      `with ($context) { return (function () { "use strict"; return (${expression}); }).call(undefined); }`,
    ) as (context: View) => unknown;
    if (expressionCache.size >= 256) expressionCache.delete(expressionCache.keys().next().value!);
    expressionCache.set(expression, run);
  }
  return run;
}
const helpers = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  sqrt: Math.sqrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  clamp: (value: number, low: number, high: number) => Math.min(Math.max(value, low), high),
  sum: (list: unknown[], select: (value: unknown) => number = (value) => value as number): number =>
    list.reduce<number>((total, value) => total + select(value), 0),
  avg: (list: unknown[], select: (value: unknown) => number = (value) => value as number) =>
    list.length ? helpers.sum(list, select) / list.length : null,
  count: (list: unknown[], predicate: (value: unknown) => unknown = (value) => value != null) =>
    list.filter(predicate).length,
};
function readonly(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) readonly(child);
  return Object.freeze(value);
}
function computationValue(value: unknown): unknown {
  const json = JSON.stringify(value, (_, child) => {
    if (typeof child === "number" && !Number.isFinite(child))
      throw new Error("计算结果包含非有限数值（NaN 或 Infinity）");
    return child;
  });
  return json === undefined ? undefined : JSON.parse(json);
}

/** 每个根入口独立维护字段单元；引用图可以有环，实际字段求值环才失败。 */
function evaluateProgram(
  input: ComputedDocumentInput,
  describeSource: (input: ComputedDocumentInput) => PreparedSource,
  resolveReference: ComputedReferenceResolver,
  selected: readonly string[] | undefined,
  strict: boolean,
  checkVisibility: boolean,
  compiler: ExpressionCompiler,
): ComputedDocumentResult & { error?: string } {
  const generatedFields = new WeakMap<View, Set<string>>();
  const cellsByView = new WeakMap<View, Map<string, Cell>>();
  const instanceEntries = new WeakMap<
    View,
    { binding: NonNullable<FieldSpec["instance"]>; fields: CompiledField[] }
  >();
  const evaluatedCells: Cell[] = [],
    documents = new Map<ComputedDocumentInput, Owner>();
  let active: Cell | undefined;
  const compileFields = (fields: FieldSpec[]): CompiledField[] =>
    fields.map((field) => {
      let run: CompiledField["run"], error: unknown;
      if (field.compute !== undefined) {
        try {
          run = compiler(field.compute);
        } catch (failure) {
          error = failure;
        }
      }
      return {
        ...field,
        run,
        error,
        children: compileFields(field.children),
        rows: field.rows?.map(compileFields),
      };
    });
  const invalidate = (cell: Cell, error: unknown): void => {
    if (cell.state === 3) return;
    cell.state = 3;
    cell.error = error;
    for (const dependent of cell.dependents) invalidate(dependent, error);
  };
  const validationValue = (value: unknown, fields: CompiledField[]): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((child) => validationValue(child, fields));
    const generated = generatedFields.get(value as View);
    const result: View = {};
    for (const key of Object.keys(value)) {
      const field = fields.find((field) => field.key === key);
      if (field?.compute !== undefined && generated?.has(key)) continue;
      Object.defineProperty(result, key, {
        value: validationValue((value as View)[key], field?.children ?? []),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  const prepareValue = (
    value: unknown,
    field: CompiledField | undefined,
    owner: Owner,
    path: string,
    definitionReference?: string,
  ): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value))
      return Object.freeze(
        value.map((child, index) =>
          prepareObject(
            child,
            field?.rows?.[index] ?? field?.children ?? [],
            owner,
            `${path}[${index}]`,
            undefined,
            definitionReference,
            field?.instance,
          ),
        ),
      );
    return prepareObject(
      value,
      field?.children ?? [],
      owner,
      path,
      undefined,
      field?.definitionReference ?? definitionReference,
    );
  };
  const prepareObject = (
    source: unknown,
    fields: CompiledField[],
    owner: Owner,
    path = "",
    itemOverride?: View,
    definitionReference?: string,
    binding?: FieldSpec["instance"],
  ): unknown => {
    if (source === null || typeof source !== "object") return source;
    if (Array.isArray(source)) return prepareValue(source, undefined, owner, path);
    const raw = source as View;
    const view: View = Object.create(null),
      definitions = new Map(fields.map((field) => [field.key, field]));
    const cells = new Map<string, Cell>();
    cellsByView.set(view, cells);
    if (binding)
      instanceEntries.set(view, {
        binding,
        fields: fields.find((field) => field.key === binding.stateField)!.children,
      });
    generatedFields.set(
      view,
      new Set(fields.filter((field) => field.compute !== undefined).map((field) => field.key)),
    );
    const present = new Set([
      ...Object.keys(raw),
      ...fields.filter((field) => field.compute !== undefined).map((field) => field.key),
    ]);
    for (const key of present) {
      const field = definitions.get(key),
        fieldPath = path ? `${path}.${key}` : key;
      if (field?.compute === undefined && !field?.table) {
        view[key] = prepareValue(raw[key], field, owner, fieldPath, definitionReference);
        continue;
      }
      const cell: Cell = { field: field!, owner, path: fieldPath, state: 0, dependents: new Set() };
      evaluatedCells.push(cell);
      cells.set(key, cell);
      Object.defineProperty(view, key, {
        enumerable: true,
        get() {
          if (active && active !== cell) cell.dependents.add(active);
          if (cell.state === 3) {
            if (active) invalidate(active, cell.error);
            throw cell.error;
          }
          if (cell.state === 2) return cell.value;
          if (cell.state === 1) {
            invalidate(cell, new Error(`${owner.identity}:${fieldPath} 存在循环依赖`));
            throw cell.error;
          }
          const previousActive = active;
          active = cell;
          cell.state = 1;
          const load = (reference: unknown): View | null => {
            if (typeof reference !== "string") return null;
            try {
              const target = resolveReference(owner.input, reference);
              return target ? prepareDocument(target).self : null;
            } catch (error) {
              invalidate(cell, error);
              throw error;
            }
          };
          const context = Object.assign(Object.create(null), helpers, {
            $raw: owner.raw,
            $self: owner.self,
            $item: itemOverride ?? view,
            load,
          });
          Object.defineProperty(context, "$definition", {
            get: () => (definitionReference ? load(definitionReference) : undefined),
          });
          try {
            if (field?.error) throw field.error;
            let value = field?.run ? field.run(context) : raw[key];
            // 公式即使捕获依赖异常，失效状态仍不可恢复。
            if ((cell.state as number) === 3) throw cell.error;
            if (field?.run) {
              value = computationValue(validationValue(value, field.children));
              if (field.condition) fieldValueSchema(field.field, field.type.id).parse(value);
              else validateComputedValue(field.type, field.field, value);
            }
            cell.value = prepareValue(value, field, owner, fieldPath, definitionReference);
            if ((cell.state as number) === 3) throw cell.error;
            cell.state = 2;
            return cell.value;
          } catch (error) {
            invalidate(cell, error);
            throw cell.error;
          } finally {
            active = previousActive;
          }
        },
      });
    }
    return Object.freeze(view);
  };
  const prepareDocument = (input: ComputedDocumentInput): Owner => {
    const previous = documents.get(input);
    if (previous) return previous;
    const source = describeSource(input);
    const owner: Owner = {
      input,
      identity: input.identity,
      raw: readonly(structuredClone(input.values)) as View,
      self: {},
    };
    documents.set(input, owner);
    owner.self = prepareObject(owner.raw, compileFields(source.fields), owner) as View;
    if (source.condition)
      owner.condition = prepareObject(
        {},
        compileFields([source.condition]),
        owner,
        "",
        owner.self,
      ) as View;
    return owner;
  };
  const readOutput = (view: View, key: string): unknown => {
    const previousActive = active;
    active = undefined;
    try {
      return materialize(view[key]);
    } catch (error) {
      if (cellsByView.get(view)?.get(key)?.state !== 3) throw error;
      return null;
    } finally {
      active = previousActive;
    }
  };
  const materialize = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(materialize);
    const result: View = {};
    for (const key of Object.keys(value))
      Object.defineProperty(result, key, {
        value: readOutput(value as View, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    const instance = instanceEntries.get(value as View);
    if (instance) {
      const { binding, fields } = instance;
      const state = result[binding.stateField] as View | undefined;
      const publicState = (fields: CompiledField[], source: unknown): unknown => {
        if (!source || typeof source !== "object") return source;
        const output: View = {};
        for (const field of fields) {
          if (field.visibility !== "public" || !Object.hasOwn(source, field.key)) continue;
          const child = (source as View)[field.key];
          output[field.key] =
            Array.isArray(child) && field.children.length
              ? child.map((row) => publicState(field.children, row))
              : field.children.length
                ? publicState(field.children, child)
                : child;
        }
        return output;
      };
      result.$instance = {
        stateField: binding.stateField,
        values: publicState(fields, state),
        display: fields
          .filter((field) => field.summaryOrder! >= 0 && field.visibility === "public")
          .sort((a, b) => a.summaryOrder! - b.summaryOrder!)
          .map((field) => ({
            key: field.key,
            label: field.label,
            hideWhenEmpty: field.hideWhenEmpty,
            value: state?.[field.key],
          })),
      };
    }
    return result;
  };
  const root = prepareDocument(input);
  const isVisible = () =>
    !checkVisibility || !root.condition || readOutput(root.condition, "displayWhen") === true;
  const initiallyVisible = isVisible();
  if (selected === undefined) materialize(root.self);
  else if (initiallyVisible) for (const key of selected) readOutput(root.self, key);
  let invalidated: boolean;
  do {
    invalidated = false;
    for (const cell of evaluatedCells) {
      if (cell.state !== 2 || !cell.field.table || cell.value === null) continue;
      try {
        validateFieldTableRows(materialize(cell.value), cell.field.table);
      } catch (error) {
        invalidate(cell, error);
        invalidated = true;
      }
    }
  } while (invalidated);
  const visible = isVisible();
  const values = selected === undefined ? (materialize(root.self) as View) : {};
  if (selected !== undefined && visible)
    for (const key of selected) values[key] = readOutput(root.self, key);
  const failed = strict ? evaluatedCells.find((cell) => cell.state === 3) : undefined;
  const error = failed
    ? `${failed.owner.identity}:${failed.path}：${String(failed.error)}`
    : undefined;
  const fieldErrors: Record<string, string> = {};
  for (const cell of evaluatedCells) {
    if (
      cell.owner === root &&
      cell.state === 3 &&
      cell.path !== "displayWhen" &&
      (selected === undefined ||
        selected.some(
          (key) =>
            cell.path === key || cell.path.startsWith(`${key}.`) || cell.path.startsWith(`${key}[`),
        ))
    )
      fieldErrors[cell.path] = String(cell.error);
  }
  return { values, visible, error, ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}) };
}

/** 求值整体不可继续时保留普通原值，隐藏全部计算字段，不回退计算字段的秘密原值。 */
function hiddenComputedValues(
  values: Record<string, unknown>,
  fields: readonly DocumentField[],
): Record<string, unknown> {
  const result = structuredClone(values);
  for (const field of fields) {
    if (field.compute !== undefined || field.item?.instance) {
      result[field.key] = null;
      continue;
    }
    const value = result[field.key];
    const children = nestedFields(field);
    if (field.type === "object" && value && typeof value === "object" && !Array.isArray(value))
      result[field.key] = hiddenComputedValues(value as Record<string, unknown>, children);
    if (field.type === "list" && field.item?.type === "object" && Array.isArray(value))
      result[field.key] = value.map((entry) => hiddenComputedValues(entry, children));
  }
  return result;
}

/** 一个根入口及实际读取的多级引用共享字段缓存；不同入口独立执行。 */
export async function evaluateComputedFields(
  input: ComputedDocumentInput,
  resolveReference: ComputedReferenceResolver = () => null,
  {
    selectedKeys,
    strict = false,
    checkVisibility = true,
    compiler = compileExpression,
  }: {
    selectedKeys?: readonly string[];
    strict?: boolean;
    checkVisibility?: boolean;
    compiler?: ExpressionCompiler;
  } = {},
): Promise<ComputedDocumentResult> {
  const documentType = resolveDocumentComputations(input.documentType, input.computed);
  const values = input.values;
  if (!hasComputedFields(documentType)) {
    validateDocumentLayoutValues(documentType, values);
    return { values: structuredClone(values), visible: true };
  }
  const describe = (
    type: DocumentType,
    children: readonly DocumentField[],
    parent = "",
    source: Record<string, unknown> = {},
    owner: ComputedDocumentInput = input,
    summary: readonly string[] = [],
  ): FieldSpec[] =>
    children.map((field) => {
      const path = parent ? `${parent}.${field.key}` : field.key;
      const config = type.layout?.fieldViews?.[path];
      const table = config?.type === "FieldTable" ? config : undefined;
      const value = source[field.key];
      const spec: FieldSpec = {
        type,
        field,
        key: field.key,
        compute: field.compute,
        visibility: field.visibility,
        label: field.label,
        hideWhenEmpty: field.hideWhenEmpty,
        summaryOrder: summary.indexOf(field.key),
        children: describe(
          type,
          nestedFields(field),
          path,
          field.type === "object" && value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {},
          owner,
        ),
        table,
      };
      if (
        field.type === "list" &&
        field.item?.type === "object" &&
        Array.isArray(value) &&
        (field.item.instance || hasInstanceBindings(nestedFields(field)))
      ) {
        spec.instance = field.item.instance;
        spec.rows = value.map((row) => {
          const children = describe(type, nestedFields(field), path, row, owner);
          if (field.item?.instance) {
            const binding = field.item.instance;
            const definition = resolveInstanceDefinition(field, row, (reference) =>
              resolveReference(owner, reference),
            );
            validateInstanceState(definition, row[binding.stateField], (reference) =>
              resolveReference(owner, reference),
            );
            const state = children.find((child) => child.key === binding.stateField)!;
            state.children = describe(
              type,
              definition.fields,
              `${path}.${binding.stateField}`,
              row[binding.stateField],
              owner,
              definition.display,
            );
            state.definitionReference = row[binding.referenceField];
          }
          return children;
        });
      }
      return spec;
    });
  const describeSource = (entry: ComputedDocumentInput): PreparedSource => {
    const type =
      entry === input
        ? documentType
        : resolveDocumentComputations(entry.documentType, entry.computed);
    const schema = describe(type, type.fields, "", entry.values, entry);
    let condition: FieldSpec | undefined;
    if (entry === input && checkVisibility && type.displayWhen !== undefined) {
      const field: DocumentField = {
        key: "displayWhen",
        label: "文档显示条件",
        type: "boolean",
        required: true,
        mutable: false,
        visibility: "gm",
        compute: type.displayWhen,
      };
      condition = {
        type,
        field,
        condition: true,
        key: field.key,
        compute: field.compute,
        children: [],
      };
    }
    return { fields: schema, condition };
  };
  const fallback = (message: string): ComputedDocumentResult => {
    const fieldErrors: Record<string, string> = {};
    const collect = (fields: readonly DocumentField[], source: unknown, prefix = "") => {
      for (const field of fields) {
        const path = prefix ? `${prefix}.${field.key}` : field.key;
        if (field.compute !== undefined || field.item?.instance) {
          fieldErrors[path] = message;
          continue;
        }
        const value =
          source && typeof source === "object"
            ? (source as Record<string, unknown>)[field.key]
            : undefined;
        if (field.type === "object" && value && typeof value === "object")
          collect(nestedFields(field), value, path);
        if (field.type === "list" && Array.isArray(value))
          value.forEach((entry, index) => collect(nestedFields(field), entry, `${path}[${index}]`));
      }
    };
    collect(documentType.fields, values);
    const hidden = hiddenComputedValues(values, documentType.fields);
    for (const [path, config] of Object.entries(documentType.layout?.fieldViews ?? {})) {
      if (config.type !== "FieldTable") continue;
      try {
        validateFieldTableRows(readDocumentPath(hidden, path), config);
      } catch {
        const keys = path.split("."),
          key = keys.pop()!;
        const parent = keys.length ? readDocumentPath(hidden, keys.join(".")) : hidden;
        if (parent && typeof parent === "object") (parent as Record<string, unknown>)[key] = null;
        fieldErrors[path] = message;
      }
    }
    return {
      values: selectedKeys
        ? Object.fromEntries(selectedKeys.map((key) => [key, hidden[key]]))
        : hidden,
      visible: !checkVisibility || documentType.displayWhen === undefined,
      ...(Object.keys(fieldErrors).length
        ? {
            fieldErrors: selectedKeys
              ? Object.fromEntries(
                  Object.entries(fieldErrors).filter(([path]) =>
                    selectedKeys.includes(path.split(/[.[]/)[0]),
                  ),
                )
              : fieldErrors,
          }
        : {}),
    };
  };
  let result: ComputedDocumentResult & { error?: string };
  try {
    result = evaluateProgram(
      input,
      describeSource,
      resolveReference,
      selectedKeys,
      strict,
      checkVisibility,
      compiler,
    );
  } catch (error) {
    if (strict)
      throw new Error(
        `计算字段执行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    return fallback(`计算字段执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (strict && result.error) throw new Error(result.error);
  return {
    values: result.values,
    visible: result.visible,
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  };
}
