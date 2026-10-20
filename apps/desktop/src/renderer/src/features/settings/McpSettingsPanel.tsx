import type { McpStatus } from "@shared/mcp";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, LoaderCircle, PlugZap } from "lucide-react";
import { useId, useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { desktopOrpc } from "../../desktop-rpc";

const stateLabels: Record<McpStatus["state"], string> = {
  stopped: "已关闭",
  starting: "正在启动…",
  running: "服务运行中",
  stopping: "正在停止…",
  error: "启动失败",
};

export function McpSettingsPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({ ...desktopOrpc.mcp.get.queryOptions(), refetchInterval: 1000 });
  const toggle = useMutation(desktopOrpc.mcp.setEnabled.mutationOptions());
  const copy = useMutation(desktopOrpc.mcp.copyConfiguration.mutationOptions());
  const [copied, setCopied] = useState(false);
  const inputId = useId();
  const data = status.data;
  const busy = toggle.isPending || data?.state === "starting" || data?.state === "stopping";
  const running = data?.state === "running";
  const error =
    toggle.error?.message ?? copy.error?.message ?? status.error?.message ?? data?.error;

  async function setEnabled(enabled: boolean) {
    setCopied(false);
    copy.reset();
    try {
      const next = await toggle.mutateAsync({ enabled });
      queryClient.setQueryData(desktopOrpc.mcp.get.queryOptions().queryKey, next);
    } catch {
      /* 错误在操作下方展示。 */
    }
  }
  async function copyConfiguration() {
    try {
      await copy.mutateAsync();
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-4xl"
        title="开发者工具"
        description="让本机 Agent 连接 TARP，测试正在创作的模组。"
      />
      <div className="mx-auto w-full max-w-4xl px-9">
        <section aria-labelledby={`${inputId}-heading`}>
          <div className="flex items-center gap-2.5">
            <PlugZap className="text-muted-foreground size-4" aria-hidden="true" />
            <h2 id={`${inputId}-heading`} className="text-base font-semibold">
              MCP 服务
            </h2>
          </div>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
            通过 MCP 创建临时预演局，由 AI 队友和主持运行。过程显示在正常游戏界面。
          </p>
          <div className="border-border bg-card mt-5 rounded-xl border">
            <div className="flex items-center justify-between gap-6 p-5">
              <div>
                <label htmlFor={inputId} className="text-sm font-medium">
                  启用 MCP 服务
                </label>
                <p className="text-muted-foreground mt-1 text-xs leading-5">
                  仅允许本机访问。开启后立即生效，下次启动时沿用此设置。
                </p>
              </div>
              <Switch
                id={inputId}
                checked={data?.enabled ?? false}
                disabled={!data || busy}
                onCheckedChange={(checked) => void setEnabled(checked)}
              />
            </div>
            <div className="border-border/60 border-t px-5 py-4">
              <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
                {busy ? (
                  <LoaderCircle
                    className="text-muted-foreground size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${running ? "bg-foreground" : "bg-muted-foreground/50"}`}
                  />
                )}
                <span>
                  {data
                    ? stateLabels[data.state]
                    : status.isPending
                      ? "正在读取…"
                      : "无法读取服务状态"}
                </span>
              </div>
              {running && data.url ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <code className="text-muted-foreground min-w-0 text-xs break-all" data-copyable>
                    {data.url}
                  </code>
                  <Button
                    variant="outline"
                    disabled={copy.isPending || busy}
                    onClick={() => void copyConfiguration()}
                  >
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied ? "已复制" : "复制连接配置"}
                  </Button>
                </div>
              ) : null}
              {running ? (
                <p className="text-muted-foreground mt-3 text-xs">
                  {data.lastRequestAt
                    ? `最近请求：${new Date(data.lastRequestAt).toLocaleString()}`
                    : "尚未收到请求。复制连接配置后，在 Agent 中添加此服务。"}
                </p>
              ) : null}
              {data?.state === "error" ? (
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setEnabled(true)}
                >
                  重试启动
                </Button>
              ) : null}
              {!data && status.error ? (
                <Button className="mt-3" variant="outline" onClick={() => void status.refetch()}>
                  重新读取
                </Button>
              ) : null}
            </div>
          </div>
          {error ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-4 max-w-xl text-xs leading-6">
            开启服务不会调用模型；实际预演使用已连接的模型服务。关闭时会停止当前预演，保留临时局和记录。
          </p>
        </section>
      </div>
    </>
  );
}
