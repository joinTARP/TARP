import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { useRoomReplica } from "./use-room-state";

/** 开局、角色归属和队友设置变化后刷新同一份队伍缓存。 */
export function useRoomCompanions(roomId: string, enabled = true) {
  const client = useQueryClient();
  const version = useRoomReplica(roomId)?.sections.companionVersion;
  const options = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const query = useQuery({
    ...options,
    enabled,
    queryFn: ({ signal }) => desktopRpc.sessions.companion.get({ roomId }, { signal }),
  });
  useEffect(() => {
    if (!enabled || !version) return;
    let current = true;
    // 初次请求也可能在选择开局之前开始；先取消，避免迟到的空响应覆盖新状态。
    void client.cancelQueries({ queryKey: options.queryKey }).then(() => {
      if (current) void client.invalidateQueries({ queryKey: options.queryKey });
    });
    return () => {
      current = false;
    };
  }, [client, roomId, version, enabled]);
  return query;
}
