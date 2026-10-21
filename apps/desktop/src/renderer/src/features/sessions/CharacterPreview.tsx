import type { Character, CharacterDraft } from "@tarp/module/character";
import type { DocumentType } from "@tarp/module/document-type";

import { DocumentDetail } from "../modules/DocumentDetail";
import { DocumentReferences, type ReferenceDocument } from "../modules/DocumentReferences";

/** 角色确认页沿用模组详情布局，引用使用开局阶段的公开文档快照。 */
export function CharacterPreview({
  character,
  type,
  types,
  references,
}: {
  character: Pick<CharacterDraft, "name" | "description" | "values"> &
    Pick<
      Partial<Character>,
      "body" | "image" | "sourcePath" | "typeId" | "displayValues" | "displayErrors" | "fieldErrors"
    >;
  type?: DocumentType;
  types?: readonly DocumentType[];
  references: readonly ReferenceDocument[];
}) {
  const split = type?.layout?.type === "split";
  return (
    <DocumentReferences documents={references} types={types ?? (type ? [type] : [])}>
      <div className={split ? "min-w-0" : "min-w-0 space-y-5 p-5 sm:p-7"}>
        <DocumentDetail
          document={{
            path: "",
            title: character.name || "未命名角色",
            description: character.description,
            image: character.image,
            body: character.body,
            valid: true,
            values: character.values,
            fieldErrors: character.fieldErrors,
            displayValues: character.displayValues,
            displayErrors: character.displayErrors,
          }}
          documentType={type}
          imagePath={character.sourcePath ?? `${character.typeId ?? type?.id}/draft.json`}
        />
      </div>
    </DocumentReferences>
  );
}
