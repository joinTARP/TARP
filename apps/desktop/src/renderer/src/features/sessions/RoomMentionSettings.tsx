import { mentionReplyLimitSchema } from "@jointarp/core/shared/mentions";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { AutosaveField } from "../settings/AutosaveField";
import { SettingsSection } from "../settings/SettingsSection";

export function RoomMentionSettings({ roomId }: { roomId: string }) {
  const client = useQueryClient();
  const options = desktopOrpc.sessions.settings.get.queryOptions({ input: { roomId } });
  const settings = useQuery(options);
  const access = useQuery(desktopOrpc.game.steering.get.queryOptions({ input: { roomId } }));
  if (settings.error || access.error)
    return (
      <div className="py-4">
        <p role="alert" className="text-destructive text-xs">
          {settings.error?.message ?? access.error?.message}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void Promise.all([settings.refetch(), access.refetch()])}
        >
          重试读取
        </Button>
      </div>
    );
  if (!settings.data || !access.data)
    return <p className="text-muted-foreground py-4 text-xs">正在读取点名交流设置…</p>;
  return (
    <SettingsSection title="点名交流">
      {access.data.isHost ? (
        <AutosaveField
          label="连续响应上限"
          value={String(settings.data.chat.mentionReplyLimit)}
          maxLength={2}
          hint="本局每条点名对话链最多自动生成的回复数，包含主持场外回应和队友回复，范围 1–32；下一条新对话链生效。"
          validate={(value) =>
            mentionReplyLimitSchema.safeParse(Number(value)).success
              ? undefined
              : "请输入 1–32 之间的整数。"
          }
          onSave={async (value) => {
            await desktopRpc.game.chat.setMentionReplyLimit({ roomId, limit: Number(value) });
            await client.invalidateQueries({ queryKey: options.queryKey });
          }}
        />
      ) : (
        <p className="text-sm">连续响应上限：{settings.data.chat.mentionReplyLimit}</p>
      )}
    </SettingsSection>
  );
}
