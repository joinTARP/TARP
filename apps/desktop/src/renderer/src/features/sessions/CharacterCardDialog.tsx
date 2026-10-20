import type { Character } from "@jointarp/module/character";
import type { GameSession } from "@tarp/core/shared/session";
import { useRef } from "react";

import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { CharacterSummary } from "./CharacterSummary";

/** 从角色头像打开与游戏侧栏一致的角色面板。 */
export function CharacterCardDialog({
  character,
  session,
  open,
  onOpenChange,
}: {
  character?: Character;
  session: GameSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const type = session.documentTypes.find((item) => item.id === character?.typeId);

  return (
    <Dialog open={open && Boolean(character)} onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        finalFocus={false}
        className="bg-sidebar text-sidebar-foreground flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[360px]"
      >
        <DialogTitle className="sr-only">{character?.name ?? "角色卡"}</DialogTitle>
        <ScrollAreaPane className="min-h-0 flex-1" viewportClassName="overscroll-contain p-5 pt-12">
          {character ? (
            <CharacterSummary character={character} documentType={type} session={session} compact />
          ) : null}
        </ScrollAreaPane>
      </DialogContent>
    </Dialog>
  );
}
