import { documentDetailTemplate } from "@tarp/module/document-templates";
import type { DocumentPresentation } from "@tarp/module/document-templates";
import type { DocumentType } from "@tarp/module/document-type";
import type { ModuleDocument } from "@tarp/module/module-document";

export interface DocumentSheetModel {
  template: DocumentPresentation;
  document: ModuleDocument;
  documentType?: DocumentType;
}
export function buildDocumentSheet(
  document: ModuleDocument,
  documentType?: DocumentType,
): DocumentSheetModel {
  return { template: documentDetailTemplate(documentType, "sheet"), document, documentType };
}
