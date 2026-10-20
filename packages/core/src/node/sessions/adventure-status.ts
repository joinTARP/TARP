import type { SessionDatabase } from "../storage/session-database";
import { readRoomFileSync, updateRoomFile } from "./room-file";
import { gameDirectoryForDatabase, roomDirectoryForDatabase } from "./session-paths";
import { withStateLock } from "./state-lock";

export function assertGameWritable(db: SessionDatabase): void {
  if (readRoomFileSync(roomDirectoryForDatabase(db)).room.status !== "active")
    throw new Error("这段冒险已经结束，不能继续修改游戏状态");
}

/** 主持按模组规则明确结束冒险；与文档提交共用锁，重复调用保持幂等。 */
export async function endAdventure(db: SessionDatabase, signal?: AbortSignal): Promise<void> {
  await withStateLock(gameDirectoryForDatabase(db), async () => {
    signal?.throwIfAborted();
    updateRoomFile(roomDirectoryForDatabase(db), (state) => {
      if (state.room.status === "ended") return state;
      const now = new Date().toISOString();
      return { ...state, room: { ...state.room, status: "ended", updatedAt: now, endedAt: now } };
    });
  });
}
