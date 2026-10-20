import { z } from "zod";

export const compactionRoleSchema = z.enum(["host", "companion"]);
export type CompactionRole = z.infer<typeof compactionRoleSchema>;
export const compactionSettingsSchema = z.object({
  /** null 表示根据模型窗口自动设置压缩触发值。 */
  thresholdTokens: z.number().int().min(1024).max(2_000_000).nullable(),
});
export type CompactionSettings = z.infer<typeof compactionSettingsSchema>;
export type RoomCompactionSettings = Record<CompactionRole, CompactionSettings>;

/** UI 与运行时共用同一阈值，给输出留空间，并保证有旧记录可以压缩。 */
export function resolveCompaction(settings: CompactionSettings, contextWindow: number) {
  const window = Math.max(2, Math.floor(contextWindow));
  const reserve = Math.min(8192, Math.floor(window / 4));
  const thresholdTokens = Math.min(settings.thresholdTokens ?? window - reserve, window - reserve);
  return {
    enabled: true,
    thresholdTokens,
    reserveTokens: window - thresholdTokens,
    keepRecentTokens: Math.min(12000, Math.floor(thresholdTokens / 2)),
  };
}
