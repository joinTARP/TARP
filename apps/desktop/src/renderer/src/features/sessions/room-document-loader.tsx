import type { RoomEntity } from "@jointarp/core/shared/room-state";
import type { ModuleDocument } from "@shared/desktop-api";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { desktopRpc } from "../../desktop-rpc";
import { localRoomModuleLoader } from "./local-room-module";
import { roomConnection } from "./room-connection";
import { roomDocumentPlaceholder, type RoomDocumentErrorFallback } from "./room-document";
import { useRoomReplica } from "./use-room-state";

export default function LiveRoomDocument({
  roomId,
  document,
  children,
  errorFallback,
  pendingFallback,
}: {
  roomId: string;
  document: ModuleDocument;
  children: (value: ModuleDocument) => ReactNode;
  errorFallback?: RoomDocumentErrorFallback;
  pendingFallback?: ReactNode;
}) {
  const replica = useRoomReplica(roomId);
  const entity =
    (document.id && replica?.entities[document.id]) ||
    Object.values(replica?.entities ?? {}).find((item) => item.document.path === document.path);
  if (!entity)
    return !replica && pendingFallback !== undefined
      ? pendingFallback
      : children(roomDocumentPlaceholder(document, !!replica));
  return (
    <EntityDocument
      key={JSON.stringify([roomId, replica!.sections.viewerId, entity.id])}
      roomId={roomId}
      viewerId={replica!.sections.viewerId}
      document={document}
      entity={entity}
      version={replica!.documentRevision}
      errorFallback={errorFallback}
      pendingFallback={pendingFallback}
    >
      {children}
    </EntityDocument>
  );
}
function EntityDocument({
  roomId,
  viewerId,
  version,
  document,
  entity,
  children,
  errorFallback,
  pendingFallback,
}: {
  entity: RoomEntity;
  roomId: string;
  viewerId: string;
  version: number;
  document: ModuleDocument;
  children: (value: ModuleDocument) => ReactNode;
  errorFallback?: RoomDocumentErrorFallback;
  pendingFallback?: ReactNode;
}) {
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  const guarded =
    connection
      .getSnapshot()
      .resources?.documentTypes.some(
        (type) => type.id === document.docType && type.displayWhen !== undefined,
      ) ?? false;
  const details = useQuery({
    queryKey: ["room-document", viewerId, roomId, entity.document.path, version],
    queryFn: ({ signal }) =>
      roomConnection(desktopRpc.game, roomId, localRoomModuleLoader).loadDocument(entity, signal),
    placeholderData: guarded ? undefined : keepPreviousData,
    staleTime: Infinity,
    gcTime: 0,
  });
  const error =
    details.error ?? (details.data && !details.data.valid ? new Error("资料计算失败") : undefined);
  const retry = () => void details.refetch();
  if (error && errorFallback) return errorFallback(error, retry);
  if (details.isPending && pendingFallback !== undefined) return pendingFallback;
  const current = error
    ? roomDocumentPlaceholder(document, true)
    : (details.data ?? roomDocumentPlaceholder(document));
  const projected = guarded && (error || !details.data) ? { ...current, visible: false } : current;
  return (
    <>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          资料读取失败{" "}
          <button type="button" className="underline" onClick={retry}>
            重试
          </button>
        </p>
      ) : null}
      {children(projected)}
    </>
  );
}
