import { notifyRoomChanged } from "./room-changes";
import type { StoredAdventure } from "./room-storage";
import { readAdventure, updateAdventure } from "./room-storage";

export type RoomFile = Pick<StoredAdventure, "room" | "notes">;

export function readRoomFileSync(directory: string): RoomFile {
  const { room, notes } = readAdventure(directory);
  return { room, notes };
}

export async function readRoomFile(directory: string): Promise<RoomFile> {
  return readRoomFileSync(directory);
}

/** 只修改房间资料与笔记，保留最新开局与队伍状态。 */
export function updateRoomFile(directory: string, change: (state: RoomFile) => RoomFile): RoomFile {
  let changed = false;
  const { room, notes } = updateAdventure(directory, (current) => {
    const previous = { room: current.room, notes: current.notes };
    const before = JSON.stringify(previous);
    const next = change(previous);
    changed = JSON.stringify(next) !== before;
    return { ...current, room: next.room, notes: next.notes };
  });
  if (changed) notifyRoomChanged(directory);
  return { room, notes };
}
