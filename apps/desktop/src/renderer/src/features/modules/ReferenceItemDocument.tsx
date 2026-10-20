import type { ModuleDocument } from "@shared/desktop-api";
import { createContext, useContext, type ReactNode } from "react";

import { RoomDocument } from "../sessions/room-document";
import { useDocumentReferenceDocument } from "./DocumentReferences";
import type { ReferenceCollectionRow } from "./reference-collection";

const ComputedItemsContext = createContext(false);

/** 集合已在搜索前取得同版投影，条目直接消费它，避免再次借用旧版本内容。 */
export function ComputedReferenceItems({ children }: { children: ReactNode }) {
  return <ComputedItemsContext.Provider value>{children}</ComputedItemsContext.Provider>;
}

/** 只读取正在展示的引用；未揭示或已撤销的图片不会从原始索引补回。 */
export function ReferenceItemDocument({
  row,
  children,
}: {
  row: ReferenceCollectionRow;
  children: (row: ReferenceCollectionRow) => ReactNode;
}) {
  const document = useDocumentReferenceDocument(row.reference);
  const computed = useContext(ComputedItemsContext);
  if (computed || !document) return children(row);
  return (
    <RoomDocument document={{ ...document, valid: document.valid ?? true } as ModuleDocument}>
      {(current) =>
        current.visible === false
          ? null
          : children({
              ...row,
              title: current.title,
              image: current.valid ? current.image : undefined,
              path: current.path,
              unavailable: !current.valid,
            })
      }
    </RoomDocument>
  );
}
