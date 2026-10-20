import { publicValues } from "./character";
import type { DocumentType } from "./document-type";
import type { ModuleDocument } from "./module-document";
import { publicFieldErrors } from "./public-document-field";

export interface DisplayProjection {
  readonly displayValues?: Readonly<Record<string, string | number | boolean | null>>;
  readonly displayErrors?: Readonly<Record<string, string>>;
}
/** 在业务求值后执行；显式输入只包含公开数据，不注入业务原值、引用解析或其他展示字段。 */
export async function evaluateDisplayFields(
  type: DocumentType,
  document: ModuleDocument,
  compiler: (expression: string) => unknown = compileDisplay,
): Promise<DisplayProjection> {
  const definitions = Object.entries(type.layout?.displayFields ?? {});
  if (!definitions.length || document.visible === false) return {};
  const values = publicValues(type.fields, { ...document.values });
  for (const [key, value] of Object.entries({
    name: document.title,
    description: document.description,
    image: document.image,
    avatar: document.avatar,
    body: document.body,
  })) {
    const definition = type.fields.find((field) => field.key === key);
    if (!definition && value !== undefined) values[key] = value;
  }
  const errors = publicFieldErrors(type.fields, document.fieldErrors) ?? {};
  const displayValues: Record<string, string | number | boolean | null> = {};
  const displayErrors: Record<string, string> = {};
  for (const [key, definition] of definitions) {
    try {
      let sourceFailed = false;
      const proxies = new WeakMap<object, object>();
      const protect = (value: unknown, path = ""): unknown => {
        if (value === null || typeof value !== "object") return value;
        const previous = proxies.get(value);
        if (previous) return previous;
        const proxy = new Proxy(value, {
          get(target, key, receiver) {
            if (typeof key === "symbol") return Reflect.get(target, key, receiver);
            const next = path
              ? Array.isArray(target) && /^\d+$/.test(key)
                ? `${path}[${key}]`
                : `${path}.${key}`
              : key;
            if (
              Object.keys(errors).some(
                (error) =>
                  next === error || next.startsWith(`${error}.`) || next.startsWith(`${error}[`),
              )
            ) {
              sourceFailed = true;
              throw new Error("来源字段计算失败");
            }
            return protect(Reflect.get(target, key, receiver), next);
          },
          set() {
            throw new Error("展示数据只读");
          },
          deleteProperty() {
            throw new Error("展示数据只读");
          },
          defineProperty() {
            throw new Error("展示数据只读");
          },
          setPrototypeOf() {
            throw new Error("展示数据只读");
          },
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (!descriptor || !descriptor.configurable) return descriptor;
            return {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                return Reflect.get(proxy, key);
              },
            };
          },
        });
        proxies.set(value, proxy);
        return proxy;
      };
      const compute = compiler(definition.compute);
      if (typeof compute !== "function") throw new Error("compute 必须是函数");
      const result = compute(protect(structuredClone(values)));
      if (sourceFailed) throw new Error("来源字段计算失败");
      if (
        result !== null &&
        (typeof result !== (definition.type === "text" ? "string" : definition.type) ||
          (typeof result === "number" && !Number.isFinite(result)))
      )
        throw new Error("展示计算返回类型不匹配");
      displayValues[key] = result;
    } catch {
      displayValues[key] = null;
      displayErrors[key] = "展示计算失败，请检查公式、来源字段和返回类型。";
    }
  }
  return { displayValues, ...(Object.keys(displayErrors).length ? { displayErrors } : {}) };
}

// 只缓存编译器，每次求值重新生成展示函数，避免函数闭包携带上一文档的数据。
const displayCache = new Map<string, () => unknown>();
function compileDisplay(expression: string): unknown {
  let factory = displayCache.get(expression);
  if (!factory) {
    factory = new Function(`"use strict"; return (${expression});`) as () => unknown;
    if (displayCache.size >= 256) displayCache.delete(displayCache.keys().next().value!);
    displayCache.set(expression, factory);
  }
  return factory();
}
