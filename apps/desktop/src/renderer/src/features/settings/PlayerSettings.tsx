import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { AutosaveField } from "./AutosaveField";

export function PlayerSettings() {
  const client = useQueryClient();
  const options = desktopOrpc.player.get.queryOptions();
  const player = useQuery(options);
  return (
    <section className="mt-12" aria-labelledby="player-settings-heading">
      <h2 id="player-settings-heading" className="text-base font-semibold">
        玩家信息
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">
        昵称用于你参与的所有冒险，不影响角色名称和笔记归属。
      </p>
      <div className="border-border bg-card mt-5 rounded-xl border p-4">
        {player.data ? (
          <AutosaveField
            label="玩家昵称"
            value={player.data.nickname}
            inputMode="text"
            maxLength={32}
            validate={(value) => (value.trim() ? undefined : "昵称不能为空")}
            onSave={async (nickname) => {
              const value = await desktopRpc.player.update({ nickname: nickname.trim() });
              await client.cancelQueries({ queryKey: options.queryKey });
              client.setQueryData(options.queryKey, value);
            }}
          />
        ) : player.error ? (
          <div role="alert" className="text-destructive text-sm">
            无法读取玩家信息。
            <Button variant="ghost" size="sm" onClick={() => void player.refetch()}>
              重试
            </Button>
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            正在读取玩家信息…
          </p>
        )}
      </div>
    </section>
  );
}
