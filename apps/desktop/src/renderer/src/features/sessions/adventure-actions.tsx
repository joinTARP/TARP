import { Menu } from "@base-ui/react/menu";
import type { GameRoom } from "@jointarp/core/shared/session";
import { Archive, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Tooltip } from "../../components/ui/tooltip";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const relativeFormat = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

export function formatWhen(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return relativeFormat.format(-minutes, "minute");
  if (minutes < 60 * 24) return relativeFormat.format(-Math.round(minutes / 60), "hour");
  if (minutes < 60 * 24 * 7) return relativeFormat.format(-Math.round(minutes / 1440), "day");
  return dateFormat.format(new Date(iso));
}

export type AdventureAction = "end" | "reopen" | "remove";

export interface PendingAction {
  room: GameRoom;
  action: AdventureAction;
}

const actionCopy: Record<
  AdventureAction,
  { title: string; description: string; confirm: string; destructive?: boolean }
> = {
  end: {
    title: "结束这段冒险？",
    description: "聊天、角色和笔记都会完整保留。结束后仍留在历史冒险里，可以随时重新开启。",
    confirm: "结束冒险",
  },
  reopen: {
    title: "重新开启这段冒险？",
    description: "冒险会回到进行中列表，并可继续此前的聊天、角色和笔记。",
    confirm: "重新开启",
  },
  remove: {
    title: "永久删除这段冒险？",
    description: "本机上的聊天、角色、笔记和模组快照都会被删除，此操作无法撤销。",
    confirm: "永久删除",
    destructive: true,
  },
};

export function AdventureMenu({
  room,
  onAction,
  className,
  omit = [],
}: {
  room: GameRoom;
  onAction: (action: AdventureAction) => void;
  className: string;
  omit?: readonly AdventureAction[];
}) {
  const showEnd = room.status === "active" && !omit.includes("end");
  const showReopen = room.status !== "active" && !omit.includes("reopen");
  const showRemove = !omit.includes("remove");
  return (
    <Menu.Root>
      <Tooltip content="更多操作">
        <Menu.Trigger
          aria-label={`管理冒险“${room.name}”`}
          className={`focus-visible:outline-ring grid size-8 shrink-0 place-items-center rounded-md transition outline-none focus-visible:outline-1 focus-visible:outline-offset-2 ${className}`}
        >
          <MoreHorizontal className="size-4" />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className="border-border bg-popover text-popover-foreground data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 min-w-40 rounded-lg border p-1 text-xs shadow-lg outline-none">
            {showEnd ? (
              <Menu.Item
                onClick={() => onAction("end")}
                className="data-highlighted:bg-muted flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 outline-none"
              >
                <Archive className="size-3.5" />
                结束冒险
              </Menu.Item>
            ) : null}
            {showReopen ? (
              <Menu.Item
                onClick={() => onAction("reopen")}
                className="data-highlighted:bg-muted flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 outline-none"
              >
                <RotateCcw className="size-3.5" />
                重新开启
              </Menu.Item>
            ) : null}
            {showRemove && (showEnd || showReopen) ? (
              <Menu.Separator className="bg-border my-1 h-px" />
            ) : null}
            {showRemove ? (
              <Menu.Item
                onClick={() => onAction("remove")}
                className="text-destructive data-highlighted:bg-destructive/10 flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 outline-none"
              >
                <Trash2 className="size-3.5" />
                永久删除
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function CoverImage({
  src,
  title,
  className,
}: {
  src?: string;
  title: string;
  className: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src || failedSrc === src) {
    return (
      <div
        aria-hidden="true"
        className={`from-foreground/15 to-foreground/5 text-foreground/25 grid place-items-center bg-gradient-to-br font-semibold select-none ${className}`}
      >
        {title.slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={`object-cover ${className}`}
      onError={() => setFailedSrc(src)}
    />
  );
}

export function AdventureActionDialog({
  action,
  pending,
  error,
  onDismiss,
  onConfirm,
}: {
  action: PendingAction | null;
  pending: boolean;
  error: { message: string } | null;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onDismiss();
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{action ? actionCopy[action.action].title : "管理冒险"}</DialogTitle>
          <DialogDescription>
            {action ? `“${action.room.name}”：${actionCopy[action.action].description}` : ""}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            操作失败：{error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onDismiss}>
            取消
          </Button>
          <Button
            variant={action && actionCopy[action.action].destructive ? "destructive" : "default"}
            disabled={!action || pending}
            onClick={onConfirm}
          >
            {pending ? "正在处理…" : action ? actionCopy[action.action].confirm : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
