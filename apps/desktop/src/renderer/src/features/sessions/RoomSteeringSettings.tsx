import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { SettingsSection } from "../settings/SettingsSection";
import { localRoomModuleLoader } from "./local-room-module";
import { roomConnection } from "./room-connection";

/** 房间级选择默认关闭，通过同一队列快照与聊天室同步。 */
export function RoomSteeringSettings({ roomId }: { roomId: string }) {
  const shared = useMemo(
    () => roomConnection(desktopRpc.game, roomId, localRoomModuleLoader),
    [roomId],
  );
  const chat = useSyncExternalStore(shared.chat.subscribe, shared.chat.getSnapshot);
  useEffect(() => shared.retain(), [shared]);
  const settings = useQuery({
    ...desktopOrpc.game.steering.get.queryOptions({ input: { roomId } }),
    staleTime: 0,
  });
  useEffect(() => {
    if (settings.data) shared.chat.acceptSteering(settings.data.snapshot);
  }, [settings.data, shared]);
  const save = useMutation({
    mutationFn: (enabled: boolean) => desktopRpc.game.steering.setEnabled({ roomId, enabled }),
    onSuccess: (snapshot) => {
      shared.chat.acceptSteering(snapshot);
      void settings.refetch();
    },
  });
  const enabled = chat.initialized
    ? chat.steering.enabled
    : (settings.data?.snapshot.enabled ?? false);
  return (
    <SettingsSection title="行动与回应">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <label id="host-steering-label" htmlFor="host-steering" className="text-sm font-medium">
            主持插话
          </label>
          <p
            id="host-steering-description"
            className="text-muted-foreground mt-1 text-xs leading-5"
          >
            允许玩家在主持生成时补充行动或问题，下次回应时接收。关闭后，已有插话保留给房主手动提交。
          </p>
        </div>
        <button
          id="host-steering"
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="host-steering-label"
          aria-describedby="host-steering-description"
          disabled={!settings.data?.isHost || save.isPending}
          onClick={() => save.mutate(!enabled)}
          className="bg-input aria-checked:bg-primary focus-visible:outline-ring inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          <span
            className={`bg-background size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${enabled ? "translate-x-4" : "translate-x-0"}`}
          />
        </button>
      </div>
      <p role="status" className="sr-only">
        {save.isPending
          ? "正在保存…"
          : save.isSuccess
            ? `主持插话已${enabled ? "开启" : "关闭"}`
            : ""}
      </p>
      {settings.error || save.error ? (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {settings.error?.message ?? save.error?.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
