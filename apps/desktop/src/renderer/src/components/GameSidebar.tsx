import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ScrollAreaPane } from "./ui/scroll-area";

/** 作者决定期望宽度；空间不足时改用抽屉，不压缩主内容或提供拖动手柄。 */
export function GameSidebar({
  id,
  label,
  width,
  reservedWidth,
  onClose,
  children,
}: {
  id: string;
  label: string;
  width: number;
  reservedWidth: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState(false);
  useLayoutEffect(() => {
    const parent = shell.current?.parentElement;
    if (!parent) return;
    const measure = () => setDrawer(parent.clientWidth < width + reservedWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [width, reservedWidth]);

  const content = (
    <>
      <div aria-hidden="true" className="h-12 shrink-0" />
      <ScrollAreaPane className="min-h-0 flex-1" viewportClassName="p-5">
        {children}
      </ScrollAreaPane>
    </>
  );
  return (
    <div
      ref={shell}
      style={{ width: drawer ? 0 : width }}
      className="flex min-h-0 max-w-full shrink-0"
    >
      {drawer ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <DialogContent
            id={id}
            style={{ width: `min(${width}px, 100dvw)` }}
            className="top-0 right-0 left-auto flex h-dvh max-h-none max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-full"
          >
            <DialogTitle className="sr-only">{label}</DialogTitle>
            <DialogDescription className="sr-only">查看角色资料</DialogDescription>
            {content}
          </DialogContent>
        </Dialog>
      ) : (
        <aside
          id={id}
          aria-label={label}
          className="border-border/60 bg-sidebar text-sidebar-foreground relative flex min-h-0 w-full flex-col border-l"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        >
          {content}
        </aside>
      )}
    </div>
  );
}
