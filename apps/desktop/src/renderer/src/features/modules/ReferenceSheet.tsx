import { documentIdentity } from "@jointarp/module/document-path";
import { isDocumentVisible } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";
import { useContext } from "react";

import { Button } from "../../components/ui/button";
import { RoomDocument } from "../sessions/room-document";
import { useDocumentLibrary } from "./document-library-context";
import { buildDocumentSheet } from "./document-sheet";
import { DocumentSheetAncestors } from "./document-sheet-context";
import {
  DocumentReference,
  useDocumentReferenceDocument,
  useDocumentReferenceType,
} from "./DocumentReferences";
import { DocumentSheet } from "./DocumentSheet";

/** 引用目标自己的 sheet 决定字段和布局，组件不识别怪物或战斗规则。 */
export function ReferenceSheet({ reference }: { reference?: string }) {
  const document = useDocumentReferenceDocument(reference);
  const documentType = useDocumentReferenceType(document?.docType);
  const ancestors = useContext(DocumentSheetAncestors);
  const library = useDocumentLibrary();
  if (!document || !reference) return <p className="text-muted-foreground text-xs">资料暂不可用</p>;
  return (
    <RoomDocument
      document={{ ...document, valid: document.valid ?? true } as ModuleDocument}
      pendingFallback={
        <p role="status" className="text-muted-foreground text-xs">
          正在读取资料…
        </p>
      }
      errorFallback={(_error, retry) => (
        <div role="alert" className="space-y-2 text-xs">
          <p className="text-destructive">资料读取失败</p>
          <Button variant="outline" size="sm" onClick={retry}>
            重试
          </Button>
        </div>
      )}
    >
      {(current) => {
        if (!library && !isDocumentVisible(current, documentType)) return null;
        if (!current.valid) return <p className="text-muted-foreground text-xs">资料暂不可用</p>;
        const limited = ancestors.length >= 4 || ancestors.includes(documentIdentity(current.path));
        return (
          <div className="min-w-0 space-y-3">
            {limited ? (
              <p className="text-muted-foreground text-xs">嵌入已折叠，请打开详情查看。</p>
            ) : (
              <DocumentSheet sheet={buildDocumentSheet(current, documentType)} compact />
            )}
            <div className="text-xs">
              <DocumentReference value={reference}>查看{current.title}详情</DocumentReference>
            </div>
          </div>
        );
      }}
    </RoomDocument>
  );
}
