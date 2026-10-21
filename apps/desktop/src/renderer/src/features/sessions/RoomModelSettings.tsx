import type { AiConfig } from "@jointarp/core/shared/game";
import type { RoomAiSettings } from "@jointarp/core/shared/game";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { AiSettingsPanel } from "../settings/AiSettingsPanel";
import { ModelPicker } from "../settings/ModelPicker";
import { errorMessage } from "./game-client";

export function RoomModelSettings({
  roomId,
  onSelected,
}: {
  roomId: string;
  onSelected?: (settings: RoomAiSettings) => void;
}) {
  const client = useQueryClient();
  const settingsOptions = desktopOrpc.sessions.ai.get.queryOptions({ input: { roomId } });
  const modelsOptions = desktopOrpc.ai.availableModels.queryOptions();
  const settings = useQuery(settingsOptions);
  const models = useQuery(modelsOptions);
  const [managing, setManaging] = useState(false);
  const select = useMutation({
    mutationFn: (model: AiConfig) => desktopRpc.sessions.ai.select({ roomId, ...model }),
    onSuccess: (value) => {
      client.setQueryData(settingsOptions.queryKey, value);
      onSelected?.(value);
    },
  });
  const error = settings.error ?? models.error ?? select.error;
  const loading = settings.isPending || models.isPending;

  if (managing)
    return (
      <div>
        <Button
          variant="outline"
          onClick={() => {
            setManaging(false);
            void client.invalidateQueries({ queryKey: settingsOptions.queryKey });
            void client.invalidateQueries({ queryKey: modelsOptions.queryKey });
          }}
        >
          返回冒险模型选择
        </Button>
        <AiSettingsPanel embedded />
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        只影响当前冒险，从下一次 AI 回复起生效。其他冒险保持各自的模型选择。
      </p>
      {settings.data?.selection ? (
        <p className="text-sm">
          当前冒险：{settings.data.selection.providerName} · {settings.data.selection.name}
          {!settings.data.ready ? "（连接不可用，请重新配置或选择）" : ""}
        </p>
      ) : null}
      <ModelPicker
        models={models.data ?? []}
        selection={settings.data?.selection ?? null}
        busy={select.isPending}
        loading={loading}
        onSelect={(model) => select.mutate(model)}
        onConnect={() => setManaging(true)}
      />
      {error ? (
        <div role="alert" className="text-destructive text-sm">
          {errorMessage(error)}
          <Button
            variant="ghost"
            onClick={() => {
              void settings.refetch();
              void models.refetch();
              select.reset();
            }}
          >
            重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}
