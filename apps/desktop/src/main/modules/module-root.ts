import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { configFilePath } from "@jointarp/module/node/config-file";
import { isMissingFile } from "@tarp/core/node/storage/file-queue";

/** 模组库允许直接内容目录或固定 module/ 外层，根路径本身可以是本地快捷方式。 */
export async function resolveModuleRoot(directory: string): Promise<string> {
  const nested = join(directory, "module");
  let hasNestedDirectory = false;
  try {
    const stat = await lstat(nested);
    if (stat.isSymbolicLink()) throw new Error("module/ 不能是符号链接，请使用普通目录。");
    hasNestedDirectory = stat.isDirectory();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const rootConfig = configFilePath(directory, "module");
  const nestedConfig = hasNestedDirectory ? configFilePath(nested, "module") : undefined;
  if (rootConfig && nestedConfig)
    throw new Error("模组目录结构冲突：根目录和 module/ 不能同时包含模组清单。");
  if (nestedConfig) return nested;
  if (rootConfig) return directory;
  throw new Error("缺少 module.toml 或 module.json，请检查模组内容目录或仓库的 module/。");
}
