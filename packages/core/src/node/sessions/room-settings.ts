import { join } from "node:path";

import type { z } from "zod";

import { resolveCompanionRoleplay } from "../../shared/companion-roleplay";
import {
  gameDefaultsSchema,
  roomSettingsSchema,
  snapshotGameDefaults,
  patchGameDefaults,
  roomConfiguration,
  type GameDefaultsPatch,
  type RoomSettings,
} from "../../shared/game-defaults";
import { resolveHostSystemPrompt } from "../../shared/host-system-prompt";
import { assertRegularFile } from "../storage/regular-file";
import { structuredFile } from "../storage/structured-file";
export type { RoomSettings } from "../../shared/game-defaults";

function settingsFile(directory: string) {
  return structuredFile(join(directory, "settings.json"), {
    validate: (value) => roomSettingsSchema.parse(value),
    fileMode: 0o600,
  });
}

/** 仅在尚未发布的冒险 staging 目录初始化。 */
export function initializeRoomSettings(
  directory: string,
  defaults: z.input<typeof gameDefaultsSchema> = {},
): void {
  settingsFile(directory).writeSync(snapshotGameDefaults(defaults));
}

export function readRoomSettings(directory: string): RoomSettings {
  assertRegularFile(join(directory, "settings.json"));
  return settingsFile(directory).readSync();
}

export function updateRoomSettings(
  directory: string,
  change: (settings: RoomSettings) => RoomSettings,
): RoomSettings {
  assertRegularFile(join(directory, "settings.json"));
  return settingsFile(directory).updateSync((current) => {
    const next = change(current);
    return {
      ...next,
      chat: {
        ...next.chat,
        submissionModeRevision:
          current.chat.submissionModeRevision +
          Number(next.chat.submissionMode !== current.chat.submissionMode),
      },
    };
  });
}

/** 房间更新保留主持声音覆盖，应用默认值永远不参与已有冒险的读取。 */
export function patchRoomSettings(directory: string, patch: GameDefaultsPatch): RoomSettings {
  return updateRoomSettings(directory, (current) => {
    const updated = patchGameDefaults(roomConfiguration(current), patch);
    return {
      ...updated,
      chat: { ...updated.chat, submissionModeRevision: current.chat.submissionModeRevision },
      hostSystemPrompt: resolveHostSystemPrompt(updated.hostSystemPrompt),
      companionRoleplayPrompt: resolveCompanionRoleplay(updated.companionRoleplayPrompt),
      tts: { ...updated.tts, host: current.tts.host },
    };
  });
}
