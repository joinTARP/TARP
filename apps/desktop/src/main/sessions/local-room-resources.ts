import { join } from "node:path";

import { listSessions, loadSession, loadSessionModuleResources } from "@jointarp/core/node";
import { roomDirectory } from "@jointarp/core/node/sessions/session-store";

import { allowDocumentMediaRoots } from "../media-path";

/** 只在宿主已成功读取房间后注册本地媒体；核心不维护桌面协议的目录表。 */
export function registerRoomMedia(root: string, roomId: string): void {
  const directory = roomDirectory(root, roomId);
  allowDocumentMediaRoots(`room:${roomId}`, [join(directory, "game"), join(directory, "module")]);
  allowDocumentMediaRoots(`room-module:${roomId}`, [join(directory, "module")]);
}

export async function listLocalSessions(root: string) {
  const result = await listSessions(root);
  for (const room of result.rooms) {
    if (room.cover)
      allowDocumentMediaRoots(`room-module:${room.id}`, [
        join(roomDirectory(root, room.id), "module"),
      ]);
  }
  return result;
}

export async function loadLocalSession(
  root: string,
  roomId: string,
  debugOverride?: boolean,
  includeDocuments = true,
) {
  const session = await loadSession(root, roomId, debugOverride, includeDocuments);
  registerRoomMedia(root, roomId);
  return session;
}

export async function loadLocalSessionModuleResources(root: string, roomId: string) {
  const resources = await loadSessionModuleResources(root, roomId);
  registerRoomMedia(root, roomId);
  return resources;
}
