import { createIdentityId } from "@tarp/core/node/identity";
import { structuredFile, StructuredFileError } from "@tarp/core/node/storage/structured-file";
import { playerSchema } from "@tarp/core/shared/game";
import {
  gameDefaultsSchema,
  patchGameDefaults,
  type GameDefaultsPatch,
} from "@tarp/core/shared/game-defaults";
import { z } from "zod";

import { appConfigSchema } from "../../shared/app-config";

export const appSettingsFileName = "settings.json";

const gameSettingsSchema = z
  .object({
    player: playerSchema,
    defaults: gameDefaultsSchema.prefault({}),
  })
  .strict();
export type StoredGameSettings = z.infer<typeof gameSettingsSchema>;

const ttsSettingsSchema = z.strictObject({
  connections: z.array(
    z.strictObject({ provider: z.string().min(1), apiKey: z.string().optional() }),
  ),
});
export type StoredTtsSettings = z.infer<typeof ttsSettingsSchema>;

/** 仅供主进程使用；完整配置含凭据，不能直接作为 RPC 返回值。 */
const storedAppSettingsSchema = z
  .object({
    app: appConfigSchema.prefault({}),
    game: gameSettingsSchema.optional(),
    tts: ttsSettingsSchema.optional(),
  })
  .strict();
type StoredAppSettings = z.infer<typeof storedAppSettingsSchema>;

export class AppConfigError extends Error {
  constructor(filePath: string, detail: string) {
    super(
      `应用配置无效：${filePath}\n${detail}\n原文件已保留，请修正后重试。如需恢复默认配置，请先备份并移走该文件。`,
    );
    this.name = "AppConfigError";
  }
}

function settingsFile(filePath: string) {
  return structuredFile(filePath, {
    validate: (value) => storedAppSettingsSchema.parse(value),
    missing: () => ({ app: {} }),
    fileMode: 0o600,
    directoryMode: 0o700,
  });
}

async function configOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StructuredFileError) throw new AppConfigError(filePath, error.detail);
    throw error;
  }
}

export function readStoredAppSettings(filePath: string): Promise<StoredAppSettings> {
  return configOperation(filePath, () => settingsFile(filePath).read());
}

/** 三个分组共用按文件路径串行的读改写队列，并以原子替换落盘。 */
export function updateStoredAppSettings(
  filePath: string,
  change: (current: StoredAppSettings) => StoredAppSettings,
): Promise<StoredAppSettings> {
  return configOperation(filePath, () => settingsFile(filePath).update(change));
}

export async function readGameDefaults(filePath: string) {
  return (await readStoredAppSettings(filePath)).game?.defaults ?? gameDefaultsSchema.parse({});
}
export async function updateGameDefaults(filePath: string, patch: GameDefaultsPatch) {
  return (
    await updateStoredAppSettings(filePath, (current) => ({
      ...current,
      game: {
        player: current.game?.player ?? { id: createIdentityId(), nickname: "玩家" },
        defaults: patchGameDefaults(current.game?.defaults ?? gameDefaultsSchema.parse({}), patch),
      },
    }))
  ).game!.defaults;
}
