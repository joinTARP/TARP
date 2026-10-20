import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { useFlushSettings } from "../settings/AutosaveScope";
import { SettingsSection } from "../settings/SettingsSection";
import { refreshSyncedRoom } from "./room-module-sync";

export function RoomModuleSync({ roomId, active }: { roomId: string; active: boolean }) {
  const client = useQueryClient();
  const flush = useFlushSettings();
  const options = desktopOrpc.sessions.module.source.queryOptions({ input: { roomId } });
  const source = useQuery(options);
  const [notice, setNotice] = useState("");
  const check = useMutation({
    mutationFn: () => desktopRpc.sessions.module.checkUpdate({ roomId }),
    onSuccess: (result) => {
      setNotice(result.changed ? "发现模组更新，可以同步。" : "来源模组与当前游戏一致。");
    },
  });
  const select = useMutation({
    mutationFn: () => desktopRpc.sessions.module.selectSource({ roomId }),
    onSuccess: (path) => {
      if (path === null) return;
      client.setQueryData(options.queryKey, path);
      check.reset();
      sync.reset();
      setNotice("来源已保存，点击检查更新以比较当前内容。");
    },
  });
  const sync = useMutation({
    mutationFn: async () => {
      if (!(await flush())) throw new Error("请先修正并保存当前配置。");
      return desktopRpc.sessions.module.sync({ roomId });
    },
    onSuccess: (result) => {
      check.reset();
      setNotice(result.changed ? "模组已同步，当前游戏进度已保留。" : "当前模组已是最新。");
      if (!result.changed) return;
      const version = `${Date.now()}`;
      refreshSyncedRoom(client, roomId, version);
      const channel = new BroadcastChannel("tarp-module-synced");
      channel.postMessage({ roomId, version });
      channel.close();
    },
  });
  const pending = select.isPending || check.isPending || sync.isPending;
  const error = sync.error ?? check.error ?? select.error ?? source.error;
  return (
    <SettingsSection title="模组同步">
      <p className="text-muted-foreground text-xs leading-5">
        手动检查来源模组是否更新，再同步到当前游戏。同步保留游戏进度和已有字段修改；不兼容的更新会被拒绝。
      </p>
      <p className="text-muted-foreground text-xs break-all">
        {source.isPending
          ? "正在读取来源…"
          : source.data
            ? `来源：${source.data}`
            : "尚未绑定来源，请选择模组目录。"}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!active || pending}
          onClick={() => {
            sync.reset();
            check.reset();
            select.mutate();
          }}
        >
          {source.data ? "更换来源目录" : "选择来源目录"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!active || !source.data || pending}
          onClick={() => {
            sync.reset();
            select.reset();
            setNotice("");
            check.mutate();
          }}
        >
          {check.isPending ? "正在检查…" : "检查更新"}
        </Button>
        <Button
          size="sm"
          disabled={!active || !check.isSuccess || !check.data?.changed || pending}
          onClick={() => {
            setNotice("");
            sync.mutate();
          }}
        >
          {sync.isPending ? "正在同步…" : "同步模组"}
        </Button>
      </div>
      {!active ? (
        <p className="text-muted-foreground text-xs">请先重新开启冒险，再同步模组。</p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs">
          {notice}
        </p>
      ) : null}
      {check.data ? (
        <p className="text-muted-foreground text-xs">
          上次检查：{new Date(check.data.checkedAt).toLocaleString()}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs break-words">
          {error.message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
