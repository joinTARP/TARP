import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { copyModule, directoryExists } from "@tarp/core/node/sessions/module-copy";
import { configFilePath } from "@tarp/module/node/config-file";
import { extractModuleZip } from "@tarp/module/node/extract-zip";
import { loadModuleMetadata } from "@tarp/module/node/module-metadata";

import { assertNoSymlinks, moduleFolderName, publishModule } from "./module-import";
import { resolveModuleRoot } from "./module-root";

/** 支持平铺模组和带外层目录的归档；存在多个模组时不猜测要导入哪一个。 */
async function zipModuleRoot(directory: string): Promise<string> {
  if (configFilePath(directory, "module")) return directory;
  const candidates: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
        continue;
      const child = join(current, entry.name);
      if (configFilePath(child, "module")) candidates.push(child);
      else pending.push(child);
      if (candidates.length > 1) throw new Error("ZIP 包含多个模组，请将每个模组分别打包后导入。");
    }
  }
  if (!candidates[0]) throw new Error("ZIP 中没有找到 module.toml 或 module.json。");
  return candidates[0];
}

export async function importLocalModule(
  directory: string,
  sourcePath: string,
  kind: "zip" | "folder",
): Promise<{ path: string; name: string }> {
  const folderName = moduleFolderName(
    kind === "zip" ? basename(sourcePath).replace(/\.zip$/iu, "") : basename(sourcePath),
  );
  return publishModule(directory, folderName, async (staging) => {
    const ready = join(staging, "module");
    await mkdir(ready);
    if (kind === "zip") {
      await extractModuleZip(sourcePath, ready);
      return zipModuleRoot(ready);
    }
    const selected = await realpath(sourcePath);
    if (!(await directoryExists(selected, "模组目录"))) throw new Error("模组目录不存在。");
    const source = await resolveModuleRoot(selected);
    // 先排除误选的普通目录，再读取与复制外部文件；发布时仍校验最终副本。
    await loadModuleMetadata(source);
    await assertNoSymlinks(source);
    await copyModule(source, ready, { writable: true });
    return ready;
  });
}
