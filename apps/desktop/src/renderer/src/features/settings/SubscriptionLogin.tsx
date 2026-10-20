import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { desktopRpc } from "../../desktop-rpc";

type Status = Awaited<ReturnType<typeof desktopRpc.ai.subscription.status>>;

export function SubscriptionLogin({
  onConnected,
  onAuthenticated,
}: {
  onConnected: (connected: boolean) => void;
  onAuthenticated?: () => void;
}) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const attempt = useRef<string | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    onConnected(false);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await desktopRpc.ai.subscription.status();
        if (!active) return;
        setStatus(next);
        onConnected(next.connected && next.status !== "pending");
        if (next.status !== "pending" && next.id === attempt.current) {
          attempt.current = undefined;
          if (next.status === "success" && next.connected) onAuthenticated?.();
        }
      } catch {
        if (active) setError("无法读取登录状态，请关闭弹窗后重试。");
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      active = false;
      mounted.current = false;
      clearTimeout(timer);
      if (attempt.current)
        void desktopRpc.ai.subscription.cancel({ id: attempt.current }).catch(() => {});
    };
  }, [onConnected, onAuthenticated]);

  async function start(method: "browser" | "device_code") {
    setBusy(true);
    setError("");
    setCode("");
    onConnected(false);
    try {
      const { id } = await desktopRpc.ai.subscription.start({ method });
      if (!mounted.current) {
        await desktopRpc.ai.subscription.cancel({ id });
        return;
      }
      attempt.current = id;
      setStatus(await desktopRpc.ai.subscription.status());
    } catch {
      setError("无法启动登录，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      const next = await desktopRpc.ai.subscription.status();
      if (mounted.current) {
        setStatus(next);
        onConnected(next.connected && next.status !== "pending");
      }
    } catch {
      if (mounted.current) setError("操作失败，请重试。");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const pending = status?.status === "pending";
  return (
    <section
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-4"
      aria-label="ChatGPT 订阅登录"
    >
      <div className="space-y-1">
        <h4 className="text-sm font-medium">ChatGPT 订阅</h4>
        <p className="text-muted-foreground text-xs leading-5">
          使用账号可用的 Codex 模型与额度，无需填写 API Key。同一账号用于本应用的所有订阅模型。
        </p>
      </div>
      <p role="status" className="text-sm">
        {!status
          ? "正在读取登录状态…"
          : pending || status.status === "error"
            ? status.message
            : status.connected
              ? "已连接 ChatGPT 账号"
              : (status.message ?? "尚未登录")}
      </p>
      {pending && status.userCode ? (
        <p className="text-sm">
          在浏览器中输入设备码：
          <strong className="font-mono tracking-widest select-all">{status.userCode}</strong>
        </p>
      ) : null}
      {pending && status.manual ? (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-default">浏览器登录后没有自动返回？</summary>
          <div className="mt-3 space-y-2">
            <label className="block space-y-2">
              <span>粘贴浏览器最后跳转的完整回调地址</span>
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="http://localhost:1455/auth/callback?…"
                autoComplete="off"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !code.trim()}
              onClick={() =>
                void action(async () => {
                  await desktopRpc.ai.subscription.submit({ id: status.id!, value: code.trim() });
                  setCode("");
                })
              }
            >
              完成登录
            </Button>
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void action(() => desktopRpc.ai.subscription.cancel({ id: status.id! }))}
          >
            取消登录
          </Button>
        ) : (
          <>
            <Button type="button" disabled={busy || !status} onClick={() => void start("browser")}>
              {status?.connected ? "重新登录" : "使用 ChatGPT 登录"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || !status}
              onClick={() => void start("device_code")}
            >
              设备码登录
            </Button>
            {status?.connected ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void action(() => desktopRpc.ai.subscription.logout())}
              >
                退出登录
              </Button>
            ) : null}
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
