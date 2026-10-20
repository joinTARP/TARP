/** 由桌面主进程或云端宿主创建和关闭游戏服务。 */
export { ChatService, type Runtime } from "./game/chat-service";
export type { ChatAuth, ChatCredentials } from "./game/chat/types";
export { gameRouter, type GameContext } from "./game/game-router";
export { createPiRuntime, type PiRuntimeOptions } from "./agent/pi-runtime";
export {
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  loadSessionModuleResources,
  loadRoomNotes,
  saveRoomNotes,
  setSessionStatus,
} from "./sessions/session-store";
