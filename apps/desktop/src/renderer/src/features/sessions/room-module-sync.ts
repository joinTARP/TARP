import { setDocumentMediaVersion } from "@shared/document-media";
import type { QueryClient } from "@tanstack/react-query";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { localRoomModuleLoader } from "./local-room-module";
import { roomConnection } from "./room-connection";

export function refreshSyncedRoom(client: QueryClient, roomId: string, version: string) {
  setDocumentMediaVersion(`room:${roomId}`, version);
  setDocumentMediaVersion(`room-module:${roomId}`, version);
  roomConnection(desktopRpc.game, roomId, localRoomModuleLoader).reconnect(true, true);
  void client.invalidateQueries(desktopOrpc.sessions.load.queryOptions({ input: { id: roomId } }));
  void client.invalidateQueries(desktopOrpc.sessions.list.queryOptions());
  void client.invalidateQueries({ queryKey: desktopOrpc.sessions.module.source.key() });
  void client.invalidateQueries({ queryKey: desktopOrpc.tts.hostVoiceSettings.key() });
  void client.invalidateQueries({ queryKey: desktopOrpc.tts.voiceSettings.key() });
}

/** 每个渲染窗口只有一个监听器；发送方显式刷新自己，其他窗口通过广播刷新。 */
export function listenForModuleSync(client: QueryClient) {
  const channel = new BroadcastChannel("tarp-module-synced");
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (
      !value ||
      typeof value !== "object" ||
      !("roomId" in value) ||
      !("version" in value) ||
      typeof value.roomId !== "string" ||
      typeof value.version !== "string"
    )
      return;
    refreshSyncedRoom(client, value.roomId, value.version);
  };
  return () => channel.close();
}
