import { documentDetailTemplate } from "@jointarp/module/document-templates";
import type { DocumentType } from "@jointarp/module/document-type";
import { isDocumentVisible } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";

import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { RoomDocument } from "../sessions/room-document";
import { useDocumentLibrary } from "./document-library-context";
import { DocumentFieldErrors } from "./DocumentFieldErrors";
import { DocumentRenderer } from "./DocumentRenderer";
import { DocumentValue } from "./DocumentValue";

function DocumentDetailContent({
  document,
  documentType,
  imagePath,
  scrollable = false,
}: {
  readonly document: ModuleDocument;
  readonly documentType?: DocumentType;
  readonly imagePath?: string;
  readonly compact?: boolean;
  /** 弹窗双栏各自滚动，嵌入页面的详情沿用页面滚动。 */
  readonly scrollable?: boolean;
}) {
  const library = useDocumentLibrary();
  if (!library && !isDocumentVisible(document, documentType)) return null;
  const template = documentDetailTemplate(documentType);
  const context = { document, documentType, library, imagePath };
  const columns =
    scrollable && documentType?.layout?.type === "split"
      ? [
          {
            label: "基础资料",
            template: documentDetailTemplate(documentType, "detail", "primary"),
          },
          {
            label: "详细内容",
            template: documentDetailTemplate(documentType, "detail", "content"),
          },
        ]
      : undefined;
  return (
    <div
      className={`min-w-0 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:max-w-full ${columns ? "flex min-h-0 flex-1 flex-col overflow-hidden" : ""}`}
    >
      <DocumentFieldErrors errors={document.fieldErrors} documentType={documentType} />
      {columns ? (
        <div
          className={`grid min-h-0 flex-1 gap-6 ${columns.length > 1 ? "grid-rows-2 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:grid-rows-1 md:gap-8" : "grid-cols-1 grid-rows-1"}`}
        >
          {columns.map(({ label, template }, index) => (
            <ScrollAreaPane
              key={index}
              className="min-h-0"
              viewportClassName="overscroll-contain [overflow-wrap:anywhere]"
              contentClassName="pb-2 pr-3"
              viewportProps={{ "aria-label": `${label}滚动区` }}
            >
              <DocumentRenderer layout={template} context={context} />
            </ScrollAreaPane>
          ))}
        </div>
      ) : (
        <DocumentRenderer layout={template} context={context} />
      )}
      {!documentType && document.values ? <DocumentValue value={document.values} /> : null}
    </div>
  );
}

export function DocumentDetail(props: Parameters<typeof DocumentDetailContent>[0]) {
  return (
    <RoomDocument document={props.document}>
      {(document) => <DocumentDetailContent {...props} document={document} />}
    </RoomDocument>
  );
}
