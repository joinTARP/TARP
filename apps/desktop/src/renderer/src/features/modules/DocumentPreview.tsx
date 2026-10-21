import type { ModuleDocument } from "@shared/desktop-api";
import { defaultDocumentHover, type DocumentType } from "@tarp/module/document-type";
import { isDocumentVisible } from "@tarp/module/module-document";
import type { ReactNode } from "react";

import { RoomDocument } from "../sessions/room-document";
import { useDocumentLibrary } from "./document-library-context";
import { getPreviewDescription, getPreviewFields } from "./document-preview";
import { DocumentCover } from "./DocumentCover";
import { DocumentFieldErrors } from "./DocumentFieldErrors";
import { DocumentRenderer } from "./DocumentRenderer";
import { FieldCalculationError } from "./FieldCalculationError";

export function DocumentPreviewFields({
  document,
  documentType,
  fields,
  columns = 2,
}: {
  readonly document: ModuleDocument;
  readonly documentType?: DocumentType;
  readonly fields: readonly string[];
  readonly columns?: 1 | 2;
}) {
  const library = useDocumentLibrary();
  const entries = getPreviewFields(document, documentType, fields, library);
  if (!entries.length) return null;
  return (
    <dl
      className={`grid min-w-0 gap-x-4 gap-y-3 text-xs ${columns === 2 ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {entries.map((entry) => (
        <div key={entry.path} className="min-w-0">
          <dt className="text-muted-foreground mb-1">{entry.label}</dt>
          <dd className="line-clamp-2 leading-5 [overflow-wrap:anywhere]">
            {entry.error ? <FieldCalculationError error={entry.error} /> : entry.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentPreviewContent({
  document,
  documentType,
  children,
}: {
  readonly document: ModuleDocument;
  readonly documentType?: DocumentType;
  readonly children?: ReactNode;
}) {
  const library = useDocumentLibrary();
  if (!library && !isDocumentVisible(document, documentType)) return null;
  const config = documentType?.layout?.hover ?? defaultDocumentHover;
  if (!config.enabled) return null;
  if (config.content)
    return (
      <div className="min-w-0 space-y-4 p-4 [overflow-wrap:anywhere]">
        <DocumentFieldErrors errors={document.fieldErrors} documentType={documentType} />
        <DocumentRenderer layout={config.content} context={{ document, documentType, library }} />
        {children}
      </div>
    );
  const description = config.descriptionLines > 0 ? getPreviewDescription(document) : undefined;
  return (
    <div className="space-y-4 p-4">
      {config.image === "cover" && document.image ? (
        <DocumentCover
          src={document.image}
          path={document.path}
          title={document.title}
          className="w-full rounded-lg"
          imageAspect={config.imageAspect}
        />
      ) : null}
      <div className="flex items-center gap-3">
        {config.image === "thumbnail" && document.image ? (
          <DocumentCover
            src={document.image}
            path={document.path}
            title={document.title}
            className="w-16 shrink-0 rounded-lg"
            imageAspect={config.imageAspect}
          />
        ) : null}
        <div className="min-w-0">
          <p className="text-sm font-semibold break-words">{document.title}</p>
          <p className="text-muted-foreground mt-1 text-xs">{documentType?.name ?? "文档"}</p>
        </div>
      </div>
      {description ? (
        <p
          className="text-muted-foreground line-clamp-3 text-xs leading-6 whitespace-pre-wrap"
          style={{ WebkitLineClamp: config.descriptionLines }}
        >
          {description}
        </p>
      ) : null}
      <DocumentFieldErrors
        errors={document.fieldErrors}
        documentType={documentType}
        shownPaths={config.fields}
        metadataOnly
      />
      <DocumentPreviewFields
        document={document}
        documentType={documentType}
        fields={config.fields}
        columns={config.columns}
      />
      {children}
      <p className="text-muted-foreground border-border/60 border-t pt-3 text-[11px]">
        点击引用查看详情
      </p>
    </div>
  );
}

export function DocumentPreview(props: Parameters<typeof DocumentPreviewContent>[0]) {
  return (
    <RoomDocument document={props.document}>
      {(document) => <DocumentPreviewContent {...props} document={document} />}
    </RoomDocument>
  );
}
