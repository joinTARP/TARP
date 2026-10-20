import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { appConfigSchema, type AppConfig } from "@shared/app-config";

import {
  appSettingsFileName,
  readStoredAppSettings,
  updateStoredAppSettings,
} from "./app-settings";

export { AppConfigError } from "./app-settings";

const configDirectoryName = ".tarp";

export interface AppConfigLocation {
  readonly directory: string;
  readonly filePath: string;
}

export interface ResolveAppConfigLocationOptions {
  readonly configHome?: string;
  readonly homeDir?: string;
}

/** 与 Codex 一样落在用户主目录；Windows 为 %USERPROFILE%\\.tarp，macOS/Linux 为 ~/.tarp。 */
export function resolveAppConfigLocation(
  options: ResolveAppConfigLocationOptions = {},
): AppConfigLocation {
  const override = options.configHome?.trim() || process.env.TARP_HOME?.trim();
  const homeDir = options.homeDir ?? homedir();
  const directory = override
    ? expandUserPath(override, homeDir)
    : join(homeDir, configDirectoryName);
  return { directory, filePath: join(directory, appSettingsFileName) };
}

/** 默认模组保存目录：系统「文档」/tarp/modules。 */
export function resolveDefaultModulesPath(documentsDir: string): string {
  return join(documentsDir, "tarp", "modules");
}

export function resolveModulesPath(
  config: AppConfig,
  options: { readonly documentsDir: string; readonly homeDir?: string },
): string {
  const configured = config.modulesPath?.trim();
  if (!configured) return resolveDefaultModulesPath(options.documentsDir);
  const expanded = expandUserPath(configured, options.homeDir ?? homedir());
  return isAbsolute(expanded) ? expanded : resolveDefaultModulesPath(options.documentsDir);
}

function expandUserPath(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

/** 普通配置接口只读 app 分组，完整文件中的凭据不进入渲染器。 */
export async function readAppConfig(filePath: string): Promise<AppConfig> {
  return (await readStoredAppSettings(filePath)).app;
}

export async function updateAppConfig(filePath: string, patch: AppConfig): Promise<AppConfig> {
  const parsedPatch = structuredClone(appConfigSchema.parse(patch));
  return (
    await updateStoredAppSettings(filePath, (current) => ({
      ...current,
      app: { ...current.app, ...parsedPatch },
    }))
  ).app;
}

export function assertAbsolutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error("路径必须是绝对路径。");
  }
  return trimmed;
}
