import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { z } from "zod";

import { gameReadableEntries } from "../sessions/game-file-access";
import { overlayPath, overlayEntries } from "../sessions/game-overlay";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FIND_ENTRIES = 10_000;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** 使用 coding agent 的 read/find/grep，所有文件操作仍限制在模组目录内。 */
export async function createModuleTools(
  moduleDirectory: string,
  currentDocument?: (relativePath: string) => Promise<Buffer | undefined>,
  overlay = false,
  readableFiles?: () => Promise<ReadonlySet<string>>,
): Promise<ToolDefinition<any, any, any>[]> {
  const root = await realpath(moduleDirectory);

  const physical = (path: string) => (overlay ? overlayPath(root, relative(root, path)) : path);
  const statPath = (path: string) => lstat(physical(path));
  async function entriesAt(path: string, files?: ReadonlySet<string>) {
    const entries = overlay
      ? overlayEntries(root, relative(root, path))
      : await readdir(path, { withFileTypes: true });
    if (!files) return entries;
    const visible = new Set(gameReadableEntries(files, relative(root, path).split(sep).join("/")));
    return entries.filter((entry) => visible.has(`${entry.name}${entry.isDirectory() ? "/" : ""}`));
  }

  async function checked(path: string, files?: ReadonlySet<string>) {
    const candidate = resolve(root, path);
    if (!inside(root, candidate)) throw new Error("路径超出模组目录");
    const name = relative(root, candidate).split(sep).join("/");
    if (files && name && !files.has(name) && !gameReadableEntries(files, name).length)
      throw new Error("只能查阅游戏文档与字段定义");
    if (overlay) {
      physical(candidate);
      return candidate;
    }
    const actual = await realpath(candidate);
    if (!inside(root, actual)) throw new Error("符号链接超出模组目录");
    return actual;
  }

  async function read(path: string, files?: ReadonlySet<string>) {
    const actual = await checked(path, files ?? (await readableFiles?.()));
    const current = await currentDocument?.(relative(root, actual).split(sep).join("/"));
    if (current) return current;
    const file = await open(
      physical(actual),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("只能读取普通文件");
      if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过 5 MiB 限制");
      if ((await checked(actual)) !== actual) throw new Error("文件路径发生变化");
      const current = await statPath(actual);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("文件发生变化");

      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_FILE_BYTES) throw new Error("文件超过 5 MiB 限制");
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  }

  const readTool = createReadToolDefinition(root, {
    operations: {
      access: async (path) => {
        const actual = await checked(path, await readableFiles?.());
        const file = await open(
          physical(actual),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error("只能读取普通文件");
          if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过 5 MiB 限制");
          if ((await checked(actual)) !== actual) throw new Error("文件路径发生变化");
          const current = await statPath(actual);
          if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("文件发生变化");
        } finally {
          await file.close();
        }
      },
      readFile: read,
      detectImageMimeType: async (path) =>
        detectSupportedImageMimeTypeFromFile(
          physical(await checked(path, await readableFiles?.())),
        ),
    },
  });

  const findTool = createFindToolDefinition(root, {
    operations: {
      exists: async (path) => {
        try {
          await checked(path, await readableFiles?.());
          return true;
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
      },
      glob: async (pattern, searchPath, options) => {
        const files = await readableFiles?.();
        const directory = await checked(searchPath, files);
        if (!(await statPath(directory)).isDirectory()) throw new Error("查找路径必须是目录");

        const found: string[] = [];
        const pending = [directory];
        let visited = 0;
        const limit = Math.max(1, Math.min(options.limit, MAX_FIND_ENTRIES));
        while (pending.length > 0 && found.length < limit && visited < MAX_FIND_ENTRIES) {
          const current = pending.pop()!;
          const entries = await entriesAt(current, files);
          visited += 1;
          for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            const candidate = resolve(current, entry.name);
            const isDirectory = entry.isDirectory();
            if (!isDirectory && !entry.isFile()) continue;
            const relativePath = relative(directory, candidate).split(sep).join("/");
            if (matchesGlob(pattern, relativePath)) {
              found.push(isDirectory ? `${candidate}${sep}` : candidate);
              if (found.length >= limit) break;
            }
            if (isDirectory && pending.length + visited < MAX_FIND_ENTRIES) pending.push(candidate);
          }
        }
        return found;
      },
    },
  });
  findTool.description = "按 glob 查找游戏文档、字段定义及其目录，不显示配置、布局或附件。";
  findTool.promptSnippet = "按 glob 查找游戏文档和字段定义。";

  const grepTool = createGrepToolDefinition(root, {
    operations: {
      isDirectory: async (path) => {
        const actual = await checked(path);
        if (actual !== path) throw new Error("不能通过符号链接搜索模组");
        return (await statPath(actual)).isDirectory();
      },
      readFile: async (path) => (await read(path)).toString("utf8"),
    },
  });

  // SDK grep 的匹配阶段直接运行 rg，绕过 readFile；有本局覆盖层时必须搜索同一读取视图。
  if (currentDocument || readableFiles) {
    grepTool.description =
      "搜索游戏文档与字段定义，包含合并后的本局覆盖及新增文档，不搜索配置、布局或附件。";
    grepTool.execute = async (_id, params, signal) => {
      const input = z
        .object({
          pattern: z.string().max(256),
          path: z.string().optional(),
          glob: z.string().optional(),
          ignoreCase: z.boolean().optional(),
          literal: z.boolean().optional(),
          context: z.number().optional(),
          limit: z.number().optional(),
        })
        .parse(params);
      const files = await readableFiles?.();
      const directory = await checked(input.path ?? ".", files);
      const pending = [directory];
      const output: string[] = [];
      const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
      const pattern = input.literal
        ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : input.pattern;
      const quickJS = await getQuickJS();
      let visited = 0;
      while (pending.length && output.length < limit && visited++ < MAX_FIND_ENTRIES) {
        signal?.throwIfAborted();
        const path = pending.pop()!;
        const stat = await statPath(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          for (const entry of await entriesAt(path, files))
            if (
              entry.name !== ".git" &&
              entry.name !== "node_modules" &&
              (entry.isDirectory() || entry.isFile())
            )
              pending.push(resolve(path, entry.name));
          continue;
        }
        const name = relative(root, path).split(sep).join("/");
        if (
          !stat.isFile() ||
          !/\.(json|toml|md|txt|ya?ml)$/iu.test(name) ||
          (input.glob && !matchesGlob(input.glob, name))
        )
          continue;
        const lines = (await read(path, files)).toString("utf8").split(/\r?\n/u);
        // 模组文本与搜索正则都不可信，限制正则运行时间，避免阻塞主进程。
        const matches: number[] = JSON.parse(
          String(
            quickJS.evalCode(
              `JSON.stringify((() => {
          const expression = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(input.ignoreCase ? "i" : "")});
          const lines = ${JSON.stringify(lines)};
          const matches = [];
          for (let i = 0; i < lines.length && matches.length < ${limit}; i++) if (expression.test(lines[i])) matches.push(i);
          return matches;
        })())`,
              {
                shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 200),
                memoryLimitBytes: 64 * 1024 * 1024,
              },
            ),
          ),
        );
        for (const i of matches) {
          if (output.length < limit) {
            const context = Math.min(5, Math.max(0, input.context ?? 0));
            for (
              let j = Math.max(0, i - context);
              j <= Math.min(lines.length - 1, i + context) && output.length < limit;
              j++
            )
              output.push(`${name}:${j + 1}: ${lines[j].slice(0, 500)}`);
          }
        }
      }
      return {
        content: [
          {
            type: "text",
            text: output.length ? output.join("\n").slice(0, 50_000) : "未找到匹配内容",
          },
        ],
        details: undefined,
      };
    };
  }

  return [readTool, findTool, grepTool] as ToolDefinition<any, any, any>[];
}

function matchesGlob(pattern: string, relativePath: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const candidate = normalized.includes("/") ? relativePath : basename(relativePath);
  try {
    return globToRegExp(normalized).test(candidate);
  } catch {
    return false;
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) source += "\\[";
      else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
