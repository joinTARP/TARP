import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";

export function CompanionDocumentSettings({
  roomId,
  companionId,
  enabled,
}: {
  roomId: string;
  companionId: string;
  enabled: boolean;
}) {
  const descriptionId = useId();
  const client = useQueryClient();
  const options = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const save = useMutation({
    mutationFn: (next: boolean) =>
      desktopRpc.sessions.companion.setDocumentAccess({ roomId, id: companionId, enabled: next }),
    onSuccess: (value) => client.setQueryData(options.queryKey, value),
  });
  return (
    <div className="mb-6 space-y-2">
      <div className="flex items-center justify-between gap-6">
        <div>
          <h3 className="text-sm font-medium">允许队友查阅文档</h3>
          <p id={descriptionId} className="text-muted-foreground mt-1 text-xs leading-5">
            队友可按需查阅玩家可见的资料，可能增加等待时间和 Token 消耗。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="允许队友查阅文档"
          aria-describedby={descriptionId}
          aria-checked={enabled}
          disabled={save.isPending}
          onClick={() => save.mutate(!enabled)}
          className="bg-input aria-checked:bg-primary focus-visible:outline-ring inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          <span
            className={`bg-background size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${enabled ? "translate-x-4" : "translate-x-0"}`}
          />
        </button>
      </div>
      {save.isSuccess ? (
        <p role="status" className="text-muted-foreground text-xs">
          已保存，下次发言生效。
        </p>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-destructive text-xs">
          无法保存文档查阅设置：{save.error.message}
        </p>
      ) : null}
    </div>
  );
}
