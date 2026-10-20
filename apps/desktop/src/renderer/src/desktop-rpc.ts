import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";

import type { DesktopRouter } from "../../main/desktop-rpc";
import { nativePort } from "./native-bridge";

const link = new RPCLink({
  port: nativePort,
});

export const desktopRpc: RouterClient<DesktopRouter> = createORPCClient(link);
export const desktopOrpc = createTanstackQueryUtils(desktopRpc);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
