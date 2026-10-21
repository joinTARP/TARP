import type { AppUpdateStatus } from "@shared/app-update";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../../components/ui/button";
import { desktopOrpc } from "../../desktop-rpc";
import { useFlushSettings } from "./AutosaveScope";

const labels: Record<AppUpdateStatus["state"], string> = {
  idle: "尚未检查更新",
  disabled: "开发版和预发布版暂不支持自动更新",
  checking: "正在检查更新…",
  current: "当前已是最新正式版",
  available: "发现新版本",
  downloading: "正在下载并准备更新…",
  ready: "更新已准备好，重启后安装",
  installing: "正在重启安装…",
  error: "更新失败，请检查网络后重试",
};

export function AppUpdateSettings() {
  const client = useQueryClient();
  const flush = useFlushSettings();
  const status = useQuery({ ...desktopOrpc.updates.get.queryOptions(), refetchInterval: 1000 });
  const onSuccess = (next: AppUpdateStatus) => {
    client.setQueryData(desktopOrpc.updates.get.queryOptions().queryKey, next);
  };
  const check = useMutation(desktopOrpc.updates.check.mutationOptions({ onSuccess }));
  const download = useMutation(desktopOrpc.updates.download.mutationOptions({ onSuccess }));
  const restart = useMutation(desktopOrpc.updates.restart.mutationOptions({ onSuccess }));
  const data = status.data;
  const busy =
    check.isPending ||
    download.isPending ||
    restart.isPending ||
    data?.state === "checking" ||
    data?.state === "downloading" ||
    data?.state === "installing";
  const error =
    check.error?.message ??
    download.error?.message ??
    restart.error?.message ??
    status.error?.message ??
    data?.error;

  return (
    <section className="mt-12" aria-labelledby="app-update-heading">
      <h2 id="app-update-heading" className="text-base font-semibold">
        应用更新
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">
        启动时后台检查正式版更新，下载和重启由你决定。
      </p>
      <div className="border-border bg-card mt-5 rounded-xl border p-4">
        <p className="text-sm">当前版本：{data?.currentVersion ?? "正在读取…"}</p>
        <p className="text-muted-foreground mt-2 text-sm" role="status" aria-live="polite">
          {data ? labels[data.state] : "正在读取更新状态…"}
          {data?.version ? ` · ${data.version}` : ""}
          {data?.state === "downloading" && data.progress !== undefined
            ? ` · ${data.progress}%`
            : ""}
        </p>
        {data?.state === "downloading" ? (
          <progress
            className="mt-3 h-2 w-full"
            aria-label="更新下载进度"
            max={100}
            value={data.progress}
          />
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!data || busy || data.state === "disabled" || data.state === "ready"}
            onClick={() => {
              download.reset();
              restart.reset();
              check.mutate();
            }}
          >
            检查更新
          </Button>
          {data?.state === "available" ? (
            <Button disabled={busy} onClick={() => download.mutate()}>
              下载更新
            </Button>
          ) : null}
          {data?.state === "ready" ? (
            <Button
              disabled={busy}
              onClick={async () => {
                if (await flush()) restart.mutate();
              }}
            >
              重启更新
            </Button>
          ) : null}
        </div>
        {error ? (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
