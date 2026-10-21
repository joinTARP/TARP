import { documentIdentity } from "@tarp/module/document-path";
import { isDocumentVisible } from "@tarp/module/module-document";
import { useContext } from "react";

import { useDocumentLibrary } from "./document-library-context";
import type { DocumentSheetModel } from "./document-sheet";
import { DocumentSheetAncestors } from "./document-sheet-context";
import { DocumentFieldErrors } from "./DocumentFieldErrors";
import { DocumentRenderer } from "./DocumentRenderer";
import { DocumentValue } from "./DocumentValue";

/** 世界卡、角色卡共用布局与公开字段渲染，不自行订阅房间。 */
export function DocumentSheet({
  sheet,
  compact = false,
}: {
  sheet: DocumentSheetModel;
  compact?: boolean;
}) {
  const library = useDocumentLibrary();
  const ancestors = useContext(DocumentSheetAncestors);
  const trail = sheet.document.path
    ? [...ancestors, documentIdentity(sheet.document.path)]
    : ancestors;
  if (!library && !isDocumentVisible(sheet.document, sheet.documentType)) return null;
  return (
    <DocumentSheetAncestors.Provider value={trail}>
      <div className={`min-w-0 [overflow-wrap:anywhere] ${compact ? "text-sm" : ""}`}>
        <DocumentFieldErrors
          errors={sheet.document.fieldErrors}
          documentType={sheet.documentType}
        />
        <DocumentRenderer
          layout={sheet.template}
          context={{ document: sheet.document, documentType: sheet.documentType, library }}
        />
        {!sheet.documentType ? <DocumentValue value={sheet.document.values} /> : null}
      </div>
    </DocumentSheetAncestors.Provider>
  );
}
