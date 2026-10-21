import type { GameSession } from "@jointarp/core/shared/session";
import type { Character } from "@jointarp/module/character";
import type { DocumentType } from "@jointarp/module/document-type";

import { DocumentReferences } from "../modules/DocumentReferences";
import { buildCharacterSheet } from "./character-sheet";
import { CharacterSheet } from "./CharacterSheet";
import { RoomCharacter } from "./room-document";

const emptyDocuments: GameSession["documents"] = [];
const emptyTypes: GameSession["documentTypes"] = [];

/** 聊天侧栏与模组面板共用同一份公开角色数据。 */
function CharacterSummaryContent({
  character,
  documentType,
  compact = false,
  session,
}: {
  character: Character;
  documentType?: DocumentType;
  compact?: boolean;
  session?: GameSession;
}) {
  const sheet = buildCharacterSheet(
    documentType,
    character.values,
    character.body,
    character.fieldErrors,
    {
      path: character.sourcePath ?? "",
      title: character.name,
      description: character.description,
      image: character.image,
      avatar: character.avatar,
      displayValues: character.displayValues,
      displayErrors: character.displayErrors,
    },
  );
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <DocumentReferences
        documents={session?.documents ?? emptyDocuments}
        types={session?.documentTypes ?? emptyTypes}
        view={session ? "game" : "module"}
      >
        <CharacterSheet sheet={sheet} compact={compact} />
      </DocumentReferences>
    </div>
  );
}

export function CharacterSummary(props: Parameters<typeof CharacterSummaryContent>[0]) {
  return (
    <RoomCharacter character={props.character}>
      {(character) => <CharacterSummaryContent {...props} character={character} />}
    </RoomCharacter>
  );
}
