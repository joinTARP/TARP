import {
  compactionRoleSchema,
  compactionSettingsSchema,
  type CompactionRole,
  type CompactionSettings,
  type RoomCompactionSettings,
} from "../../shared/compaction-settings";
import { readRoomSettings, updateRoomSettings } from "../sessions/room-settings";
import { roomDirectoryForDatabase } from "../sessions/session-store";
import type { SessionDatabase } from "../storage/session-database";

export function readCompactionSettings(db: SessionDatabase): RoomCompactionSettings {
  return readCompactionSettingsFile(roomDirectoryForDatabase(db));
}

export function readCompactionSettingsFile(directory: string): RoomCompactionSettings {
  return readRoomSettings(directory).compaction;
}

export function saveCompactionSettingsFile(
  directory: string,
  role: CompactionRole,
  input: CompactionSettings,
): RoomCompactionSettings {
  const parsedRole = compactionRoleSchema.parse(role);
  const setting = compactionSettingsSchema.parse(input);
  return updateRoomSettings(directory, (settings) => ({
    ...settings,
    compaction: { ...settings.compaction, [parsedRole]: setting },
  })).compaction;
}
