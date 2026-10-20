import { desktopRpc } from "../../desktop-rpc";
import type { LocalRoomModuleLoader } from "./room-connection";

/** 桌面本地资料入口，明确独立于认证 game 客户端。 */
export const localRoomModuleLoader: LocalRoomModuleLoader = {
  resources: (roomId, signal) => desktopRpc.sessions.module.resources({ roomId }, { signal }),
};
