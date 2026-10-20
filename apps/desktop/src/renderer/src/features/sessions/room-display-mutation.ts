import type { QueryClient, QueryKey } from "@tanstack/react-query";

type DisplaySettings = { showReasoning: boolean; showAllDocuments: boolean };
type DisplayChange = { key: keyof DisplaySettings; value: boolean };

export function roomDisplayMutation(
  client: QueryClient,
  queryKey: QueryKey,
  roomId: string,
  save: (patch: Partial<DisplaySettings>) => Promise<DisplaySettings>,
  onSaved: () => void,
) {
  const fields = new Map<
    keyof DisplaySettings,
    { revision: number; confirmed: boolean; pending: number }
  >();
  return {
    // 连续点击立即更新界面，写入按点击顺序执行。
    scope: { id: `room-display:${roomId}` },
    mutationFn: ({ key, value }: DisplayChange) => save({ [key]: value }),
    onMutate: ({ key, value }: DisplayChange) => {
      void client.cancelQueries({ queryKey, exact: true });
      const previous = client.getQueryData<DisplaySettings>(queryKey);
      const field = fields.get(key) ?? { revision: 0, confirmed: false, pending: 0 };
      if (field.pending === 0) field.confirmed = previous?.[key] ?? false;
      field.pending++;
      const revision = ++field.revision;
      fields.set(key, field);
      client.setQueryData<DisplaySettings>(queryKey, (current) =>
        current ? { ...current, [key]: value } : current,
      );
      return { revision };
    },
    onSuccess: (
      settings: DisplaySettings,
      { key }: DisplayChange,
      context: { revision: number },
    ) => {
      const field = fields.get(key)!;
      field.confirmed = settings[key];
      // 响应只更新自身字段，且不能覆盖同一开关的后续点击。
      if (field.revision === context.revision) {
        client.setQueryData<DisplaySettings>(queryKey, (current) =>
          current ? { ...current, [key]: settings[key] } : current,
        );
      }
      onSaved();
    },
    onError: (_error: Error, { key }: DisplayChange, context: { revision: number } | undefined) => {
      const field = fields.get(key);
      if (field && field.revision === context?.revision) {
        client.setQueryData<DisplaySettings>(queryKey, (current) =>
          current ? { ...current, [key]: field.confirmed } : current,
        );
      }
    },
    onSettled: (
      _settings: DisplaySettings | undefined,
      _error: Error | null,
      { key }: DisplayChange,
    ) => {
      const field = fields.get(key);
      if (field) field.pending--;
    },
  };
}
