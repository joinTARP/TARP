import type { ModuleDocument } from "@shared/desktop-api";
import type { DocumentType } from "@tarp/module/document-type";
import { isDocumentVisible } from "@tarp/module/module-document";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { preload } from "react-dom";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { RoomDocument } from "../sessions/room-document";
import { useDocumentImage } from "./document-image";
import { useDocumentLibrary } from "./document-library-context";
import { preloadDocumentMarkdown } from "./document-markdown";
import { DocumentDetail } from "./DocumentDetail";

function ResolvedDocumentDialog({
  document,
  documentType,
  trigger,
  open,
  onOpenChange,
  body,
  footer,
}: {
  document: ModuleDocument;
  documentType?: DocumentType;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 替换默认详情。选角需要在详情外包一层只读引用。 */
  body?: ReactNode;
  footer?: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const library = useDocumentLibrary();
  const hidden = !library && !isDocumentVisible(document, documentType);
  useEffect(() => {
    if (hidden && open) onOpenChange?.(false);
  }, [hidden, open, onOpenChange]);
  const src = useDocumentImage(document.path, hidden ? undefined : document.image);
  if (hidden)
    return open ? (
      <p role="status" className="text-muted-foreground text-sm">
        资料当前不可见
      </p>
    ) : null;
  const split = documentType?.layout?.type === "split";
  const preloadContent = () => {
    preloadDocumentMarkdown();
    if (src) preload(src, { as: "image" });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={trigger as ReactElement}
        onPointerEnter={preloadContent}
        onFocus={preloadContent}
        onPointerDown={preloadContent}
      />
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        finalFocus={false}
        style={
          documentType?.layout?.width === undefined
            ? undefined
            : {
                width: `min(${documentType.layout.width}px, calc(100dvw - 3rem))`,
                maxWidth: "calc(100dvw - 3rem)",
              }
        }
        className={`flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 ${split ? "h-[88dvh] sm:max-w-[1000px]" : "sm:max-w-[800px]"}`}
      >
        <DialogTitle className="sr-only">{document.title}</DialogTitle>
        <DialogDescription className="sr-only">
          {documentType?.name ?? "文档详情"}
        </DialogDescription>
        {split ? (
          <div className="flex min-h-0 flex-1 flex-col px-6 pt-12 pb-6 md:px-8 md:pb-8">
            {document.error ? (
              <p role="alert" className="text-destructive mb-4 text-sm">
                {document.error}
              </p>
            ) : null}
            {body ?? <DocumentDetail document={document} documentType={documentType} scrollable />}
          </div>
        ) : (
          <ScrollAreaPane
            className="min-h-0 flex-1"
            viewportClassName="overscroll-contain [overflow-wrap:anywhere]"
          >
            <div className="min-w-0 px-6 pt-12 pb-6 md:px-8 md:pb-8">
              {document.error ? (
                <p role="alert" className="text-destructive mb-4 text-sm">
                  {document.error}
                </p>
              ) : null}
              {body ?? <DocumentDetail document={document} documentType={documentType} />}
            </div>
          </ScrollAreaPane>
        )}
        {footer ? <div className="border-border shrink-0 border-t px-6 py-4">{footer}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

/** 标题、封面和正文使用同一份本地计算资料。 */
export function DocumentDialog(props: Parameters<typeof ResolvedDocumentDialog>[0]) {
  return (
    <RoomDocument document={props.document}>
      {(document) => <ResolvedDocumentDialog {...props} document={document} />}
    </RoomDocument>
  );
}
