import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CardData } from "@tarp/core/shared/game";
import { Check, ChevronRight, UserRound, UsersRound } from "lucide-react";
import { useRef } from "react";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { DocumentCard } from "../modules/DocumentCard";
import { CharacterPortrait } from "./CharacterPortrait";
import { errorMessage } from "./game-client";
import { mergeLaunchCommandProgress, type LaunchCommandProgress } from "./room-launch-view";
import { useRoomCompanions } from "./use-room-companions";
import { useRoomLaunch } from "./use-room-state";

type CompanionCard = Extract<CardData, { type: "companions" }>;

export function CompanionLaunchCard({
  roomId,
  card,
  pending,
}: {
  roomId: string;
  card: CompanionCard;
  pending: boolean;
}) {
  const client = useQueryClient();
  const player = useQuery(desktopOrpc.player.get.queryOptions());
  const mine = player.data?.id === card.playerId;
  const partyOptions = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const launch = useRoomLaunch(roomId);
  const party = useRoomCompanions(roomId, pending && mine);
  const latest = useRef<LaunchCommandProgress | undefined>(undefined);
  if (launch.data)
    latest.current =
      latest.current?.roomId === roomId
        ? mergeLaunchCommandProgress(latest.current, roomId, launch.data)
        : { roomId, room: launch.data.room, progress: launch.data.progress };
  const flow = useMutation({
    mutationFn: async (action: "chooseCompanions" | "beginAdventure") => {
      const state = latest.current;
      if (!state) throw new Error("开局进度暂不可用，请重试");
      return desktopRpc.game.launch.advance({
        roomId,
        revision: state.progress.revision,
        roomRevision: state.room.revision,
        action,
      });
    },
    onSuccess: (state) => {
      if (state && latest.current?.roomId === roomId)
        latest.current = mergeLaunchCommandProgress(latest.current, roomId, state);
    },
    onError: () => {
      void launch.refetch();
    },
  });
  const assignment = useMutation({
    mutationFn: async (characterId: string) => {
      const seat = party.data?.seats.find(
        (item) =>
          item.companion?.characterId === characterId || item.reservedCharacterId === characterId,
      );
      if (seat) return desktopRpc.sessions.companion.save({ roomId, id: seat.id, companion: null });
      const selected = await desktopRpc.sessions.companion.select({ roomId, characterId });
      const reserved = selected.seats.find((item) => item.reservedCharacterId === characterId);
      if (!reserved) throw new Error("角色选择已变化，请重试");
      return desktopRpc.sessions.companion.save({
        roomId,
        id: reserved.id,
        companion: { characterId },
      });
    },
    onSuccess: async (settings) => {
      await client.cancelQueries({ queryKey: partyOptions.queryKey });
      client.setQueryData(partyOptions.queryKey, settings);
    },
    onError: () => {
      void party.refetch();
    },
  });
  const busy = flow.isPending || assignment.isPending;
  const selected = party.data?.seats.filter((seat) => seat.companion) ?? [];
  const held = party.data?.seats.filter((seat) => seat.reservedCharacterId) ?? [];
  const candidates =
    party.data?.characters.filter((character) => {
      const picked = party.data?.seats.some(
        (seat) =>
          seat.companion?.characterId === character.id || seat.reservedCharacterId === character.id,
      );
      return (
        character.playable &&
        character.aiConfigured &&
        (picked || (!character.controllerId && !character.reservedBy))
      );
    }) ?? [];
  const error = flow.error ?? assignment.error ?? launch.error ?? party.error ?? player.error;
  // 选择队友会触发后台刷新；保留已有卡片，避免切回加载提示导致高度塌缩。
  const loaded = launch.isSuccess && !party.isPending;
  const ready = loaded && party.isSuccess && !party.isFetching;

  if (!pending || card.stage === "complete") {
    const companions = card.selected ?? [];
    return (
      <article
        className="border-border bg-card mx-4 my-4 flex max-w-lg items-center gap-4 rounded-xl border px-4 py-3 sm:mr-6 sm:ml-20"
        aria-label="已确定冒险小队"
      >
        <div className="relative shrink-0" aria-hidden="true">
          {companions.length ? (
            <div className="flex -space-x-3">
              {companions.slice(0, 3).map((companion) => {
                const preset = party.data?.characters.find((item) => item.id === companion.id);
                const character = launch.data?.characters.find((item) => item.id === companion.id);
                return (
                  <CharacterPortrait
                    key={companion.id}
                    name={companion.name}
                    image={preset?.avatar ?? preset?.image ?? character?.avatar ?? character?.image}
                    path={preset?.card?.sourcePath ?? character?.sourcePath}
                    className="ring-card size-12 rounded-lg text-lg ring-2"
                  />
                );
              })}
              {companions.length > 3 ? (
                <span className="bg-muted text-muted-foreground ring-card flex size-12 items-center justify-center rounded-lg text-xs font-medium ring-2">
                  +{companions.length - 3}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-lg">
              <UserRound className="size-5" />
            </span>
          )}
          <span className="bg-primary text-primary-foreground ring-card absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full ring-2">
            <Check className="size-3" strokeWidth={3} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">
            {companions.length ? "同行队友 · 与你一起冒险" : "准备就绪"}
          </p>
          <p className="mt-0.5 text-base leading-6 font-semibold wrap-anywhere">
            {companions.length
              ? companions.map((companion) => companion.name).join("、")
              : "独自开始冒险"}
          </p>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`border-border bg-card mx-4 my-4 rounded-xl border p-5 sm:mr-6 sm:ml-20 ${card.stage === "prompt" ? "max-w-lg" : ""}`}
      aria-label={card.stage === "prompt" ? "是否添加 AI 队友" : "选择 AI 队友"}
      aria-busy={busy}
    >
      <div className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
          <UsersRound className="size-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {card.stage === "prompt" ? "要添加 AI 队友，一起冒险吗？" : "选择与你同行的 AI 队友"}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {card.stage === "prompt"
              ? "由 AI 扮演同伴的角色，与你讨论计划、一起行动。"
              : "点选角色加入小队，再次点击可以取消。"}
          </p>
        </div>
      </div>
      {!mine ? (
        <p role="status" className="text-muted-foreground mt-4 text-sm">
          {player.isPending ? "正在读取玩家…" : "等待选角的玩家确定同行队友…"}
        </p>
      ) : card.stage === "prompt" ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            disabled={busy || !ready}
            onClick={() =>
              flow.mutate("chooseCompanions", {
                onSuccess: () => {
                  if (selected.length || held.length) return;
                  const first = candidates[0];
                  if (first) assignment.mutate(first.id);
                },
              })
            }
          >
            添加 AI 队友
          </Button>
          <Button
            variant="outline"
            disabled={busy || !ready || held.length > 0}
            onClick={() => flow.mutate("beginAdventure")}
          >
            {flow.isPending && flow.variables === "beginAdventure"
              ? "正在开始…"
              : selected.length
                ? "开始冒险"
                : "独自开始"}
          </Button>
        </div>
      ) : (
        <>
          {!loaded ? (
            <p role="status" className="text-muted-foreground mt-5 text-sm">
              正在读取队友…
            </p>
          ) : candidates.length ? (
            <ul className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {candidates.map((character) => {
                const picked = selected.some(
                  (seat) => seat.companion?.characterId === character.id,
                );
                const reserved = held.some((seat) => seat.reservedCharacterId === character.id);
                const sheet = character.card;
                return (
                  <li key={character.id} className="min-w-0">
                    <DocumentCard
                      document={{
                        path: sheet?.sourcePath ?? character.id,
                        title: character.name,
                        docType: sheet?.typeId,
                        description: character.description,
                        image: character.image,
                        body: sheet?.body,
                        values: sheet?.values,
                        valid: true,
                      }}
                      documentType={launch.data?.types.find((type) => type.id === sheet?.typeId)}
                      references={launch.data?.references}
                      referenceTypes={launch.data?.types}
                      subtitle={
                        reserved ? "选择未完成 · 点击取消" : picked ? "AI 扮演 · 已加入" : "AI 扮演"
                      }
                      selected={picked || reserved}
                      disabled={busy || !ready}
                      onSelect={() => assignment.mutate(character.id)}
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status" className="text-muted-foreground mt-5 text-sm">
              暂无可添加的队友。
            </p>
          )}
          <div className="border-border mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-muted-foreground text-xs" role="status">
              {held.length
                ? "请取消未完成的选择后重选"
                : selected.length
                  ? `已添加 ${selected.length} 名队友`
                  : "也可以独自开始冒险"}
            </p>
            <Button
              disabled={busy || !ready || held.length > 0}
              onClick={() => flow.mutate("beginAdventure")}
            >
              {flow.isPending ? "正在开始…" : selected.length ? "开始冒险" : "独自开始"}
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </>
      )}
      {error ? (
        <div role="alert" className="text-destructive mt-3 text-sm">
          {errorMessage(error)}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void launch.refetch();
              void party.refetch();
              void player.refetch();
            }}
          >
            重新读取
          </Button>
        </div>
      ) : null}
    </article>
  );
}
