import type { ChatMessage } from "@jointarp/core/shared/game";
import type { Character } from "@jointarp/module/character";
import { Check, ContactRound, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { desktopRpc } from "../../desktop-rpc";
import { CharacterPortrait } from "./CharacterPortrait";
import { CompanionLaunchCard } from "./CompanionLaunchCard";
import { errorMessage } from "./game-client";
import { LaunchFlow } from "./LaunchFlow";
import { useRoomLaunch } from "./use-room-state";

type CardMessage = Extract<ChatMessage, { kind: "card" }>;

const swapEase = [0.22, 1, 0.36, 1] as const;

function CollapseSwap({
  changeKey,
  enter,
  children,
}: {
  changeKey: string;
  enter: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const snapshot = useRef(0);
  const [height, setHeight] = useState<number | "auto">("auto");

  useLayoutEffect(() => {
    const next = inner.current?.offsetHeight ?? 0;
    const from = snapshot.current;
    if (reduced || from <= 0 || Math.abs(from - next) <= 1) {
      snapshot.current = next;
      return;
    }
    setHeight(from);
    snapshot.current = next;
    const frame = requestAnimationFrame(() => setHeight(next));
    return () => cancelAnimationFrame(frame);
  }, [changeKey, reduced]);

  return (
    <motion.div
      className="mx-4 my-4 sm:mr-6 sm:ml-20"
      initial={false}
      animate={{ height }}
      transition={{ duration: reduced ? 0 : 0.36, ease: swapEase }}
      style={{ overflow: height === "auto" ? "visible" : "hidden" }}
      onAnimationComplete={() => {
        setHeight("auto");
        snapshot.current = inner.current?.offsetHeight ?? snapshot.current;
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={changeKey}
          ref={inner}
          initial={reduced || !enter ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.22, ease: swapEase }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export const LaunchCard = memo(function LaunchCard({
  message,
  roomId,
  onOpenCharacterCard,
}: {
  message: CardMessage;
  roomId: string;
  onOpenCharacterCard?: (characterId: string) => void;
}) {
  const card = message.card;
  const pending = message.status === "running";
  const launch = useRoomLaunch(roomId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const seenPicking = useRef(false);
  if (pending && card.type === "character") seenPicking.current = true;

  async function choose(startId: string) {
    if (busy || !pending || card.type !== "start") return;
    setBusy(true);
    setError("");
    try {
      await desktopRpc.game.launch.chooseStart({ roomId, messageId: message.id, startId });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  if (card.type === "companions")
    return <CompanionLaunchCard roomId={roomId} card={card} pending={pending} />;
  if (card.type !== "start" && card.type !== "character") return null;

  const chosen =
    card.type === "character" && card.selectedId
      ? launch.data?.characters.find((item) => item.id === card.selectedId)
      : undefined;

  if (card.type === "start") {
    const selected = card.options.find((option) => option.id === card.selectedId);
    return (
      <article
        className="border-border bg-card mx-4 my-4 max-w-lg rounded-xl border p-4 sm:mr-6 sm:ml-20"
        aria-label="选择开局"
      >
        <p className="text-sm font-medium">{pending ? "选择开局方案" : "已选择开局"}</p>
        {pending ? (
          <div className="mt-3 space-y-2">
            {card.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                onClick={() => void choose(option.id)}
                className="border-border hover:border-ring/50 hover:bg-accent/20 focus-visible:outline-ring focus-visible:border-ring w-full rounded-xl border p-4 text-left transition-colors outline-none focus-visible:outline-1 focus-visible:-outline-offset-2 disabled:opacity-50"
              >
                <span className="block text-sm font-medium">{option.label}</span>
                {option.detail ? (
                  <span className="text-muted-foreground mt-2 block text-sm">{option.detail}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground mt-2 text-sm">{selected?.label ?? "已确定"}</p>
        )}
        {error ? (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {error}
          </p>
        ) : null}
      </article>
    );
  }

  return (
    <CollapseSwap
      changeKey={pending ? "picking" : "chosen"}
      enter={seenPicking.current && !pending}
    >
      {pending ? (
        <div aria-label="选择角色">
          {launch.data ? (
            <LaunchFlow
              key={roomId}
              roomId={roomId}
              state={launch.data}
              onRefresh={() => void launch.refetch()}
            />
          ) : (
            <p className="text-muted-foreground text-sm">{error || "正在读取角色"}</p>
          )}
          {launch.error || error ? (
            <div role="alert" className="text-destructive mt-3 text-sm">
              {error || errorMessage(launch.error)}
              <Button variant="ghost" size="sm" onClick={() => void launch.refetch()}>
                重新读取
              </Button>
            </div>
          ) : null}
        </div>
      ) : message.status === "cancelled" ? (
        <article
          className="border-border bg-card text-muted-foreground flex max-w-lg items-center gap-2 rounded-xl border border-dashed p-4 text-sm"
          aria-label="选择角色"
        >
          <X className="size-4" aria-hidden="true" />
          已取消选择
        </article>
      ) : (
        <ChosenCharacter
          character={chosen}
          typeName={launch.data?.types.find((type) => type.id === chosen?.typeId)?.name}
          label={chosen?.name ?? card.selectedLabel ?? "已选择角色"}
          animate={seenPicking.current}
          onOpen={chosen && onOpenCharacterCard ? () => onOpenCharacterCard(chosen.id) : undefined}
        />
      )}
    </CollapseSwap>
  );
});

const fadeUp = {
  hidden: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.28, ease: swapEase } },
};

function ChosenCharacter({
  character,
  typeName,
  label,
  animate,
  onOpen,
}: {
  character?: Character;
  typeName?: string;
  label: string;
  animate: boolean;
  onOpen?: () => void;
}) {
  const reduced = useReducedMotion();
  const play = animate && !reduced;
  return (
    <motion.article
      aria-label="已选择角色"
      className="border-border bg-card flex max-w-lg items-center gap-4 rounded-xl border px-4 py-3"
      initial={play ? "hidden" : false}
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.04, delayChildren: 0.06 } } }}
    >
      <motion.div
        className="relative shrink-0"
        variants={{
          hidden: { opacity: 0, scale: 0.94 },
          shown: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: swapEase } },
        }}
      >
        <CharacterPortrait
          name={label}
          image={character?.avatar ?? character?.image}
          path={character?.sourcePath ?? (character ? `${character.typeId}/draft.json` : undefined)}
          className="ring-card size-12 rounded-lg text-lg ring-2"
        />
        <span
          aria-hidden="true"
          className="bg-primary text-primary-foreground ring-card absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full ring-2"
        >
          <Check className="size-3" strokeWidth={3} />
        </span>
      </motion.div>
      <div className="min-w-0 flex-1">
        <motion.p variants={fadeUp} className="text-muted-foreground text-xs">
          角色已就位
          {typeName ? ` · ${typeName}` : ""}
        </motion.p>
        <motion.h3
          variants={fadeUp}
          className="mt-0.5 text-base leading-6 font-semibold wrap-anywhere"
        >
          {label}
        </motion.h3>
      </div>
      {onOpen ? (
        <motion.div variants={fadeUp} className="shrink-0">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            <ContactRound className="size-4" aria-hidden="true" />
            角色卡
          </Button>
        </motion.div>
      ) : null}
    </motion.article>
  );
}
