import type { GameRoom, GameRoomSummary } from "@jointarp/core/shared/session";
import { documentMediaUrl } from "@shared/document-media";
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";

import { Button, buttonVariants } from "../../components/ui/button";
import { AdventureMenu, CoverImage, type AdventureAction } from "./adventure-actions";
import { formatAdventureOn, formatEndedOn, groupAdventures } from "./history-adventures";

const menuOmit = ["reopen"] as const satisfies readonly AdventureAction[];

export function HistoryAdventureList({
  rooms,
  issues,
  error,
  onRetry,
  onAction,
}: {
  rooms: readonly GameRoomSummary[];
  issues: readonly string[];
  error?: string;
  onRetry?: () => void;
  onAction: (room: GameRoom, action: AdventureAction) => void;
}) {
  const { active, ended } = groupAdventures(rooms);
  const showYears = ended.length > 1 || active.length > 0;
  return (
    <div>
      {error ? (
        <div role="alert" className="text-destructive mb-4 text-sm">
          {error}
          {onRetry ? (
            <button className="ml-3 underline" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {issues.map((issue) => (
        <p role="alert" className="text-destructive mb-2 text-sm" key={issue}>
          {issue}
        </p>
      ))}
      {active.length === 0 && ended.length === 0 && !error ? (
        <div className="border-border text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-20 text-center text-sm">
          <History className="size-6" strokeWidth={1.6} />
          <p className="text-foreground font-medium">还没有冒险</p>
          <p className="max-w-sm leading-6">创建之后，进行中和已结束的冒险都会留在这里。</p>
        </div>
      ) : null}
      {active.length > 0 ? (
        <section aria-label="进行中">
          <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide">进行中</h2>
          <AdventureRows rooms={active} onAction={onAction} />
        </section>
      ) : null}
      {ended.map((group) => (
        <section key={group.year} aria-label={showYears ? `${group.year}年` : "已结束"}>
          {showYears ? (
            <h2 className="text-muted-foreground mt-8 mb-3 text-xs font-medium tracking-wide">
              {group.year}
            </h2>
          ) : null}
          <AdventureRows rooms={group.rooms} onAction={onAction} />
        </section>
      ))}
    </div>
  );
}

function AdventureRows({
  rooms,
  onAction,
}: {
  rooms: readonly GameRoomSummary[];
  onAction: (room: GameRoom, action: AdventureAction) => void;
}) {
  return (
    <ul className="space-y-2">
      {rooms.map((room) => (
        <li key={room.id}>
          <HistoryAdventureRow room={room} onAction={(action) => onAction(room, action)} />
        </li>
      ))}
    </ul>
  );
}

function HistoryAdventureRow({
  room,
  onAction,
}: {
  room: GameRoomSummary;
  onAction: (action: AdventureAction) => void;
}) {
  const ended = room.status === "ended";
  const when = ended ? (room.endedAt ?? room.updatedAt) : room.updatedAt;
  return (
    <div className="group border-border/60 bg-card/60 flex items-center gap-4 rounded-xl border p-3 pr-2">
      <CoverImage
        src={documentMediaUrl(`room-module:${room.id}`, "", room.cover)}
        title={room.moduleName}
        className="size-14 shrink-0 rounded-lg text-lg"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">
          {ended ? (
            room.name
          ) : (
            <Link
              data-ui-control
              to="/game/$roomId"
              params={{ roomId: room.id }}
              className="hover:underline"
            >
              {room.name}
            </Link>
          )}
        </h3>
        <p className="text-muted-foreground mt-1 truncate text-xs">
          {room.moduleName}
          <span className="mx-1.5 opacity-50">·</span>
          {ended ? (
            <time dateTime={when}>{formatEndedOn(when)}</time>
          ) : (
            <>
              进行中
              <span className="mx-1.5 opacity-50">·</span>
              <time dateTime={when}>{formatAdventureOn(when)}</time>
            </>
          )}
        </p>
      </div>
      {ended ? (
        <Button variant="outline" size="sm" onClick={() => onAction("reopen")}>
          重新开启
        </Button>
      ) : (
        <Link
          data-ui-control
          to="/game/$roomId"
          params={{ roomId: room.id }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          继续
        </Link>
      )}
      <AdventureMenu
        room={room}
        omit={ended ? menuOmit : undefined}
        onAction={onAction}
        className="text-muted-foreground hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted"
      />
    </div>
  );
}

export function HistorySkeleton() {
  return (
    <div className="space-y-2" aria-label="正在读取历史冒险">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="bg-muted/50 h-[76px] animate-pulse rounded-xl" />
      ))}
    </div>
  );
}
