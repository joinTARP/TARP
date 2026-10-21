import type { ModuleDocument } from "@shared/desktop-api";
import type { Character } from "@tarp/module/character";
import { createContext, lazy, Suspense, useContext, type ReactNode } from "react";

import { DocumentImageScope } from "../modules/document-image";

const LiveRoomDocument = lazy(() => import("./room-document-loader"));

export const RoomDocumentContext = createContext<string | undefined>(undefined);
export function useRoomDocumentId(): string | undefined {
  return useContext(RoomDocumentContext);
}
export type RoomDocumentErrorFallback = (error: Error, retry: () => void) => ReactNode;

/** 原始索引只用于定位；计算完成前不把原始元数据作为展示结果。 */
export function roomDocumentPlaceholder(
  document: ModuleDocument,
  unavailable = false,
): ModuleDocument {
  return {
    id: document.id,
    path: document.path,
    docType: document.docType,
    contentType: document.contentType,
    revision: document.revision,
    title: unavailable ? "资料暂不可用" : "正在读取资料…",
    valid: !unavailable,
    values: {},
  };
}
export function RoomDocumentScope({
  roomId,
  debug = false,
  children,
}: {
  roomId: string;
  debug?: boolean;
  children: ReactNode;
}) {
  return (
    <DocumentImageScope scope={`room:${roomId}`}>
      <RoomDocumentContext.Provider value={debug ? undefined : roomId}>
        {children}
      </RoomDocumentContext.Provider>
    </DocumentImageScope>
  );
}

/** 资料以房间、实体和内容版本隔离。旧请求即使晚到也不能填入新版本面板。 */
export function RoomDocument({
  document,
  children,
  errorFallback,
  pendingFallback,
}: {
  document: ModuleDocument;
  children: (value: ModuleDocument) => ReactNode;
  errorFallback?: RoomDocumentErrorFallback;
  pendingFallback?: ReactNode;
}) {
  const roomId = useContext(RoomDocumentContext);
  // 没有实体路径的建卡草稿已由临时文档计算入口处理。
  if (!roomId || !document.path) return children(document);
  return (
    <Suspense fallback={pendingFallback ?? children(roomDocumentPlaceholder(document))}>
      <LiveRoomDocument
        roomId={roomId}
        document={document}
        errorFallback={errorFallback}
        pendingFallback={pendingFallback}
      >
        {children}
      </LiveRoomDocument>
    </Suspense>
  );
}

export function RoomCharacter({
  character,
  children,
}: {
  character: Character;
  children: (value: Character) => ReactNode;
}) {
  if (!character.sourcePath) return children(character);
  return (
    <RoomDocument
      document={{
        id: character.id,
        path: character.sourcePath,
        title: character.name,
        docType: character.typeId,
        valid: true,
        values: character.values,
        description: character.description,
        image: character.image,
        avatar: character.avatar,
        body: character.body,
        fieldErrors: character.fieldErrors,
        displayValues: character.displayValues,
        displayErrors: character.displayErrors,
      }}
    >
      {(document) =>
        document.visible === false
          ? null
          : children({
              ...character,
              name: document.title,
              description: document.description ?? "",
              body: document.body,
              image: document.image,
              avatar: document.avatar,
              values: { ...document.values },
              fieldErrors: document.fieldErrors,
              displayValues: document.displayValues,
              displayErrors: document.displayErrors,
            })
      }
    </RoomDocument>
  );
}
