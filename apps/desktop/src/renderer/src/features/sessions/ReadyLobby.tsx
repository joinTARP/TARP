import type { ChatMessage } from "@jointarp/core/shared/game";
import type { SessionModule } from "@jointarp/core/shared/session";
import { ArrowRight, Check } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { desktopRpc } from "../../desktop-rpc";
import { DocumentCover } from "../modules/DocumentCover";
import { errorMessage } from "./game-client";

import styles from "./ReadyLobby.module.css";

export function ReadyLobby({
  module,
  message,
  roomId,
  playerId,
}: {
  module: SessionModule;
  message?: Extract<ChatMessage, { kind: "card" }>;
  roomId: string;
  playerId?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const card = message?.card.type === "ready" ? message.card : undefined;
  const pending = message?.status === "running" && Boolean(card);
  const mine = card?.players.find((item) => item.id === playerId);
  const waiting = card?.players.filter((item) => !item.confirmed) ?? [];
  const meta = [module.author, module.version ? `v${module.version}` : undefined]
    .filter(Boolean)
    .join(" · ");

  async function confirm() {
    if (busy || !pending || !message || !playerId) return;
    if (mine?.confirmed) return;
    setBusy(true);
    setError("");
    try {
      await desktopRpc.game.launch.confirmReady({ roomId, messageId: message.id });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto ${styles.stage}`}
      aria-label="准备开始"
    >
      <div className="relative h-[clamp(220px,48vh,480px)] overflow-hidden">
        <DocumentCover
          src={module.cover}
          scope={`room-module:${roomId}`}
          title={module.name}
          className={`absolute inset-0 size-full [&_img]:!object-cover ${styles.cover}`}
        />
        <div
          className="from-background via-background/40 pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t to-transparent"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/25 to-transparent"
          aria-hidden="true"
        />
      </div>

      <div className="relative -mt-8 px-6 pb-8 sm:px-10 sm:pb-10">
        <div className="mx-auto w-full max-w-3xl">
          <p
            className={`text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${styles.line}`}
            style={{ animationDelay: "80ms" }}
          >
            <span>{module.system || "模组"}</span>
            {module.tags
              ?.filter((tag) => tag !== module.system)
              .slice(0, 3)
              .map((tag) => (
                <span key={tag} className="border-border border-l pl-3">
                  {tag}
                </span>
              ))}
          </p>
          <h1
            className={`mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl ${styles.line}`}
            style={{ animationDelay: "160ms" }}
          >
            {module.name}
          </h1>
          {module.description ? (
            <p
              className={`text-foreground/80 mt-3 max-w-xl text-sm leading-7 text-pretty ${styles.line}`}
              style={{ animationDelay: "260ms" }}
            >
              {module.description}
            </p>
          ) : null}
          {meta ? (
            <p
              className={`text-muted-foreground/70 mt-3 text-xs ${styles.line}`}
              style={{ animationDelay: "340ms" }}
            >
              {meta}
            </p>
          ) : null}
          <div
            className={`border-border/70 mt-7 border-t pt-5 ${styles.line}`}
            style={{ animationDelay: "440ms" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
              <div className="min-w-0 flex-1 basis-48">
                <h2 className="text-sm font-medium">准备进入冒险</h2>
                <p className="text-muted-foreground mt-1.5 text-xs leading-5" role="status">
                  {pending
                    ? mine?.confirmed
                      ? waiting.length > 0
                        ? `还在等${waiting.map((item) => item.nickname).join("、")}`
                        : "所有人已准备，冒险即将开始"
                      : card && card.players.length > 1
                        ? "所有人准备好后，冒险就会开始。"
                        : "准备好后，开始你的故事。"
                    : card
                      ? "所有人已准备，冒险即将开始"
                      : "正在同步在场的人…"}
                </p>
              </div>
              {pending && !mine?.confirmed ? (
                <Button
                  className="h-10 gap-3 rounded-lg px-6"
                  disabled={busy || !playerId || !message}
                  onClick={() => void confirm()}
                >
                  {busy ? "正在确认…" : "准备好了"}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
              ) : card ? (
                <span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
                  <Check aria-hidden="true" className="size-4" />
                  已准备
                </span>
              ) : null}
            </div>
            {card && card.players.length > 1 ? (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="在场玩家">
                {card.players.map((item) => (
                  <li
                    key={item.id}
                    className="border-border/80 bg-background flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors duration-300 motion-reduce:transition-none"
                  >
                    <span
                      className={`size-1.5 rounded-full transition-colors duration-300 motion-reduce:transition-none ${item.confirmed ? "bg-foreground" : "bg-muted-foreground/40"}`}
                      aria-hidden="true"
                    />
                    {item.nickname}
                    <span className="text-muted-foreground text-xs">
                      {item.confirmed ? "已准备" : "未准备"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive mt-3 text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
