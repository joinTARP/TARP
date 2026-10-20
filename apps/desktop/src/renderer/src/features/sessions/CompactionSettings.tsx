import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  compactionSettingsSchema,
  resolveCompaction,
  type CompactionRole,
} from "@tarp/core/shared/compaction-settings";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Field, FieldError, Form } from "../../components/ui/form";
import { NumberInput } from "../../components/ui/number-input";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";

export function CompactionSettings({
  roomId,
  role,
  contextWindow,
}: {
  roomId: string;
  role: CompactionRole;
  contextWindow?: number | null;
}) {
  const id = useId();
  const client = useQueryClient();
  const options = desktopOrpc.sessions.ai.compaction.queryOptions({ input: { roomId } });
  const query = useQuery(options);
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (thresholdTokens: number | null) =>
      desktopRpc.sessions.ai.saveCompaction({
        roomId,
        role,
        settings: { thresholdTokens },
      }),
    onSuccess: (value) => {
      client.setQueryData(options.queryKey, value);
      setDraft(null);
    },
  });
  const settings = query.data?.[role];
  const value = draft ?? String(settings?.thresholdTokens ?? "");
  const parsed = compactionSettingsSchema.safeParse({
    thresholdTokens: value.trim() ? Number(value) : null,
  });
  const effective = settings && contextWindow ? resolveCompaction(settings, contextWindow) : null;
  const error = query.error ?? save.error;
  const changed = !parsed.success || parsed.data.thresholdTokens !== settings?.thresholdTokens;

  return (
    <Form
      className="relative mt-5 space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (settings && parsed.success) save.mutate(parsed.data.thresholdTokens);
      }}
    >
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {role === "host" ? "主持人" : "AI 队友"}自动压缩阈值
        </label>
        <p className="text-muted-foreground mt-1 text-xs">
          {role === "companion" ? "当前冒险的所有 AI 队友共用此设置。" : "仅用于当前冒险的主持人。"}
          保存后从下一次调用生效。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Field
          className="w-40"
          name="thresholdTokens"
          validate={(next) =>
            compactionSettingsSchema.safeParse({ thresholdTokens: next }).success
              ? null
              : "请输入范围内的整数，或留空使用自动阈值。"
          }
        >
          <NumberInput
            id={id}
            min={1024}
            max={2000000}
            step={1}
            placeholder="自动"
            className="w-40"
            value={value.trim() ? Number(value) : null}
            disabled={!settings || save.isPending}
            aria-describedby={`${id}-help`}
            onValueChange={(next) => {
              setDraft(next === null ? "" : String(next));
              save.reset();
            }}
          />
          <FieldError>请输入范围内的整数，或留空使用自动阈值。</FieldError>
        </Field>
        <span className="text-muted-foreground text-xs">Token</span>
        <Button type="submit" size="sm" disabled={!settings || !changed || save.isPending}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!settings || save.isPending || value === ""}
          onClick={() => {
            setDraft("");
            save.reset();
          }}
        >
          恢复自动
        </Button>
      </div>
      <p id={`${id}-help`} className="text-muted-foreground text-xs leading-5">
        留空使用自动阈值，自定义范围为 1,024–2,000,000 Token。
        {effective
          ? ` 已保存设置在当前模型下：超过 ${effective.thresholdTokens.toLocaleString("zh-CN")} Token 时触发压缩，保留最近约 ${effective.keepRecentTokens.toLocaleString("zh-CN")} Token。`
          : role === "companion"
            ? "实际触发值会根据各队友模型的可用窗口调整。"
            : "模型调用后可查看实际触发值。"}
        {effective &&
        settings?.thresholdTokens &&
        settings.thresholdTokens > effective.thresholdTokens
          ? " 设置值超过模型可用窗口，已按窗口上限降低阈值。"
          : ""}
      </p>
      {query.isPending ? (
        <p role="status" className="text-muted-foreground text-xs">
          正在读取压缩设置…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          无法读取或保存压缩设置：{error.message}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void query.refetch();
              save.reset();
            }}
          >
            重试
          </Button>
        </p>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="text-muted-foreground text-xs">
          已保存，下次调用生效。
        </p>
      ) : null}
    </Form>
  );
}
