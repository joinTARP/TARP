import type { ModuleDocument } from "@shared/desktop-api";
import { defaultDocumentList, type DocumentType } from "@tarp/module/document-type";
import { FileText } from "lucide-react";
import { useEffect } from "react";

import { preloadDocumentMarkdown } from "./document-markdown";
import { DocumentCard } from "./DocumentCard";
import { DocumentTable } from "./DocumentTable";

interface ModuleDocumentsProps {
  readonly documents: readonly ModuleDocument[];
  readonly documentTypes: readonly DocumentType[];
  readonly selectedDocumentPath: string | null;
  readonly onSelectDocument: (path: string | null) => void;
}

export function ModuleDocuments({
  documents,
  documentTypes,
  selectedDocumentPath,
  onSelectDocument,
}: ModuleDocumentsProps) {
  const typeId = documents[0]?.docType ?? "__untyped__";
  const documentType = documentTypes.find((type) => type.id === typeId);
  const layout = documentType?.layout?.list ?? defaultDocumentList;
  useEffect(() => {
    if (!documents.length) return;
    if (!window.requestIdleCallback) {
      const timer = window.setTimeout(preloadDocumentMarkdown, 1500);
      return () => window.clearTimeout(timer);
    }
    const idle = window.requestIdleCallback(preloadDocumentMarkdown, { timeout: 1500 });
    return () => window.cancelIdleCallback(idle);
  }, [documents.length]);

  if (documents.length === 0) {
    return (
      <div className="border-border bg-card/40 rounded-2xl border border-dashed px-6 py-16 text-center">
        <FileText className="text-muted-foreground mx-auto size-8" strokeWidth={1.5} />
        <p className="mt-4 text-sm font-medium">还没有文档</p>
      </div>
    );
  }
  if (layout.type === "table") {
    return (
      <DocumentTable
        documents={documents}
        documentType={documentType}
        layout={layout}
        selectedDocumentPath={selectedDocumentPath}
        onSelectDocument={onSelectDocument}
      />
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {documents.map((document) => {
        const open = selectedDocumentPath === document.path;
        const documentType = documentTypes.find((type) => type.id === document.docType);
        return (
          <li className="min-w-0" key={document.path}>
            <DocumentCard
              document={document}
              documentType={documentType}
              open={open}
              onOpenChange={(nextOpen) => onSelectDocument(nextOpen ? document.path : null)}
            />
          </li>
        );
      })}
    </ul>
  );
}
