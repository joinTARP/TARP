import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isInsideDirectory } from "@jointarp/core/node/storage/path";

export const mediaScheme = "tarp";
const imagePattern = /\.(avif|gif|jpe?g|png|svg|webp)$/iu;
const documentRoots = new Map<string, readonly string[]>();

/** 固定文档来源的真实目录；游戏覆盖优先于冻结模组。 */
export function allowDocumentMediaRoots(scope: string, paths: readonly string[]): void {
  const roots = paths.map((path) => realpathSync(path));
  documentRoots.set(scope, roots);
}

/** 返回真实的普通图片文件路径；roots 必须是已确认的真实目录。 */
async function resolveLocalImageFile(
  file: string,
  roots: readonly string[],
): Promise<string | undefined> {
  if (!isAbsolute(file) || !imagePattern.test(file)) return undefined;
  try {
    const target = await realpath(file);
    if (
      !imagePattern.test(target) ||
      !roots.some((root) => isInsideDirectory(root, target)) ||
      !(await stat(target)).isFile()
    ) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

/** 每次协议请求重新校验，不能把之前生成过媒体 URL 当作读取授权。 */
export async function resolveMediaRequestFile(url: string): Promise<string | undefined> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${mediaScheme}:` || parsed.hostname !== "document") return undefined;
    const roots = documentRoots.get(decodeURIComponent(parsed.pathname.slice(1)));
    const path = parsed.searchParams.get("path");
    const image = parsed.searchParams.get("image");
    if (!roots || path === null || !image) return undefined;
    for (const root of roots) {
      const file = await resolveDocumentImageFile(root, path, image);
      if (file) return file;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function resolveDocumentImageFile(
  root: string,
  documentPath: string,
  image: string,
): Promise<string | undefined> {
  const candidates = [
    isAbsolute(image) ? image : undefined,
    join(root, image),
    join(root, dirname(documentPath), image),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isInsideDirectory(root, candidate)) continue;
    const target = await resolveLocalImageFile(resolve(candidate), [root]);
    if (target) return target;
  }
  return undefined;
}
