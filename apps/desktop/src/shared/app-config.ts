import { z } from "zod";

export const appThemes = ["system", "light", "dark"] as const;
export type AppTheme = (typeof appThemes)[number];
export const appThemeStorageKey = "tarp:theme:experimental";

/** 公开的应用配置；保存在 ~/.tarp/settings.json 的 app 分组，不包含凭据。 */
export const appConfigSchema = z
  .object({
    theme: z.enum(appThemes).optional(),
    modulesPath: z.string().min(1).optional(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export const defaultAppTheme: AppTheme = "dark";
