import { roomConfiguration } from "@jointarp/core/shared/game-defaults";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import {
  RoomConfigurationForm,
  type RoomConfigurationSection,
} from "../settings/GameConfigurationForm";
import { speechPlayer } from "../tts/use-speech";

export function RoomConfigurationSettings({
  roomId,
  section,
}: {
  roomId: string;
  section: RoomConfigurationSection;
}) {
  const options = desktopOrpc.sessions.settings.get.queryOptions({ input: { roomId } });
  const settings = useQuery({ ...options, staleTime: 0 });
  const client = useQueryClient();
  if (!settings.data)
    return (
      <div className="py-6">
        {settings.error ? (
          <p role="alert">
            {settings.error.message}
            <Button variant="ghost" onClick={() => void settings.refetch()}>
              重试
            </Button>
          </p>
        ) : (
          <p role="status">正在读取冒险配置…</p>
        )}
      </div>
    );
  return (
    <RoomConfigurationForm
      key={roomId}
      roomId={roomId}
      section={section}
      settings={roomConfiguration(settings.data)}
      onSave={async (patch) => {
        const next = await desktopRpc.sessions.settings.update({ roomId, patch });
        client.setQueryData(options.queryKey, next);
        if (patch.tts) {
          speechPlayer.stop(roomId);
          await Promise.all([
            client.invalidateQueries({ queryKey: desktopOrpc.tts.roomSettings.key() }),
            client.invalidateQueries({ queryKey: desktopOrpc.tts.hostVoiceSettings.key() }),
            client.invalidateQueries({ queryKey: desktopOrpc.tts.voiceSettings.key() }),
          ]);
        }
      }}
    />
  );
}
