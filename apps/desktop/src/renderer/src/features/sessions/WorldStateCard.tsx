import type { GameSession } from "@tarp/core/shared/session";
import type { DocumentType } from "@tarp/module/document-type";
import type { ModuleDocument } from "@tarp/module/module-document";
import { isDocumentVisible } from "@tarp/module/module-document";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { buildDocumentSheet } from "../modules/document-sheet";
import { DocumentSheet } from "../modules/DocumentSheet";
import { RoomDocument } from "./room-document";

export function WorldStateCardContent({
  document,
  documentType,
}: {
  document: ModuleDocument;
  documentType: DocumentType;
}) {
  const [open, setOpen] = useState(true);
  const visible = !!documentType.layout?.sheet && isDocumentVisible(document, documentType);
  if (!visible) return null;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group/world border-border/40 mb-3 border-t pt-4"
    >
      <summary className="text-muted-foreground mb-3 flex cursor-pointer list-none items-center justify-between text-[11px] font-medium [&::-webkit-details-marker]:hidden">
        {document.title}
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform group-not-open/world:-rotate-90"
        />
      </summary>
      <DocumentSheet sheet={buildDocumentSheet(document, documentType)} compact />
    </details>
  );
}

export function WorldStateCard({ session }: { session: GameSession }) {
  const types = new Map(
    session.documentTypes
      .filter((type) => type.designation === "world_state" && type.layout?.sheet)
      .map((type) => [type.id, type]),
  );
  return (
    <>
      {session.documents.map((document) => {
        const type = types.get(document.docType ?? "");
        if (!type) return null;
        return (
          <RoomDocument
            key={document.id ?? document.path}
            document={document}
            pendingFallback={
              <p role="status" className="text-muted-foreground mb-5 text-sm">
                正在读取世界状态…
              </p>
            }
            errorFallback={(_error, retry) => (
              <div role="alert" className="border-border/60 mb-5 border-b pb-5 text-sm">
                <p className="text-destructive">世界状态读取失败</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={retry}>
                  重试
                </Button>
              </div>
            )}
          >
            {(value) => <WorldStateCardContent document={value} documentType={type} />}
          </RoomDocument>
        );
      })}
    </>
  );
}
