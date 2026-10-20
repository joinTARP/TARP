import { useQuery, useQueryClient } from "@tanstack/react-query";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import {
  ConfigurationSaveStatus,
  ConfigurationSaveStatusProvider,
} from "./ConfigurationSaveStatus";
import { GameDefaultsForm } from "./GameConfigurationForm";

export function GameDefaultsSettingsPanel() {
  const options = desktopOrpc.gameDefaults.get.queryOptions();
  const settings = useQuery(options);
  const client = useQueryClient();
  return (
    <ConfigurationSaveStatusProvider>
      <PageToolbarHeader
        widthClassName="max-w-4xl"
        title="冒险默认设置"
        description="用于新建冒险，不影响已有冒险。"
        actions={settings.data ? <ConfigurationSaveStatus /> : undefined}
      />
      <div className="mx-auto max-w-4xl px-9 pt-8">
        {settings.data ? (
          <GameDefaultsForm
            settings={settings.data}
            onSave={async (patch) => {
              const value = await desktopRpc.gameDefaults.update(patch);
              client.setQueryData(options.queryKey, value);
            }}
          />
        ) : settings.error ? (
          <div role="alert" className="text-destructive text-sm">
            {settings.error.message}
            <Button variant="ghost" onClick={() => void settings.refetch()}>
              重试
            </Button>
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            正在读取冒险默认设置…
          </p>
        )}
      </div>
    </ConfigurationSaveStatusProvider>
  );
}
