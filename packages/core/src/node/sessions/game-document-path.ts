import { lstatSync } from "node:fs";
import { dirname } from "node:path";

import { documentIdentity, documentTypeId } from "@tarp/module/document-path";
import type { DocumentType } from "@tarp/module/document-type";

import { overlayEntries, overlayPath } from "./game-overlay";

export function normalizeGamePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) throw new Error("游戏文件路径不能为空");
  if (normalized.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("游戏文件路径无效");
  return normalized;
}

function documentType(path: string, types: readonly DocumentType[]): DocumentType | undefined {
  return types.find((type) => type.id === documentTypeId(path));
}

/** 新文档只使用 JSON；输入格式扩展名不参与文档身份。 */
export function newGameDocumentPath(value: string, types: readonly DocumentType[]): string {
  const path = normalizeGamePath(value);
  if (!documentType(path, types))
    throw new Error("游戏文档须位于已注册类型的一级目录下，可带 .json/.toml/.md");
  return `${documentIdentity(path)}.json`;
}

/** 所有文档入口先解析唯一实际路径；同名多格式不建立精确匹配优先级。 */
export function resolveGameDocumentPath(
  root: string,
  value: string,
  types: readonly DocumentType[],
): string | undefined {
  const path = normalizeGamePath(value);
  if (!documentType(path, types)) return undefined;
  // 核验输入路径，不能因别名解析而绕过符号链接或目录检查。
  try {
    const actual = overlayPath(root, path);
    if (!lstatSync(actual).isFile()) throw new Error("只能读取普通游戏文档");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const identity = documentIdentity(path);
  const directory = dirname(path) === "." ? "" : dirname(path);
  let entries;
  try {
    entries = overlayEntries(root, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /\.(json|toml|md)$/iu.test(entry.name))
    .map((entry) => (directory ? `${directory}/${entry.name}` : entry.name))
    .filter((candidate) => documentIdentity(candidate) === identity);
  if (candidates.length > 1)
    throw new Error(`文档路径不唯一：${identity}；同名多格式冲突：${candidates.join("、")}`);
  const resolved = candidates[0];
  if (resolved) overlayPath(root, resolved);
  return resolved;
}
