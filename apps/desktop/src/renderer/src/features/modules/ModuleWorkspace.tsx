import type { ReactNode } from "react";

import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "../../components/ui/scroll-area";
import { ModuleNavigation, type ModuleNavGroup } from "./ModuleNavigation";

interface ModuleWorkspaceProps {
  readonly modulePath?: string;
  readonly groups?: readonly ModuleNavGroup[];
  readonly searchQuery?: string;
  readonly activeId?: string | null;
  readonly pending?: boolean;
  readonly onSearchChange?: (value: string) => void;
  readonly children: ReactNode;
}

export function ModuleContent({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-h-0 min-w-0 flex-1">
      <ScrollArea className="h-full">
        <ScrollAreaViewport>
          <ScrollAreaContent>
            <div className="pt-3 pb-16">{children}</div>
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollArea>
    </div>
  );
}

/** 模组库页面：窗口拖拽条、模组库侧栏和正文滚动区。 */
export function ModuleWorkspace({
  modulePath,
  groups = [],
  searchQuery = "",
  activeId = null,
  pending = false,
  onSearchChange,
  children,
}: ModuleWorkspaceProps) {
  return (
    <main className="bg-background text-foreground relative flex h-full min-h-0 w-full overflow-hidden">
      <div
        className="absolute inset-x-0 top-0 z-50 h-12 [-webkit-app-region:drag]"
        aria-hidden="true"
      />
      <ModuleNavigation
        modulePath={modulePath}
        groups={groups}
        searchQuery={searchQuery}
        activeId={activeId}
        pending={pending}
        onSearchChange={onSearchChange ?? (() => undefined)}
      />
      <ModuleContent>{children}</ModuleContent>
    </main>
  );
}

export function ModulePagePending() {
  return (
    <ModuleWorkspace pending>
      <div className="mx-auto w-full max-w-4xl px-9 pt-8">
        <div className="bg-muted/60 h-7 w-24 rounded-md" aria-hidden="true" />
        <div className="bg-muted/40 mt-3 h-4 w-48 rounded-md" aria-hidden="true" />
        <div className="border-border bg-card mt-10 rounded-xl border p-5">
          <div className="bg-muted/50 h-4 w-32 rounded-md" aria-hidden="true" />
          <div className="bg-muted/30 mt-3 h-3 w-48 rounded-md" aria-hidden="true" />
        </div>
      </div>
    </ModuleWorkspace>
  );
}
