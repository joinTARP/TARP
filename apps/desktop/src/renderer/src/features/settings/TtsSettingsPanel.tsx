import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { errorMessage } from "../sessions/game-client";
import { speechPlayer } from "../tts/use-speech";

function Connection({
  provider,
  name,
  hasKey,
  refresh,
}: {
  provider: string;
  name: string;
  hasKey: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      if (remove) {
        await desktopRpc.tts.disconnect({ provider });
        speechPlayer.stop();
      } else await desktopRpc.tts.connect({ provider, apiKey: key.trim() });
      setKey("");
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      noValidate
      className="border-border space-y-4 rounded-xl border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{name}</h3>
        <span className="text-muted-foreground text-xs">{hasKey ? "已连接" : "未连接"}</span>
      </div>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${name} API Key`}
        value={key}
        disabled={busy}
        placeholder={hasKey ? "填写新 API Key 更换凭据" : "填写 API Key"}
        onChange={(event) => setKey(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !key.trim()}>
          {busy ? "正在保存…" : hasKey ? "更新连接" : "连接"}
        </Button>
        {hasKey ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void save(true)}
          >
            删除连接
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}
export function TtsSettingsPanel() {
  const options = desktopOrpc.tts.connections.queryOptions();
  const connections = useQuery(options);
  const client = useQueryClient();
  async function refresh() {
    await Promise.all([
      client.invalidateQueries(options),
      client.invalidateQueries({ queryKey: desktopOrpc.tts.roomSettings.key() }),
    ]);
  }
  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-4xl"
        title="语音供应商"
        description="连接供冒险使用的语音服务。默认声音和自动朗读在冒险默认设置中调整。"
      />
      <div className="mx-auto max-w-4xl space-y-5 px-9 pt-8">
        <p className="text-muted-foreground text-xs leading-6">
          密钥只保存在本机，不写入冒险。删除连接后，使用该供应商的冒险无法朗读；重新连接后恢复。
        </p>
        {connections.data?.map((item) => (
          <Connection key={item.provider} {...item} refresh={refresh} />
        ))}
        {connections.error ? (
          <p role="alert" className="text-destructive text-sm">
            {connections.error.message}
            <Button variant="ghost" onClick={() => void connections.refetch()}>
              重试
            </Button>
          </p>
        ) : !connections.data ? (
          <p role="status">正在读取语音连接…</p>
        ) : null}
      </div>
    </>
  );
}
