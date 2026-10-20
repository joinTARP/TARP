import type { ModuleDocument } from "@shared/desktop-api";
import { useMemo, type ReactNode } from "react";

import type { ReferenceCollectionRow } from "../modules/reference-collection";
import { ComputedReferenceItems } from "../modules/ReferenceItemDocument";
import { computedCollectionRows } from "../modules/room-collection-rows";
import { useRoomVisibleDocuments } from "./use-room-visible-documents";

export default function RoomCollectionLoader({
  roomId,
  documents,
  rows,
  children,
}: {
  roomId: string;
  documents: readonly ModuleDocument[];
  rows: readonly ReferenceCollectionRow[];
  children: (rows: ReferenceCollectionRow[]) => ReactNode;
}) {
  const current = useRoomVisibleDocuments(roomId, documents);
  const computed = useMemo(() => computedCollectionRows(rows, current), [rows, current]);
  return <ComputedReferenceItems>{children(computed)}</ComputedReferenceItems>;
}
