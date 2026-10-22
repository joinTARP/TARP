import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { isMissingFile, withFileMutation } from "@jointarp/core/node/storage/file-queue";
import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";

import { resolveModuleRoot } from "./module-root";

export function moduleFolderName(value: string): string {
  let name = value
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "-")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .slice(0, 100)
    .replace(/[. ]+$/gu, "");
  if (!name) throw new Error("模组文件夹名称无效。");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `module-${name}`;
  return name;
}

/** 外部模组不能通过内部链接读取目录之外的本机文件。 */
export async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (entry.isSymbolicLink())
      throw new Error(`模组包含符号链接：${entry.name}，请改为普通文件。`);
    if (entry.isDirectory()) await assertNoSymlinks(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error(`模组包含非普通文件：${entry.name}。`);
  }
}

/** 所有导入方式共用目标锁、校验和同目录发布，失败时清理未发布内容。 */
export async function publishModule(
  directory: string,
  folderName: string,
  prepare: (staging: string) => Promise<string>,
  options: { replace?: boolean } = {},
): Promise<{ path: string; name: string }> {
  await mkdir(directory, { recursive: true });
  if (options.replace && (basename(folderName) !== folderName || [".", ".."].includes(folderName)))
    throw new Error("替换目标必须是模组库中的直接子目录。");
  // 已有仓库可能被用户改名，替换时必须保留真实目录名。
  const destination = join(directory, options.replace ? folderName : moduleFolderName(folderName));
  return withFileMutation(destination, async () => {
    try {
      await lstat(destination);
      if (!options.replace) throw new Error(`模组目录「${folderName}」已存在，请勿重复导入。`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const staging = await mkdtemp(join(directory, ".module-import-"));
    let preserveBackup = false;
    try {
      const ready = await prepare(staging);
      const content = await resolveModuleRoot(ready);
      const [metadata] = await Promise.all([
        loadModuleMetadata(content),
        loadDocumentTypes(content),
      ]);
      const backup = join(staging, "previous");
      if (options.replace) await rename(destination, backup);
      try {
        await rename(ready, destination);
      } catch (error) {
        if (options.replace) {
          try {
            await rename(backup, destination);
          } catch {
            preserveBackup = true;
            throw new Error(`替换失败且无法自动恢复。原模组保留在：${backup}`);
          }
        }
        throw error;
      }
      return { path: join(destination, relative(ready, content)), name: metadata.name };
    } finally {
      if (!preserveBackup) await rm(staging, { recursive: true, force: true });
    }
  });
}
