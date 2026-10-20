import { DocumentSheet } from "../modules/DocumentSheet";
import type { CharacterSheetModel } from "./character-sheet";

export function CharacterSheet({
  sheet,
  compact = false,
}: {
  sheet: CharacterSheetModel;
  compact?: boolean;
}) {
  return <DocumentSheet sheet={sheet} compact={compact} />;
}
