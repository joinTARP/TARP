import { readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import { documentMetadataSchema } from "../schema/document-type";
import type { ModulePageDocument } from "../schema/module-document";
import { parseMarkdown } from "./document-codec";

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** 把 module.json / module.toml 里的阅读路径收成模组内的相对路径。 */
export function modulePagePath(libraryPath: string, page: string): string {
  const normalized = page.trim().replaceAll("\\", "/");
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error(`module.json / module.toml.pages：只接受 Markdown 文件（${page}）`);
  }
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`module.json / module.toml.pages：路径必须位于模组目录内（${page}）`);
  }
  const absolute = resolve(libraryPath, normalized);
  const inside = relative(libraryPath, absolute);
  if (inside.startsWith("..") || inside.split(sep).includes("..")) {
    throw new Error(`module.json / module.toml.pages：路径必须位于模组目录内（${page}）`);
  }
  return inside.split(sep).join("/");
}

export async function loadModulePages(
  libraryPath: string,
  pages: readonly string[] = [],
): Promise<ModulePageDocument[]> {
  const seen = new Set<string>();
  const loaded: ModulePageDocument[] = [];
  for (const page of pages) {
    const path = modulePagePath(libraryPath, page);
    if (seen.has(path)) throw new Error(`module.json / module.toml.pages：重复的文件 ${path}`);
    seen.add(path);
    const fallback = basename(path).replace(/\.md$/iu, "");
    try {
      const source = await readFile(resolve(libraryPath, path), "utf8");
      const { metadata, body } = parseMarkdown(source);
      const parsed = documentMetadataSchema.safeParse(metadata);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        loaded.push({
          path,
          title: fallback,
          error: `${issue?.path.join(".") || "元数据"}：${issue?.message ?? "格式无效"}`,
        });
        continue;
      }
      loaded.push({
        path,
        title: parsed.data.name ?? fallback,
        body: body.trim(),
      });
    } catch (error) {
      loaded.push({
        path,
        title: fallback,
        error: isMissing(error)
          ? "找不到这个文件"
          : error instanceof Error
            ? error.message
            : "无法读取",
      });
    }
  }
  return loaded;
}
