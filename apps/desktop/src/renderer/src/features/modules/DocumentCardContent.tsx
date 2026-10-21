import { defaultDocumentCard, type DocumentType } from "@jointarp/module/document-type";
import { isDocumentVisible } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";
import type { SyntheticEvent } from "react";

import { Tooltip } from "../../components/ui/tooltip";
import { useDocumentLibrary } from "./document-library-context";
import { getPreviewDescription } from "./document-preview";
import { DocumentCover } from "./DocumentCover";
import { DocumentFieldErrors } from "./DocumentFieldErrors";
import { DocumentPreviewFields } from "./DocumentPreview";
import { DocumentRenderer } from "./DocumentRenderer";

/** 内置引用、图片预览等操作不同时触发外层卡片的打开或选择。 */
function stopContentAction(event: SyntheticEvent) {
  for (const node of event.nativeEvent.composedPath()) {
    if (node === event.currentTarget) break;
    if (
      node instanceof Element &&
      node.matches('a[href],button,input,select,textarea,summary,[role="button"],[role="link"]')
    ) {
      event.stopPropagation();
      break;
    }
  }
}

/** 模组文档和角色选择共用的卡片内容；点击行为由调用方决定。 */
export function DocumentCardContent({
  document,
  documentType,
  subtitle,
}: {
  readonly document: ModuleDocument;
  readonly documentType?: DocumentType;
  readonly subtitle?: string;
}) {
  const library = useDocumentLibrary();
  if (!library && !isDocumentVisible(document, documentType)) return null;
  const card = documentType?.layout?.card ?? defaultDocumentCard;
  if (card.content)
    return (
      <div
        className="w-full min-w-0 flex-1 [overflow-wrap:anywhere]"
        onClick={stopContentAction}
        onKeyDown={stopContentAction}
      >
        <DocumentFieldErrors errors={document.fieldErrors} documentType={documentType} />
        <DocumentRenderer layout={card.content} context={{ document, documentType, library }} />
      </div>
    );
  const description = card.descriptionLines > 0 ? getPreviewDescription(document) : undefined;
  return (
    <div className="flex min-h-36 w-full flex-1 flex-col">
      {card.image === "cover" ? (
        <DocumentCover
          className="w-full shrink-0 bg-transparent"
          imageAspect={card.imageAspect}
          src={document.image}
          path={document.path}
          title={document.title}
        />
      ) : null}
      <div className="min-h-0 w-full min-w-0 flex-1 px-4 py-3.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <Tooltip content={document.title} overflowOnly>
            <h2 className="truncate text-sm font-semibold">{document.title}</h2>
          </Tooltip>
          {subtitle ? (
            <span className="text-muted-foreground shrink-0 text-[11px]">{subtitle}</span>
          ) : null}
        </div>
        {document.error ? (
          <p className="text-destructive mt-1 line-clamp-2 text-xs leading-5">{document.error}</p>
        ) : description ? (
          <p
            className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5"
            style={{ WebkitLineClamp: card.descriptionLines }}
          >
            {description}
          </p>
        ) : null}
        <DocumentFieldErrors
          errors={document.fieldErrors}
          documentType={documentType}
          shownPaths={card.fields}
          metadataOnly
        />
        {card.fields.length > 0 ? (
          <div className="mt-3">
            <DocumentPreviewFields
              document={document}
              documentType={documentType}
              fields={card.fields}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
