import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { ModuleMetadata } from "../schema/module-document";
import { moduleMetadataSchema } from "../schema/module-metadata";
import { configFilePath, parseConfig } from "./config-file";

/** 读取并校验模组根目录的 JSON 或 TOML 元配置。 */
export async function loadModuleMetadata(libraryPath: string): Promise<ModuleMetadata> {
  const metadataPath = configFilePath(libraryPath, "module");
  if (!metadataPath)
    throw Object.assign(new Error("缺少 module.toml 或 module.json"), { code: "ENOENT" });
  const filename = basename(metadataPath);
  const value = parseConfig(await readFile(metadataPath, "utf8"), filename);

  const parsed = moduleMetadataSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "根节点";
    throw new Error(`${filename}.${path}：${issue?.message ?? "格式无效"}`);
  }

  return parsed.data;
}
