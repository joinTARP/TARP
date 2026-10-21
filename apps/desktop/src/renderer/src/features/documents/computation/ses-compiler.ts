import type { DocumentComputationCompiler } from "@tarp/module/document-evaluator";
import type {} from "ses";

const names = [
  "$self",
  "$raw",
  "$item",
  "$definition",
  "load",
  "floor",
  "ceil",
  "round",
  "abs",
  "sqrt",
  "pow",
  "min",
  "max",
  "clamp",
  "sum",
  "avg",
  "count",
] as const;

/** 只在已 lockdown 的计算 Worker 使用；每个根文档创建独立 Compartment。 */
export function createSESCompiler(): DocumentComputationCompiler {
  const compartment = new Compartment();
  const active: Record<string, unknown>[] = [];
  const cache = new Map<string, () => unknown>();
  for (const name of names) {
    Object.defineProperty(compartment.globalThis, name, {
      get: harden(() => active[active.length - 1]?.[name]),
      configurable: false,
    });
  }
  const expression: DocumentComputationCompiler["expression"] = (source) => {
    let run = cache.get(source);
    if (!run) {
      run = compartment.evaluate(`(function () { return (${source}); })`) as () => unknown;
      cache.set(source, run);
    }
    const execute = run;
    return (context) => {
      active.push(harden(context));
      try {
        return execute();
      } finally {
        active.pop();
      }
    };
  };
  return { expression, display: (source) => expression(source)({}) };
}
