import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { isMissingFile, withFileMutation } from "@tarp/core/node/storage/file-queue";

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
): Promise<{ path: string; name: string }> {
  await mkdir(directory, { recursive: true });
  const destination = join(directory, moduleFolderName(folderName));
  return withFileMutation(destination, async () => {
    try {
      await lstat(destination);
      throw new Error(`模组目录「${folderName}」已存在，请勿重复导入。`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const staging = await mkdtemp(join(directory, ".module-import-"));
    try {
      const ready = await prepare(staging);
      const content = await resolveModuleRoot(ready);
      const [metadata] = await Promise.all([
        loadModuleMetadata(content),
        loadDocumentTypes(content),
      ]);
      await rename(ready, destination);
      return { path: join(destination, relative(ready, content)), name: metadata.name };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
