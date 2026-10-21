import type { GameRoom } from "@jointarp/core/shared/session";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { desktopOrpc, desktopRpc, queryClient } from "../../desktop-rpc";
import { type AdventureAction, type PendingAction } from "./adventure-actions";

export function useAdventureActions() {
  const navigate = useNavigate();
  const rooms = useQuery(desktopOrpc.sessions.list.queryOptions());
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const manage = useMutation({
    mutationFn: async ({ room, action }: PendingAction) => {
      if (action === "end") return desktopRpc.sessions.end({ id: room.id });
      if (action === "reopen") return desktopRpc.sessions.reopen({ id: room.id });
      return desktopRpc.sessions.remove({ id: room.id });
    },
    onSuccess: async (_value, { room, action }) => {
      setPendingAction(null);
      await queryClient.invalidateQueries(desktopOrpc.sessions.list.queryOptions());
      if (action === "reopen") {
        await navigate({ to: "/game/$roomId", params: { roomId: room.id } });
      }
    },
  });
  const chooseAction = (room: GameRoom, action: AdventureAction) => {
    manage.reset();
    setPendingAction({ room, action });
  };
  return { rooms, pendingAction, setPendingAction, manage, chooseAction };
}
