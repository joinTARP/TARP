import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { desktopOrpc } from "../../desktop-rpc";
import { errorMessage } from "./game-client";

export function usePlayerProfile(setError: (message: string) => void) {
  const query = useQuery(desktopOrpc.player.get.queryOptions());
  useEffect(() => {
    if (query.error) setError(errorMessage(query.error));
  }, [query.error, setError]);
  return {
    player: query.data ?? null,
    reload: () => {
      void query.refetch();
    },
  };
}

export type PlayerProfile = ReturnType<typeof usePlayerProfile>;
