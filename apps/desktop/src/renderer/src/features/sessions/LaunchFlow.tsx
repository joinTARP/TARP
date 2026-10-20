import type { LaunchAction, LaunchState } from "@tarp/core/shared/launch";
import type { RoomLaunchState } from "@tarp/core/shared/room-state";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, UserRound } from "lucide-react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopRpc as desktopClient } from "../../desktop-rpc";
import { DocumentCard } from "../modules/DocumentCard";
import { CharacterPortrait } from "./CharacterPortrait";
import { CharacterPreview } from "./CharacterPreview";
import { CreationWorkbench } from "./CreationWorkbench";
import { mergeLaunchCommandProgress, type LaunchCommandProgress } from "./room-launch-view";

const pageSize = 4;
const ease = [0.22, 1, 0.36, 1] as const;

const pageVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 40 }),
  center: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.34, ease, staggerChildren: 0.05 },
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction * -40,
    transition: { duration: 0.22, ease },
  }),
};

const cardVariants: Variants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0, transition: { duration: 0.34, ease } },
};

function PageDots({ page, count }: { page: number; count: number }) {
  const id = useId();
  if (count > 7)
    return (
      <span className="text-muted-foreground px-1 text-xs tabular-nums">
        {page + 1} / {count}
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 px-1.5">
      <span className="sr-only">
        第 {page + 1} 页，共 {count} 页
      </span>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="bg-muted-foreground/25 relative size-1.5 rounded-full"
        >
          {index === page ? (
            <motion.span
              layoutId={`${id}-page`}
              className="bg-foreground absolute inset-0 rounded-full"
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
            />
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function LaunchFlow({
  roomId,
  state,
  onRefresh,
}: {
  roomId: string;
  state: LaunchState;
  onRefresh: () => void;
}) {
  const p = state.progress,
    start = state.config.gameStarts.find((s) => s.id === state.room.startId),
    type = state.types.find((t) => t.id === p.typeId);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [characterPage, setCharacterPage] = useState(0),
    [pageDirection, setPageDirection] = useState(0),
    [createTypeDialogOpen, setCreateTypeDialogOpen] = useState(false),
    [creationDialogOpen, setCreationDialogOpen] = useState(p.stage === "creation");
  const selectedCharacterId = p.stage === "review" && !p.typeId ? p.characterId : undefined;
  useEffect(() => {
    const creating = p.stage === "creation" || (p.stage === "review" && Boolean(p.typeId));
    if (creating) {
      setCreateTypeDialogOpen(false);
      setCreationDialogOpen(true);
      return;
    }
    setCreationDialogOpen(false);
  }, [p.stage, p.typeId]);
  const latest = useRef<LaunchCommandProgress>({
    roomId,
    room: state.room,
    progress: state.progress,
  });
  if (latest.current.roomId !== roomId)
    latest.current = { roomId, room: state.room, progress: state.progress };
  else latest.current = mergeLaunchCommandProgress(latest.current, roomId, state);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [roomId]);
  const operation = useRef(false);
  async function action(
    args: Omit<LaunchAction, "roomId" | "revision" | "roomRevision">,
  ): Promise<RoomLaunchState | null | undefined> {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const isCurrent = () => mounted.current && latest.current.roomId === roomId;
    try {
      const current = latest.current;
      const next = await desktopClient.game.launch.advance({
        roomId,
        revision: current.progress.revision,
        roomRevision: current.room.revision,
        ...args,
      });
      if (!isCurrent()) return;
      if (next) latest.current = mergeLaunchCommandProgress(latest.current, roomId, next);
      return next;
    } catch (error) {
      if (!isCurrent()) return;
      setError(error instanceof Error ? error.message : String(error));
      try {
        const fresh = await desktopClient.game.launch.get({ roomId });
        if (isCurrent() && fresh)
          latest.current = mergeLaunchCommandProgress(latest.current, roomId, fresh);
      } catch {
        // 保留操作错误；恢复读取不替玩家重放命令。
      }
      if (isCurrent()) onRefresh();
      return undefined;
    } finally {
      if (isCurrent()) {
        operation.current = false;
        setBusy(false);
      }
    }
  }
  const selected = state.characters.find((c) => c.id === p.characterId);
  const pickedCharacter = selectedCharacterId ? selected : undefined;
  const availableCharacters = state.characters.filter((c) => !c.playerId);
  const characterPageCount = Math.max(1, Math.ceil(availableCharacters.length / pageSize));
  useEffect(() => {
    setCharacterPage((page) => Math.min(page, characterPageCount - 1));
  }, [characterPageCount]);
  function turnPage(delta: 1 | -1) {
    setPageDirection(delta);
    setCharacterPage((page) => Math.min(Math.max(page + delta, 0), characterPageCount - 1));
  }
  const creatableTypes = start?.allowCreate
    ? state.types.filter(
        (t) => start.characterTypeIds.includes(t.id) && state.creationTypeIds.includes(t.id),
      )
    : [];
  async function confirmCharacter(characterId: string) {
    const current = latest.current.progress;
    if (current.stage !== "review" || current.characterId !== characterId) {
      const selected = await action({ action: "select", characterId });
      if (!selected) return;
    }
    await action({ action: "confirm" });
  }
  async function leaveCreation() {
    let current = latest.current.progress;
    for (let step = 0; step < 40; step += 1) {
      if (current.stage !== "creation" && !(current.stage === "review" && current.typeId)) return;
      const next = await action({ action: "back" });
      if (!next) return;
      current = next.progress;
    }
  }
  async function chooseCreationType(typeId: string) {
    const next = await action({ action: "create", typeId });
    if (!next) return;
    setCreateTypeDialogOpen(false);
    setCreationDialogOpen(true);
  }
  const reviewCharacter = p.typeId
    ? (state.draftView ?? state.workbench?.draft ?? p.draft)
    : selected;
  const review = (
    <div className="min-w-0">
      <CharacterPreview
        character={reviewCharacter ?? { name: "", description: "", values: {} }}
        type={type ?? state.types.find((item) => item.id === selected?.typeId)}
        types={state.types}
        references={state.references}
      />
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
  return (
    <>
      <section className="max-w-5xl" aria-busy={busy}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">请选择角色</h2>
          </div>
          <div className="flex items-center gap-2">
            {creatableTypes.length ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreateTypeDialogOpen(true)}
              >
                <Plus className="size-4" aria-hidden="true" />
                创建角色
              </Button>
            ) : null}
            {characterPageCount > 1 ? (
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="上一页"
                  disabled={characterPage === 0 || busy}
                  onClick={() => turnPage(-1)}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <PageDots page={characterPage} count={characterPageCount} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="下一页"
                  disabled={characterPage >= characterPageCount - 1 || busy}
                  onClick={() => turnPage(1)}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="relative">
          <AnimatePresence mode="popLayout" custom={pageDirection}>
            <motion.ul
              key={characterPage}
              custom={pageDirection}
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              {availableCharacters
                .slice(characterPage * pageSize, characterPage * pageSize + pageSize)
                .map((character) => {
                  const documentType = state.types.find((item) => item.id === character.typeId);
                  const dimmed =
                    Boolean(selectedCharacterId) && selectedCharacterId !== character.id;
                  return (
                    <motion.li key={character.id} variants={cardVariants} className="min-w-0">
                      <div
                        className={`h-full transition-opacity duration-300 hover:opacity-100 motion-reduce:transition-none ${dimmed ? "opacity-55" : ""}`}
                      >
                        <DocumentCard
                          document={{
                            path: character.sourcePath ?? character.id,
                            title: character.name,
                            docType: character.typeId,
                            description: character.description,
                            image: character.image,
                            valid: true,
                            values: character.values,
                          }}
                          documentType={documentType}
                          references={state.references}
                          referenceTypes={state.types}
                          disabled={busy}
                          selected={selectedCharacterId === character.id}
                          onSelect={() => {
                            if (selectedCharacterId !== character.id)
                              void action({ action: "select", characterId: character.id });
                          }}
                        />
                      </div>
                    </motion.li>
                  );
                })}
            </motion.ul>
          </AnimatePresence>
        </div>
        {!availableCharacters.length ? (
          <p className="text-muted-foreground px-2 py-8 text-center text-sm">暂无可选角色</p>
        ) : null}
        {availableCharacters.length ? (
          <div className="border-border bg-card mt-5 flex min-h-16 items-center gap-3 overflow-hidden rounded-xl border p-2 pl-3">
            <div className="relative min-w-0 flex-1">
              <AnimatePresence mode="popLayout" initial={false}>
                {pickedCharacter ? (
                  <motion.div
                    key={pickedCharacter.id}
                    className="flex min-w-0 items-center gap-3"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.26, ease }}
                  >
                    <CharacterPortrait
                      name={pickedCharacter.name}
                      image={pickedCharacter.avatar ?? pickedCharacter.image}
                      path={pickedCharacter.sourcePath}
                      className="size-10 rounded-lg"
                    />
                    <div className="min-w-0">
                      <p className="text-muted-foreground text-[11px]">已选中</p>
                      <p className="truncate text-sm font-medium">{pickedCharacter.name}</p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.p
                    key="empty"
                    className="text-muted-foreground text-sm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.26, ease }}
                  >
                    点选一张角色卡，决定你要扮演谁
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
            <AnimatePresence initial={false}>
              {pickedCharacter ? (
                <motion.div
                  key="cancel"
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.2, ease }}
                >
                  <Button
                    variant="ghost"
                    className="disabled:opacity-100"
                    disabled={busy}
                    onClick={() => void action({ action: "back" })}
                  >
                    取消
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <motion.div layout="position" transition={{ duration: 0.2, ease }}>
              <Button
                className={selectedCharacterId ? "disabled:opacity-100" : undefined}
                disabled={busy || !selectedCharacterId}
                onClick={() => {
                  if (selectedCharacterId) void confirmCharacter(selectedCharacterId);
                }}
              >
                确认选择
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </motion.div>
          </div>
        ) : null}
        <AnimatePresence>
          {error ? (
            <motion.p
              role="alert"
              className="text-destructive mt-3 text-sm"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease }}
            >
              {error}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </section>
      <Dialog open={createTypeDialogOpen} onOpenChange={setCreateTypeDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>创建角色</DialogTitle>
            <DialogDescription>选择角色类型</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {creatableTypes.map((characterType) => (
              <button
                key={characterType.id}
                type="button"
                disabled={busy}
                onClick={() => void chooseCreationType(characterType.id)}
                className="group border-border bg-card hover:border-primary/50 hover:bg-accent/25 focus-visible:outline-ring focus-visible:border-ring flex w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left transition-colors outline-none focus-visible:outline-1 focus-visible:-outline-offset-2 disabled:cursor-wait disabled:opacity-60"
              >
                <span>
                  <span className="block text-sm font-medium">创建{characterType.name}</span>
                </span>
                <ChevronRight
                  className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={creationDialogOpen && (p.stage === "creation" || p.stage === "review")}
        onOpenChange={(next) => {
          setCreationDialogOpen(next);
          if (!next) void leaveCreation();
        }}
      >
        <DialogContent
          className="bg-background flex! h-[min(52rem,calc(100dvh-7rem))] w-[calc(100vw-2rem)]! max-w-5xl! flex-col gap-0! overflow-hidden p-0!"
          showCloseButton={false}
        >
          <DialogHeader className="border-border shrink-0 flex-row! items-center justify-between gap-4! border-b px-6 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                <UserRound className="size-4" aria-hidden="true" />
              </span>
              <DialogTitle className="text-base">
                {p.stage === "review" ? "角色卡" : "创建角色"}
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              {p.stage === "review" ? "查看角色详情并确认选择" : "填写角色信息"}
            </DialogDescription>
            <DialogClose render={<Button variant="ghost" size="sm" />}>关闭</DialogClose>
          </DialogHeader>
          <fieldset disabled={busy} className="min-h-0 min-w-0 flex-1 border-0 p-0">
            <ScrollAreaPane className="h-full">
              {p.stage === "review" ? (
                review
              ) : state.workbench ? (
                <div className="p-5 sm:p-7">
                  <CreationWorkbench key={p.typeId} state={state} act={action} />
                </div>
              ) : (
                <p className="text-muted-foreground p-7 text-sm">
                  建卡工作台不可用，请检查角色类型配置。
                </p>
              )}
            </ScrollAreaPane>
          </fieldset>
          {p.stage === "review" ? (
            <div className="border-border bg-background flex shrink-0 items-center justify-between gap-4 border-t px-6 py-4">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void action({ action: "back" })}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {p.typeId ? "继续编辑" : "返回角色列表"}
              </Button>
              <Button disabled={busy} onClick={() => void action({ action: "confirm" })}>
                {busy ? "处理中…" : "确认选择"}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : error ? (
            <p role="alert" className="text-destructive border-border border-t px-6 py-3 text-sm">
              {error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
