import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { DocumentType } from "@jointarp/module/document-type";
import {
  parseDocumentContent,
  parseStructuredDocument,
  stringifyDocumentContent,
  stringifyStructuredDocument,
} from "@jointarp/module/node/document-codec";
import { cloneDeep, isEqual, isPlainObject, mergeWith } from "es-toolkit";
import { z } from "zod";

import { applyPointer, assertMutablePointer } from "./game-pointers";

export const moduleRoot = (root: string) => join(dirname(root), "module");
const patchSchema = z
  .object({
    $overlay: z.literal(1),
    values: z.record(z.string(), z.unknown()),
    removed: z.array(z.string()),
  })
  .strict();
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** 不吞掉链接或损坏文件错误；只有确实不存在才回退。 */
export function layerPath(root: string, path: string): string | undefined {
  const base = realpathSync(root);
  if (lstatSync(root).isSymbolicLink()) throw new Error("游戏工作区不允许符号链接");
  const target = join(base, path);
  const rel = relative(base, target);
  if (isAbsolute(path) || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("路径超出游戏工作区");
  // 逐层检查，避免通过悬空链接或目录链接回退到另一层。
  let current = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("游戏工作区不允许符号链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return target;
}

export function overlayPath(root: string, path: string): string {
  const found = layerPath(root, path) ?? layerPath(moduleRoot(root), path);
  if (!found) throw Object.assign(new Error(`游戏文件不存在：${path}`), { code: "ENOENT" });
  return found;
}

export function overlayEntries(root: string, path = "") {
  // 此处保留 Dirent，用于目录树和 AI 查找；同名条目以 game 为准。
  const result = new Map<string, import("node:fs").Dirent<string>>();
  for (const layer of [moduleRoot(root), root]) {
    const directory = layerPath(layer, path);
    if (!directory) continue;
    if (!lstatSync(directory).isDirectory()) throw new Error("查找路径必须是目录");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.endsWith(".tmp")) continue;
      result.set(entry.name, entry);
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSource(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error("只能读取普通文件");
  if (lstatSync(path).size > 1024 * 1024) throw new Error("游戏文档超过 1 MiB 限制");
  return readFileSync(path, "utf8");
}

function parse(source: string, path: string): Record<string, unknown> {
  const value = parseDocumentContent(source, path);
  if (!object(value)) throw new Error("游戏文档必须是对象");
  return value;
}

function rejectUnsafeKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("文档包含不安全字段");
    rejectUnsafeKeys(child);
  }
}

/** 对象按字段记录差异；数组作为一个值，删除与 null 分开保存。 */
function difference(base: Record<string, unknown>, current: Record<string, unknown>, prefix = "") {
  const values: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("文档包含不安全字段");
    const path = `${prefix}/${escape(key)}`;
    if (!Object.hasOwn(current, key)) removed.push(path);
    else if (object(base[key]) && object(current[key])) {
      const nested = difference(base[key], current[key], path);
      if (Object.keys(nested.values).length) values[key] = nested.values;
      removed.push(...nested.removed);
    } else if (!isEqual(base[key], current[key])) values[key] = current[key];
  }
  return { values, removed };
}

function validateChanges(type: DocumentType, base: unknown, current: unknown, path = "") {
  if (isEqual(base, current)) return;
  if (path) {
    try {
      assertMutablePointer(type, path);
      return;
    } catch {
      /* 继续检查可写子字段 */
    }
  }
  if (
    (object(base) && object(current)) ||
    (Array.isArray(base) && Array.isArray(current) && base.length === current.length)
  ) {
    const before = base as Record<string, unknown>,
      after = current as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      validateChanges(type, before[key], after[key], `${path}/${escape(key)}`);
    return;
  }
  assertMutablePointer(type, path);
}

/** 即使覆盖值恰好等于基础值，也不能借此持久覆盖只读标量。 */
function validateOverrides(
  type: DocumentType,
  base: Record<string, unknown>,
  values: Record<string, unknown>,
  prefix = "",
) {
  for (const [key, value] of Object.entries(values)) {
    const path = `${prefix}/${escape(key)}`;
    try {
      assertMutablePointer(type, path);
      continue;
    } catch {
      /* 检查子字段 */
    }
    if (object(value)) validateOverrides(type, object(base[key]) ? base[key] : {}, value, path);
    else if (Array.isArray(value) && Array.isArray(base[key]))
      validateChanges(type, base[key], value, path);
    else assertMutablePointer(type, path);
  }
}

export function readOverlayDocument(root: string, path: string, type: DocumentType): string {
  const basePath = layerPath(moduleRoot(root), path);
  const currentPath = layerPath(root, path);
  if (!basePath) {
    if (!currentPath) throw new Error(`游戏文档不存在：${path}`);
    const source = readSource(currentPath);
    const content = parse(source, path);
    if (Object.hasOwn(content, "$overlay")) throw new Error(`覆盖文档缺少基础模组：${path}`);
    return source;
  }
  const source = readSource(basePath);
  if (!currentPath) return source;
  const result = patchSchema.safeParse(parseStructuredDocument(readSource(currentPath), path));
  if (!result.success) throw new Error(`本局覆盖格式无效：${path}`);
  const patch = result.data;
  rejectUnsafeKeys(patch.values);
  const base = parse(source, path);
  validateOverrides(type, base, patch.values);
  const merged = mergeWith(cloneDeep(base), patch.values, (_target, value) =>
    Array.isArray(value) ? cloneDeep(value) : undefined,
  );
  for (const pointer of patch.removed) applyPointer(merged, pointer, "remove");
  validateChanges(type, base, merged);
  return stringifyDocumentContent(merged, path);
}

export function encodeOverlay(
  root: string,
  path: string,
  type: DocumentType,
  content: Record<string, unknown>,
): string {
  rejectUnsafeKeys(content);
  const basePath = layerPath(moduleRoot(root), path);
  if (!basePath) return stringifyDocumentContent(content, path);
  const base = parse(readSource(basePath), path);
  validateChanges(type, base, content);
  return stringifyStructuredDocument({ $overlay: 1, ...difference(base, content) }, path);
}
