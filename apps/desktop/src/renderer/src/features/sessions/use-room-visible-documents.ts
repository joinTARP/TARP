import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";
import { useQueries } from "@tanstack/react-query";
import type { ChatMessage } from "@tarp/core/shared/game";
import { useMemo } from "react";

import { desktopRpc } from "../../desktop-rpc";
import { localRoomModuleLoader } from "./local-room-module";
import { npcPortraitDocuments } from "./npc-portrait-documents";
import { roomConnection } from "./room-connection";
import { useRoomReplica } from "./use-room-state";

/** 仅加载调用方正在使用的资料，查询与详情面板共享，版本更新立即撤下旧图片。 */
export function useRoomDocumentViews(roomId: string, documents: readonly ModuleDocument[]) {
  const replica = useRoomReplica(roomId);
  const entities = useMemo(() => {
    if (!replica || !documents.length) return [];
    const paths = new Set(documents.map((document) => documentIdentity(document.path)));
    return Object.values(replica.entities).filter((entity) =>
      paths.has(documentIdentity(entity.document.path)),
    );
  }, [replica, documents]);
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  return useQueries({
    queries: entities.map((entity) => ({
      queryKey: [
        "room-document",
        replica!.sections.viewerId,
        roomId,
        entity.document.path,
        replica!.documentRevision,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) => connection.loadDocument(entity, signal),
      staleTime: Infinity,
      gcTime: 0,
    })),
    combine: (queries) => ({
      documents: queries.flatMap((query) => (query.data ? [query.data] : [])),
      isPending: queries.some((query) => query.isPending),
      error: queries.find((query) => query.error)?.error,
      refetch: () => Promise.all(queries.map((query) => query.refetch())),
    }),
  });
}

export function useRoomVisibleDocuments(roomId: string, documents: readonly ModuleDocument[]) {
  return useRoomDocumentViews(roomId, documents).documents;
}

/** 按发言中的路径按需读取公开投影，不扫描其他角色的别名。 */
export function useRoomNpcDocuments(
  roomId: string,
  messages: readonly ChatMessage[],
  documents: readonly ModuleDocument[],
  playerNames: ReadonlySet<string>,
) {
  const selected = useMemo(
    () => npcPortraitDocuments(messages, documents, playerNames),
    [messages, documents, playerNames],
  );
  return useRoomVisibleDocuments(roomId, selected).filter((document) => document.visible !== false);
}
