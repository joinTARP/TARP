import type { Character } from "@jointarp/module/character";
import { sameDocumentIdentity } from "@jointarp/module/document-path";

import type { SessionDatabase } from "../storage/session-database";
import { readCharacters } from "./character-db";
import { isPlayableCharacter, selectionOwner } from "./character-ownership";
import { readLaunchConfig, readLaunchRoom } from "./launch-db";

export function moduleCompanionPrompt(
  db: SessionDatabase,
  character: Character,
): string | undefined {
  const config = readLaunchConfig(db);
  if (!config || !character.sourcePath || !isPlayableCharacter(db, character)) return;
  const start = config.gameStarts.find((item) => item.id === readLaunchRoom(db).startId);
  return Object.entries(start?.aiCompanions ?? {}).find(([path]) =>
    sameDocumentIdentity(path, character.sourcePath!),
  )?.[1];
}

export function hasAvailableCompanion(db: SessionDatabase): boolean {
  return readCharacters(db).some(
    (character) =>
      !character.playerId &&
      !selectionOwner(db, character.id) &&
      Boolean(moduleCompanionPrompt(db, character)),
  );
}
