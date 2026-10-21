import { parseDice } from "@jointarp/core/shared/dice";
import type { ChatMessage, Player } from "@jointarp/core/shared/game";
import { Dices } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { DiceTray, type DiceTrayPhase } from "./DiceTray";
import { errorMessage, type GameClient } from "./game-client";

type DiceMessage = Extract<ChatMessage, { kind: "dice" }>;
export const DiceCard = memo(function DiceCard({
  message,
  player,
  client,
}: {
  message: DiceMessage;
  player: Player | null;
  client: GameClient;
}) {
  const dice = message.dice;
  const reduced = useReducedMotion();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [rolled, setRolled] = useState(false);
  const [error, setError] = useState("");
  const [animating, setAnimating] = useState(false);
  const animated = useRef(false);
  const onSettled = useCallback(() => setAnimating(false), []);
  const pending = message.status === "running";
  const failed = message.status === "failed";
  const canRoll = pending && player?.id === dice.targetPlayerId;
  const remaining = Math.max(0, Math.ceil((dice.deadline - now) / 1000));
  const { count, sides, modifier } = parseDice(dice.expression);
  const phase: DiceTrayPhase = pending
    ? busy || rolled || remaining === 0
      ? "shaking"
      : "waiting"
    : animating
      ? "throwing"
      : "settled";
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [pending]);
  useLayoutEffect(() => {
    if (pending || failed || !dice.resolvedAt || animated.current) return;
    animated.current = true;
    if (reduced || Date.now() - dice.resolvedAt > 5000) return;
    setAnimating(true);
  }, [pending, failed, dice.resolvedAt, reduced]);
  async function roll() {
    if (busy || !canRoll) return;
    setBusy(true);
    setError("");
    try {
      await client.dice.roll({ roomId: message.roomId, messageId: message.id });
      setRolled(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="border-border bg-card mx-4 my-4 max-w-lg rounded-xl border p-4 sm:mr-6 sm:ml-20"
      aria-label="掷骰"
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Dices className="size-4" />
        <span>{message.nickname} 发起掷骰</span>
        <span className="ml-auto font-mono">{dice.expression}</span>
      </div>
      {dice.reason ? <p className="mt-2 text-sm font-medium">{dice.reason}</p> : null}
      {!failed ? (
        <div className="flex min-h-24 items-center gap-3 pt-7 pb-4">
          <DiceTray
            sides={sides}
            count={count}
            values={dice.rolls}
            phase={phase}
            onSettled={onSettled}
            className="min-w-0 flex-1"
          />
          {modifier ? (
            <span className="text-muted-foreground shrink-0 font-mono text-sm tabular-nums">
              {modifier > 0 ? "+" : "−"} {Math.abs(modifier)}
            </span>
          ) : null}
          <AnimatePresence initial={false}>
            {phase === "settled" ? (
              <motion.span
                key="total"
                initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 350, damping: 20 }}
                className="shrink-0 text-2xl font-semibold tabular-nums"
              >
                = {dice.total}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {failed
              ? "掷骰失败"
              : pending
                ? `等待${canRoll ? "你" : (dice.targetNickname ?? "玩家")}掷骰`
                : animating
                  ? "骰子落定中…"
                  : "掷骰结果"}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {failed
              ? message.error || "本次掷骰已终止，未产生结果。"
              : pending
                ? remaining > 0
                  ? `${remaining} 秒后自动掷骰`
                  : "正在结算…"
                : animating
                  ? dice.expression
                  : `${dice.rolls?.join(" + ")}${modifier ? ` ${modifier > 0 ? "+" : "−"} ${Math.abs(modifier)}` : ""} = ${dice.total}`}
          </p>
          {!pending && !failed && !animating ? (
            <p className="text-muted-foreground mt-1 text-[11px]">
              {dice.resolvedBy === "timeout"
                ? "超时自动掷骰"
                : dice.resolvedBy === "click"
                  ? `${dice.targetNickname} 掷出`
                  : "系统掷出"}
            </p>
          ) : null}
        </div>
        {canRoll ? (
          <Button disabled={busy || rolled || remaining === 0} onClick={() => void roll()}>
            {busy || rolled ? "掷骰中…" : "掷骰"}
          </Button>
        ) : null}
      </div>
      {pending ? (
        <div className="bg-muted mt-4 h-1 overflow-hidden rounded-full" aria-hidden="true">
          <motion.div
            className="bg-primary/50 h-full origin-left"
            animate={{ scaleX: remaining / 30 }}
            transition={{ duration: reduced ? 0 : 0.3, ease: "linear" }}
          />
        </div>
      ) : null}
      <span role="status" className="sr-only">
        {failed ? "掷骰失败" : !pending ? `掷骰结果 ${dice.total}` : "等待玩家掷骰"}
      </span>
      {error ? (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {error}
        </p>
      ) : null}
    </article>
  );
});
