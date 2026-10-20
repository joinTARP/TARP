import { documentIdentity, typeFormatLabel } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";
import { searchItems } from "@shared/query";
import type { GameSession } from "@tarp/core/shared/session";
import { BookOpenText, FileCode2, FileText, Library } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { ModuleDocuments } from "../modules/ModuleDocuments";
import {
  ModuleNavGroups,
  ModuleNavIcon,
  ModuleNavScroll,
  ModuleNavSearch,
  moduleNavItemClass,
  type ModuleNavGroup,
  type ModuleNavItem,
} from "../modules/ModuleNavigation";
import { ModuleReading } from "../modules/ModuleReading";
import { ModuleContent } from "../modules/ModuleWorkspace";
import { useRoomDocumentId } from "./room-document";
import { useRoomVisibleDocuments } from "./use-room-visible-documents";

const untypedId = "__untyped__";

export function RoomModule({
  session,
  onDocumentOpen,
}: {
  readonly session: GameSession;
  onDocumentOpen?: () => void;
}) {
  const roomId = useRoomDocumentId();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const documentItems = useMemo((): readonly ModuleNavItem[] => {
    const types: ModuleNavItem[] = session.documentTypes.map((documentType) => ({
      id: documentType.id,
      label: documentType.name,
      icon:
        typeFormatLabel(documentType.id, session.documents) === "Markdown" ? FileText : FileCode2,
    }));
    if (session.documents.some((document) => !document.docType)) {
      return [...types, { id: untypedId, label: "未分类", icon: FileCode2 }];
    }
    return types;
  }, [session]);
  const readingItems = useMemo((): readonly ModuleNavItem[] => {
    return session.pages.map((item) => ({
      id: `reading:${item.path}`,
      label: item.title,
      icon: BookOpenText,
      reading: item.path,
    }));
  }, [session.pages]);
  const groups = useMemo((): readonly ModuleNavGroup[] => {
    const documents = searchQuery.trim()
      ? searchItems(documentItems, searchQuery, (item) => [item.label, item.id])
      : documentItems;
    const readings = searchQuery.trim()
      ? searchItems(readingItems, searchQuery, (item) => [item.label, item.reading ?? ""])
      : readingItems;
    return [
      ...(readings.length > 0 ? [{ label: "阅读", items: readings }] : []),
      ...(documents.length > 0 ? [{ label: "文档", items: documents }] : []),
    ];
  }, [documentItems, readingItems, searchQuery]);
  const selectable = [...readingItems, ...documentItems];
  const current =
    selectable.find((item) => item.id === activeId) ?? documentItems[0] ?? readingItems[0];
  const selectedReading = current?.reading
    ? session.pages.find((page) => page.path === current.reading)
    : undefined;
  const selectedDocuments = current
    ? session.documents.filter((document) =>
        current.id === untypedId ? !document.docType : document.docType === current.id,
      )
    : [];
  const title = current?.reading ? current.label : (current?.label ?? "模组设定");

  if (!current) {
    return (
      <section className="grid min-h-0 flex-1 place-items-center p-8">
        <div className="max-w-sm text-center">
          <Library className="text-muted-foreground mx-auto size-8" strokeWidth={1.4} />
          <h2 className="mt-4 text-base font-semibold">没有可查阅的模组设定</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            这个模组没有阅读页，也没有文档。
          </p>
        </div>
      </section>
    );
  }

  const renderDocuments = (documents: readonly ModuleDocument[]) => (
    <>
      <PageToolbarHeader
        widthClassName="max-w-5xl"
        title={title}
        description={`${documents.length} 份文档`}
        resetKey={current.id}
      />
      <div className="mx-auto w-full max-w-5xl px-9">
        <div className="mt-10">
          <ModuleDocuments
            documents={documents}
            documentTypes={session.documentTypes}
            selectedDocumentPath={selectedDocumentPath}
            onSelectDocument={(path) => {
              if (path) onDocumentOpen?.();
              setSelectedDocumentPath(path);
            }}
          />
        </div>
      </div>
    </>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="border-border/60 bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col border-r px-3 pt-16 pb-4">
        <ModuleNavSearch searchQuery={searchQuery} onSearchChange={setSearchQuery} />
        <ModuleNavScroll>
          <ModuleNavGroups groups={groups} activeId={current.id}>
            {(item, active) => (
              <Button
                className={moduleNavItemClass(active)}
                key={item.id}
                variant="ghost"
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  if (item.id === current.id) return;
                  setActiveId(item.id);
                  setSelectedDocumentPath(null);
                }}
              >
                <ModuleNavIcon item={item} active={active} />
                {item.label}
              </Button>
            )}
          </ModuleNavGroups>
        </ModuleNavScroll>
      </aside>
      <ModuleContent>
        {selectedReading ? (
          <ModuleReading page={selectedReading} />
        ) : roomId ? (
          <LiveDocumentList
            roomId={roomId}
            documents={selectedDocuments}
            selectedPath={selectedDocumentPath}
            onHideSelection={() => setSelectedDocumentPath(null)}
          >
            {renderDocuments}
          </LiveDocumentList>
        ) : (
          renderDocuments(selectedDocuments)
        )}
      </ModuleContent>
    </div>
  );
}

/** 游戏目录先取得同版投影，再统计条目；调试作用域沿用完整服务器资料。 */
function LiveDocumentList({
  roomId,
  documents,
  selectedPath,
  onHideSelection,
  children,
}: {
  roomId: string;
  documents: readonly ModuleDocument[];
  selectedPath: string | null;
  onHideSelection: () => void;
  children: (documents: readonly ModuleDocument[]) => ReactNode;
}) {
  const computed = useRoomVisibleDocuments(roomId, documents);
  const byPath = new Map(computed.map((document) => [documentIdentity(document.path), document]));
  const visible = documents.flatMap((document) => {
    const current = byPath.get(documentIdentity(document.path));
    return current
      ? current.visible === false
        ? []
        : [current]
      : document.docType
        ? []
        : [document];
  });
  useEffect(() => {
    if (
      selectedPath &&
      computed.some((document) => document.path === selectedPath && document.visible === false)
    )
      onHideSelection();
  }, [computed, selectedPath, onHideSelection]);
  return children(visible);
}
