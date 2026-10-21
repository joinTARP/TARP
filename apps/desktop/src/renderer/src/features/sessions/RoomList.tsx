import type { GameRoomSummary } from "@jointarp/core/shared/session";
import { documentMediaUrl } from "@shared/document-media";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowRight } from "lucide-react";
import { useState } from "react";

import {
  AdventureActionDialog,
  AdventureMenu,
  CoverImage,
  formatWhen,
  type AdventureAction,
} from "./adventure-actions";
import { useAdventureActions } from "./use-adventure-actions";

function FeaturedAdventure({
  room,
  onAction,
}: {
  room: GameRoomSummary;
  onAction: (action: AdventureAction) => void;
}) {
  const src = documentMediaUrl(`room-module:${room.id}`, "", room.cover);
  const [failedSrc, setFailedSrc] = useState<string>();
  const showCover = Boolean(src) && src !== failedSrc;
  return (
    <div className="group bg-primary relative h-60 overflow-hidden rounded-2xl ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/5">
      {showCover ? (
        <img
          src={src}
          onError={() => setFailedSrc(src)}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-10 grid place-items-center text-[180px] leading-none font-semibold text-white/[0.04] select-none"
        >
          {room.moduleName.slice(0, 1)}
        </div>
      )}
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-r",
          showCover
            ? "from-black/60 via-black/20 to-transparent"
            : "from-black/35 via-black/10 to-transparent",
          "dark:from-black/85 dark:via-black/45 dark:to-black/5",
        )}
      />
      <Link
        data-ui-control
        to="/game/$roomId"
        params={{ roomId: room.id }}
        className="relative flex h-full flex-col justify-end p-8 text-white [text-shadow:0_1px_12px_rgb(0_0_0/0.45)] focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white/70 dark:[text-shadow:none]"
      >
        <p className="text-xs text-white/80 dark:text-white/55">
          {room.moduleName}
          <span className="mx-1.5 opacity-50">·</span>
          <time dateTime={room.updatedAt}>{formatWhen(room.updatedAt)}</time>
        </p>
        <h2 className="mt-2 max-w-xl truncate text-[26px] font-semibold tracking-tight">
          {room.name}
        </h2>
        <span className="mt-6 inline-flex h-9 w-fit items-center gap-2 rounded-lg bg-white px-4 text-xs font-medium text-zinc-900 transition-colors group-hover:bg-white/90">
          继续冒险
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
      <AdventureMenu
        room={room}
        onAction={onAction}
        className="absolute top-4 right-4 text-white/60 hover:bg-white/10 hover:text-white"
      />
    </div>
  );
}

function AdventureCard({
  room,
  onAction,
}: {
  room: GameRoomSummary;
  onAction: (action: AdventureAction) => void;
}) {
  const when = room.updatedAt;
  return (
    <div className="group border-border/60 bg-card/60 hover:border-border hover:bg-accent/40 relative flex min-w-0 items-center gap-3 rounded-xl border p-2.5 pr-1.5 transition-colors">
      <CoverImage
        src={documentMediaUrl(`room-module:${room.id}`, "", room.cover)}
        title={room.moduleName}
        className="size-11 shrink-0 rounded-lg text-base"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">
          <Link
            data-ui-control
            to="/game/$roomId"
            params={{ roomId: room.id }}
            className="focus-visible:after:outline-ring after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2"
          >
            {room.name}
          </Link>
        </h3>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {room.moduleName}
          <span className="mx-1.5 opacity-50">·</span>
          <time dateTime={when}>{formatWhen(when)}</time>
        </p>
      </div>
      <AdventureMenu
        room={room}
        onAction={onAction}
        className="text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted relative z-10 opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 sm:opacity-0"
      />
    </div>
  );
}

const RECENT_LIMIT = 6;

/** 最近冒险作为主视觉，其余仅展示最近几项，避免房间数量撑长首页。 */
export function RoomList() {
  const { rooms, pendingAction, setPendingAction, manage, chooseAction } = useAdventureActions();
  const byRecent = (a: GameRoomSummary, b: GameRoomSummary) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  const active = rooms.data?.rooms.filter((room) => room.status === "active").sort(byRecent) ?? [];
  const endedCount = rooms.data?.rooms.filter((room) => room.status === "ended").length ?? 0;
  const [featured, ...others] = active;
  const visible = others.slice(0, RECENT_LIMIT);
  const choose = (room: GameRoomSummary, action: AdventureAction) => chooseAction(room, action);
  const hasAlerts = Boolean(rooms.error || rooms.data?.issues.length);
  const dialog = (
    <AdventureActionDialog
      action={pendingAction}
      pending={manage.isPending}
      error={manage.error}
      onDismiss={() => setPendingAction(null)}
      onConfirm={() => pendingAction && manage.mutate(pendingAction)}
    />
  );

  if (rooms.isPending) {
    return <div className="bg-muted/50 mb-12 h-60 animate-pulse rounded-2xl" />;
  }
  if (!hasAlerts && active.length === 0 && endedCount === 0) return null;

  return (
    <section aria-label="冒险" className="mb-12">
      {rooms.error ? (
        <div role="alert" className="text-destructive mb-4 text-sm">
          {rooms.error.message}
          <button className="ml-3 underline" onClick={() => void rooms.refetch()}>
            重试
          </button>
        </div>
      ) : null}
      {rooms.data?.issues.map((issue) => (
        <p role="alert" className="text-destructive mb-2 text-sm" key={issue}>
          {issue}
        </p>
      ))}

      {active.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">进行中的冒险</h2>
            <span className="text-muted-foreground text-xs tabular-nums">{active.length}</span>
          </div>
          <Link
            data-ui-control
            to="/history"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            全部冒险 <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      ) : null}
      {featured ? (
        <FeaturedAdventure room={featured} onAction={(action) => choose(featured, action)} />
      ) : null}
      {visible.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((room) => (
            <AdventureCard key={room.id} room={room} onAction={(action) => choose(room, action)} />
          ))}
        </div>
      ) : null}

      {active.length === 0 && endedCount > 0 ? (
        <p className="text-muted-foreground text-sm">
          <Link
            data-ui-control
            to="/history"
            className="text-foreground underline-offset-4 hover:underline"
          >
            历史冒险
          </Link>
          里有 {endedCount} 段已结束的存档，可以重新开启。
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
