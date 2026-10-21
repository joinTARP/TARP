import { documentDetailTemplate } from "@jointarp/module/document-templates";
import type { DocumentPresentation } from "@jointarp/module/document-templates";
import type { DocumentType } from "@jointarp/module/document-type";
import type { ModuleDocument } from "@jointarp/module/module-document";

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
