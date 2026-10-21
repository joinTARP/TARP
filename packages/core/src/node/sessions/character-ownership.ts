import type { Character } from "@tarp/module/character";
import { sameDocumentIdentity } from "@tarp/module/document-path";

import type { SessionDatabase } from "../storage/session-database";
import { markStateChanged, readAdventureState, updateAdventureState } from "./adventure-state";
import { readCharacters } from "./character-db";
import { readLaunchConfig, readLaunchRoom } from "./launch-db";
import type { CompanionSeat } from "./room-storage";

export function isPlayableCharacter(db: SessionDatabase, character: Character) {
  const config = readLaunchConfig(db);
  if (!config) return false;
  const start = config.gameStarts.find((item) => item.id === readLaunchRoom(db).startId);
  return Boolean(
    start &&
    !character.retired &&
    start.characterTypeIds.includes(character.typeId) &&
    start.playablePaths.some(
      (path) => character.sourcePath && sameDocumentIdentity(path, character.sourcePath),
    ),
  );
}

export function selectionOwner(db: SessionDatabase, characterId: string): string | null {
  const selection = readAdventureState(db);
  const player = Object.entries(selection.launch.players).find(
    ([, progress]) => progress.characterId === characterId && !progress.confirmed,
  );
  if (player) return player[0];
  return (
    selection.party.companions.find((seat) => selectedCompanionCharacter(seat) === characterId)
      ?.id ?? null
  );
}

export function selectedCompanionCharacter(seat: CompanionSeat): string | null {
  return seat.status === "reserved" ? seat.characterId : null;
}

export function characterAvailable(
  db: SessionDatabase,
  character: Character,
  controllerId: string,
) {
  const reservedBy = selectionOwner(db, character.id);
  return (
    !character.retired &&
    (!character.playerId || character.playerId === controllerId) &&
    (!reservedBy || reservedBy === controllerId)
  );
}

export function clearCompanionSelection(db: SessionDatabase, controllerId: string) {
  const current = readAdventureState(db).party.companions.find((item) => item.id === controllerId);
  if (!current || !selectedCompanionCharacter(current)) return;
  updateAdventureState(db, (selection) => {
    const index = selection.party.companions.findIndex((item) => item.id === controllerId);
    selection.party.companions[index] = { id: controllerId, status: "empty" };
  });
  markStateChanged(db);
}

/** 队友席位直接记录选中的角色；调用方持有写事务。 */
export function selectCompanionCharacter(
  db: SessionDatabase,
  characterId: string,
  controllerId: string,
) {
  const seat = readAdventureState(db).party.companions.find((item) => item.id === controllerId);
  const character = readCharacters(db).find((item) => item.id === characterId);
  const reservedBy = selectionOwner(db, characterId);
  if (
    !seat ||
    seat.status === "active" ||
    !character ||
    character.retired ||
    (character.playerId && character.playerId !== controllerId) ||
    (reservedBy && reservedBy !== controllerId)
  )
    throw new Error("角色已被占用，请选择其他角色");
  updateAdventureState(db, (selection) => {
    const index = selection.party.companions.findIndex((item) => item.id === controllerId);
    selection.party.companions[index] = { id: controllerId, status: "reserved", characterId };
  });
  markStateChanged(db);
}

export function claimCharacter(db: SessionDatabase, characterId: string, controllerId: string) {
  if (selectionOwner(db, characterId) !== controllerId)
    throw new Error("角色选择已变化，请返回重选");
  const character = readAdventureState(db).party.characters.find((item) => item.id === characterId);
  if (!character || character.playerId) throw new Error("角色已被选择");
  updateAdventureState(db, (selection) => {
    selection.party.characters.find((item) => item.id === characterId)!.playerId = controllerId;
  });
  clearCompanionSelection(db, controllerId);
}
