import { QueryClientContext } from "@tanstack/react-query";
import { useContext, type ReactNode } from "react";

import { ImagePreviewContext } from "../../components/ImagePreview";
import { TooltipProvider } from "../../components/ui/tooltip";
import { RoomDocumentContext } from "../sessions/room-document";
import { DocumentImageContext } from "./document-image";
import { LibraryContext } from "./document-library-context";
import { DocumentSheetAncestors } from "./document-sheet-context";
import { ReferenceContext } from "./DocumentReferences";

/** 仅供内置渲染器使用，不属于模组模板数据或公开扩展 API。 */
export function useDocumentRendererRuntime() {
  return {
    images: useContext(DocumentImageContext),
    library: useContext(LibraryContext),
    ancestors: useContext(DocumentSheetAncestors),
    references: useContext(ReferenceContext),
    room: useContext(RoomDocumentContext),
    queryClient: useContext(QueryClientContext),
    imagePreview: useContext(ImagePreviewContext),
  };
}
export type DocumentRendererRuntime = ReturnType<typeof useDocumentRendererRuntime>;

export function DocumentRendererEnvironment({
  runtime,
  children,
}: {
  runtime: DocumentRendererRuntime;
  children: ReactNode;
}) {
  return (
    <QueryClientContext value={runtime.queryClient}>
      <RoomDocumentContext value={runtime.room}>
        <DocumentImageContext value={runtime.images}>
          <LibraryContext value={runtime.library}>
            <DocumentSheetAncestors value={runtime.ancestors}>
              <ReferenceContext value={runtime.references}>
                <ImagePreviewContext value={runtime.imagePreview}>
                  <TooltipProvider>{children}</TooltipProvider>
                </ImagePreviewContext>
              </ReferenceContext>
            </DocumentSheetAncestors>
          </LibraryContext>
        </DocumentImageContext>
      </RoomDocumentContext>
    </QueryClientContext>
  );
}
