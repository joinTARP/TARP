import { createContext } from "react";

export interface PlayerRole {
  playerId: string;
  characterId?: string;
  name: string;
  image?: string;
  path?: string | null;
  avatar?: string;
}

export const PlayerRolesContext = createContext<ReadonlyMap<string, PlayerRole>>(new Map());

export function playerLabel(nickname: string, role?: PlayerRole) {
  return role ? `${role.name}（${nickname}）` : nickname;
}
