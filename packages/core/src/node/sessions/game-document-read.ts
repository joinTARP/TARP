import { lstatSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { documentIdentity } from "@jointarp/module/document-path";
import { parseConfig } from "@jointarp/module/node/config-file";
import { parseGameDocumentContent as parseContent } from "@jointarp/module/node/game-state-validation";

import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState } from "./adventure-state";
import { storedTypes } from "./character-db";
import { normalizeGamePath, resolveGameDocumentPath } from "./game-document-path";
import { checkedRoot, recordForPath, typeFromPath, verifyCurrent } from "./game-document-source";
import { readAuthoritativeGameDocument } from "./game-document-views";
import { gameReadableEntries, gameReadableFiles, isGameReadableFile } from "./game-file-access";
import { listGameFileRecords } from "./game-file-index";
import { overlayPath, overlayEntries } from "./game-overlay";
import { withStateLock } from "./state-lock";
const INDEX_INLINE_LIMIT = 20;

/** 目录与配置保留实际路径；游戏文档统一通过逻辑标识解析。 */
export function resolveGameReadPath(db: SessionDatabase, root: string, value: string): string {
  const path = value === "/" || value === "." ? "" : normalizeGamePath(value);
  if (!path) return path;
  try {
    const actual = overlayPath(root, path);
    if (lstatSync(actual).isDirectory() || path.startsWith(".types/")) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const resolved = resolveGameDocumentPath(root, path, storedTypes(db));
  if (resolved) return resolved;
  // 非文档路径仍经过原有读取授权，避免别名放开配置或附件。
  try {
    overlayPath(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const name = basename(documentIdentity(path));
    const candidates = [...gameReadableFiles(db)]
      .filter((candidate) => basename(documentIdentity(candidate)) === name)
      .slice(0, 10);
    if (!candidates.length) throw error;
    throw Object.assign(
      new Error(
        `游戏文件不存在：${path}。同名资料的实际路径：${candidates.map((candidate) => JSON.stringify(candidate)).join("、")}；请使用实际路径重新读取。`,
      ),
      { code: "ENOENT" },
    );
  }
  return path;
}

async function readGamePathUnlocked(
  db: SessionDatabase,
  root: string,
  value: string,
  fields?: readonly string[],
): Promise<unknown> {
  const path = resolveGameReadPath(db, root, value);
  const actual = overlayPath(root, path);
  const stat = await lstat(actual);
  if (stat.isDirectory()) {
    if (fields) throw new Error("fields 不支持目录");
    const entries = gameReadableEntries(gameReadableFiles(db), path);
    if (path && !entries.length) throw new Error("只能查阅游戏文档与字段定义");
    return { path: value.startsWith("/") ? value : `/${path}`, entries };
  }
  if (!stat.isFile()) throw new Error("只能读取普通文件或目录");
  if (!isGameReadableFile(path, storedTypes(db))) throw new Error("只能查阅游戏文档与字段定义");
  const record = recordForPath(db, path);
  const source = record ? await verifyCurrent(db, root, record) : await readFile(actual, "utf8");
  if (!record) {
    const definition = parseConfig(source, path);
    return {
      path: `/${path}`,
      readonly: true,
      ...(fields ? selectDefinitionFields(definition, fields) : { content: definition }),
    };
  }
  const controller = readAdventureState(db).party.characters.find((item) => item.id === record.id);
  const type = typeFromPath(path, storedTypes(db));
  const raw = parseContent(type, source, path);
  const resolved = await readAuthoritativeGameDocument(db, root, path);
  const view = resolved?.valid
    ? {
        name: resolved.title,
        ...(resolved.description !== undefined ? { description: resolved.description } : {}),
        ...(resolved.image !== undefined ? { image: resolved.image } : {}),
        ...(resolved.avatar !== undefined ? { avatar: resolved.avatar } : {}),
        ...(resolved.body !== undefined ? { body: resolved.body } : {}),
        ...resolved.values,
      }
    : {};
  const content = withUnderscoreRaw(view, raw);
  return {
    path: `/${path}`,
    revision: record.revision,
    content: fields
      ? Object.fromEntries(
          Object.entries(selectFields(content, fields)).map(([key, value]) => [
            key,
            key.split("/").includes("$instance") ? value : withoutInstanceDisplay(value),
          ]),
        )
      : withoutInstanceDisplay(content),
    ...(!resolved?.valid ? { error: "计算资料失败；请检查原字段中的当前状态" } : {}),
    ...(controller
      ? {
          _runtime: {
            controller: controller.playerId ? { playerId: controller.playerId } : null,
            retired: controller.retired,
          },
        }
      : {}),
  };
}

export function readGamePath(
  db: SessionDatabase,
  root: string,
  path: string,
  fields?: readonly string[],
): Promise<unknown> {
  return withStateLock(root, () => readGamePathUnlocked(db, root, path, fields));
}

/** 定义使用自身 JSON Pointer；补回父字段约束，不连带输出其他字段的定义。 */
function selectDefinitionFields(definition: unknown, fields: readonly string[]) {
  const content = selectFields(definition, fields, false);
  const constraints: Record<string, unknown> = {};
  for (const pointer of fields) {
    const segments = pointer.slice(1).split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = `/${segments.slice(0, depth).join("/")}`;
      // 只识别 fields/<字段名> 与 item 组成的定义路径，避免把字段集合或元数据当作定义。
      if (!/^\/fields\/[^/]*(?:\/item|\/fields\/[^/]*)*$/u.test(parent)) continue;
      if (Object.hasOwn(content, parent) || Object.hasOwn(constraints, parent)) continue;
      const value = selectFields(definition, [parent], false)[parent];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const node = value as Record<string, unknown>;
      if (typeof node.type !== "string") continue;
      constraints[parent] = Object.fromEntries(
        Object.entries(node).filter(([key]) => key !== "fields" && key !== "item"),
      );
    }
  }
  return { content, ...(Object.keys(constraints).length ? { constraints } : {}) };
}

/** 仅默认模型读取省略实例展示元数据；计算状态和原值别名保持原样。 */
function withoutInstanceDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInstanceDisplay);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$instance")
      .map(([key, child]) => [key, withoutInstanceDisplay(child)]),
  );
}

/** 指针作为返回键，避免局部数组产生空洞或改变索引；原值别名随选中字段一起保留。 */
export function selectFields(content: unknown, fields: readonly string[], includeRaw = true) {
  if (!fields.length || fields.length > 100) throw new Error("fields 必须包含 1 到 100 个字段路径");
  const selected: Record<string, unknown> = {};
  for (const pointer of fields) {
    if (!pointer.startsWith("/") || pointer.length > 1000 || /~(?![01])/u.test(pointer))
      throw new Error(`无效的字段 JSON Pointer：${pointer}`);
    let value = content;
    let parent = "";
    for (const segment of pointer.slice(1).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (
        value === null ||
        typeof value !== "object" ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key)) ||
        !Object.hasOwn(value, key)
      )
        throw new Error(`字段不存在：${pointer}`);
      const object = value as Record<string, unknown>;
      if (includeRaw && !Array.isArray(value) && Object.hasOwn(object, `_${key}`))
        selected[`${parent}/_${segment}`] = object[`_${key}`];
      value = object[key];
      parent += `/${segment}`;
    }
    selected[pointer] = value;
  }
  return selected;
}

/** 计算值与原值不同时，原值以 _字段名 保留。没有进入玩家视图的字段保持原名。 */
function withUnderscoreRaw(view: unknown, raw: unknown): unknown {
  if (Array.isArray(view) && Array.isArray(raw))
    return view.map((item, index) => withUnderscoreRaw(item, raw[index]));
  if (
    !view ||
    typeof view !== "object" ||
    Array.isArray(view) ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  )
    return view;
  const result: Record<string, unknown> = { ...(view as Record<string, unknown>) };
  for (const [key, rawValue] of Object.entries(raw)) {
    if (Object.hasOwn(result, key)) {
      const current = result[key];
      if (current && typeof current === "object" && rawValue && typeof rawValue === "object")
        result[key] = withUnderscoreRaw(current, rawValue);
      else if (JSON.stringify(current) !== JSON.stringify(rawValue)) result[`_${key}`] = rawValue;
    } else result[key] = rawValue;
  }
  return result;
}

export async function gameFolderIndex(root: string, db: SessionDatabase): Promise<string> {
  await checkedRoot(root);
  const types = storedTypes(db).sort((a, b) => a.id.localeCompare(b.id));
  const documents = new Map<string, Map<string, string[]>>();
  for (const record of listGameFileRecords(db)) {
    if (!isGameReadableFile(record.path, types)) continue;
    let directories = documents.get(record.typeId);
    if (!directories) documents.set(record.typeId, (directories = new Map()));
    const directory = dirname(record.path);
    const paths = directories.get(directory) ?? [];
    paths.push(record.path);
    directories.set(directory, paths);
  }
  const definitions = overlayEntries(root, ".types")
    .filter((entry) => entry.isFile() && isGameReadableFile(`.types/${entry.name}`, types))
    .map((entry) => `.types/${entry.name}`);
  const lines = [
    "## 本局资料索引",
    "仅列游戏文档与字段定义。一级文件夹决定文档类型，子文件夹只负责分组。文件夹路径相对工作区，文件名相对所属文件夹；读取时用 文件夹/文件名 拼接为 path。文件名不含类型后缀，不要添加未列出的点号或目录。字段定义单独列出完整路径。按类型定位资料，用 read/find/grep 查路径，不猜文件名。游戏文档路径可省略 .json/.toml/.md。",
    "find/grep 的 path 不带前导 /，省略时搜索全部；find 结果相对搜索目录，grep 路径相对工作区。",
  ];
  for (const type of types) {
    lines.push(`### ${type.name === type.id ? type.id : `${type.name}（${type.id}）`}`);
    if (type.description) lines.push(type.description);
    for (const path of definitions.filter(
      (path) => path.replace(/\.(json|toml)$/u, "") === `.types/${type.id}.fields`,
    ))
      lines.push(`- 定义：${path}`);
    const directories = documents.get(type.id);
    if (!directories?.size) {
      lines.push("暂无文档。");
      continue;
    }
    for (const [directory, paths] of directories) {
      lines.push(`- 文件夹：${JSON.stringify(directory)}（${paths.length} 份）`);
      if (paths.length <= INDEX_INLINE_LIMIT)
        for (const path of paths) lines.push(`  - 文件：${JSON.stringify(basename(path))}`);
      else
        lines.push(
          `  - 已折叠，用 read(${JSON.stringify({ path: directory === "." ? "/" : directory })}) 或 find/grep 查找。`,
        );
    }
  }
  return lines.join("\n");
}
