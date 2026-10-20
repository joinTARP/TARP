import { lstatSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

/** 配置统一转换为 JSON 数据模型，再交给业务 Schema 校验。 */
function assertConfigValue(value: unknown): void {
  if (value instanceof Date) throw new Error("日期时间请使用带引号的字符串");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("配置不能包含非有限数值");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("配置包含不安全字段");
    assertConfigValue(child);
  }
}

export function parseConfig(source: string, filename: string): unknown {
  try {
    const value: unknown = filename.toLowerCase().endsWith(".toml")
      ? parse(source, { unsafeKeyBehaviour: "throw" })
      : JSON.parse(source);
    assertConfigValue(value);
    return filename.toLowerCase().endsWith(".toml")
      ? (JSON.parse(JSON.stringify(value)) as unknown)
      : value;
  } catch (error) {
    throw new Error(
      `${filename}：${filename.toLowerCase().endsWith(".toml") ? "TOML" : "JSON"} 格式无效（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}

/** 同名双格式不设优先级，避免无意读取另一份配置。 */
export function configFilePath(directory: string, stem: string): string | undefined {
  const paths = ["toml", "json"]
    .map((extension) => join(directory, `${stem}.${extension}`))
    .filter((path) => {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error(`配置必须是普通文件：${path}`);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  if (paths.length > 1) throw new Error(`配置冲突：${stem}.json 与 ${stem}.toml 不能同时存在`);
  return paths[0];
}

export function stringifyConfig(value: Record<string, unknown>, path: string): string {
  assertConfigValue(value);
  return path.toLowerCase().endsWith(".toml")
    ? stringify(value)
    : `${JSON.stringify(value, null, 2)}\n`;
}
