import type { Character } from "@jointarp/module/character";
import type { Player } from "@tarp/core/shared/game";
import type { GameSession } from "@tarp/core/shared/session";
import { UserRound } from "lucide-react";
import { useState } from "react";

import { Tooltip } from "../../components/ui/tooltip";
import { useDocumentPortrait } from "../modules/document-image";
import { CharacterAvatarMenu } from "./CharacterAvatarMenu";
import { CharacterCardDialog } from "./CharacterCardDialog";
import { playerLabel } from "./player-role";
import { useRoomCompanions } from "./use-room-companions";

function PartyMember({
  character,
  nickname,
  onClick,
  onMention,
}: {
  character: Character;
  nickname?: string;
  onClick: () => void;
  onMention?: () => void;
}) {
  const portrait = useDocumentPortrait(character.sourcePath, character.avatar, character.image);
  const label =
    nickname !== undefined
      ? playerLabel(nickname, { playerId: character.playerId ?? "", name: character.name })
      : character.name;
  return (
    <CharacterAvatarMenu
      name={label}
      onOpenCard={onClick}
      onMention={onMention}
      className="hover:bg-sidebar-accent focus-visible:outline-ring flex w-full max-w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2"
    >
      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {portrait.src ? (
          <img
            src={portrait.src}
            onError={portrait.onError}
            alt=""
            draggable={false}
            className="size-full object-cover object-top"
          />
        ) : (
          <UserRound className="size-4" aria-hidden="true" />
        )}
      </span>
      <Tooltip content={label} overflowOnly>
        <span data-overflow-text className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {label}
        </span>
      </Tooltip>
    </CharacterAvatarMenu>
  );
}

export function GameParty({
  roomId,
  session,
  characters,
  player,
  onMention,
}: {
  roomId: string;
  session: GameSession;
  characters: readonly Character[];
  player?: Player;
  onMention?: (id: string) => void;
}) {
  const party = useRoomCompanions(roomId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const members = new Map(
    characters
      .filter((character) => character.playerId)
      .map((character) => [character.id, character]),
  );
  for (const seat of party.data?.seats ?? []) {
    if (!seat.companion) continue;
    const character = party.data?.characters.find(
      (item) => item.id === seat.companion?.characterId,
    )?.card;
    if (character) members.set(character.id, character);
  }
  const selected = selectedId ? members.get(selectedId) : undefined;
  return (
    <section aria-label="冒险小队" className="mb-3 flex min-w-0 flex-col">
      <div className="text-muted-foreground/65 flex shrink-0 items-center gap-2 px-2 pb-3 text-[11px] font-medium">
        <h2>冒险小队</h2>
        <span className="text-muted-foreground/45 text-[10px] tabular-nums">{members.size}</span>
      </div>
      <div>
        <ul className="space-y-0.5">
          {[...members.values()].map((character) => (
            <li key={character.id}>
              <PartyMember
                character={character}
                nickname={player && character.playerId === player.id ? player.nickname : undefined}
                onMention={
                  onMention && character.playerId !== player?.id
                    ? (() => {
                        const id =
                          party.data?.seats.find(
                            (seat) => seat.companion?.characterId === character.id,
                          )?.id ?? character.playerId;
                        return id ? () => onMention(id) : undefined;
                      })()
                    : undefined
                }
                onClick={() => setSelectedId(character.id)}
              />
            </li>
          ))}
        </ul>
        {members.size === 0 ? (
          <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
            {party.isPending ? "正在读取小队…" : "暂无入队角色"}
          </p>
        ) : null}
        {party.error ? (
          <button
            type="button"
            className="text-destructive px-3 py-2 text-xs"
            onClick={() => void party.refetch()}
          >
            队友读取失败，点击重试
          </button>
        ) : null}
      </div>
      <CharacterCardDialog
        character={selected}
        session={session}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </section>
  );
}
