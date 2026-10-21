import type { DocumentType } from "@tarp/module/document-type";
import type { ModuleDocument, ModulePageDocument } from "@tarp/module/module-document";
import { z } from "zod";

export const gameRoomSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  moduleName: z.string().min(1),
  status: z.enum(["active", "ended"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
});
export type GameRoom = z.infer<typeof gameRoomSchema>;
/** 冒险列表条目；封面取自房间里冻结的模组副本。 */
export interface GameRoomSummary extends GameRoom {
  cover?: string;
}
/** 开场画面用的模组封面和简介。不含序章、开局方案等流程配置。 */
export interface SessionModule {
  name: string;
  description?: string;
  cover?: string;
  system?: string;
  author?: string;
  version?: string;
  tags?: readonly string[];
  hostName?: string;
  hostAvatar?: string;
}
export interface GameSession {
  room: GameRoom;
  module: SessionModule;
  documentTypes: readonly DocumentType[];
  documents: readonly ModuleDocument[];
  /** 开房时冻结的玩家阅读页，来自模组副本里的 module.json pages。 */
  pages: readonly ModulePageDocument[];
}
