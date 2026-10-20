import type { DocumentType } from "@jointarp/module/document-type";
import type { ModuleDocument } from "@jointarp/module/module-document";

import { buildDocumentSheet, type DocumentSheetModel } from "../modules/document-sheet";

export type CharacterSheetModel = DocumentSheetModel;

export function buildCharacterSheet(
  documentType: DocumentType | undefined,
  values: Readonly<Record<string, unknown>>,
  body?: string,
  fieldErrors?: Readonly<Record<string, string>>,
  document?: Partial<ModuleDocument>,
): CharacterSheetModel {
  return buildDocumentSheet(
    { path: "", title: "", valid: true, values, body, fieldErrors, ...document },
    documentType,
  );
}
