import {
  companionInitiativeOptions,
  companionInitiativeSchema,
  type CompanionInitiative,
} from "@jointarp/core/shared/companion-initiative";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";

export function CompanionInitiativeSettings({
  roomId,
  companionId,
  initiative,
}: {
  roomId: string;
  companionId: string;
  initiative: CompanionInitiative;
}) {
  const headingId = useId();
  const promptId = useId();
  const client = useQueryClient();
  const companionOptions = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const [draft, setDraft] = useState<CompanionInitiative | null>(null);
  const save = useMutation({
    mutationFn: (next: CompanionInitiative) =>
      desktopRpc.sessions.companion.setInitiative({ roomId, id: companionId, initiative: next }),
    onSuccess: (value) => {
      client.setQueryData(companionOptions.queryKey, value);
      setDraft(null);
    },
  });
  const current = draft ?? initiative;
  const parsed = companionInitiativeSchema.safeParse(current);
  const custom = current.level === "custom";
  const customMissing = custom && !current.prompt.trim();
  const changed =
    current.level !== initiative.level || (custom && current.prompt.trim() !== initiative.prompt);
  const option =
    companionInitiativeOptions.find((item) => item.id === current.level) ??
    companionInitiativeOptions[1];
  const levelIndex = companionInitiativeOptions.findIndex((item) => item.id === option.id);
  const position = `${(levelIndex / (companionInitiativeOptions.length - 1)) * 100}%`;
  const chooseLevel = (index: number) => {
    const next = companionInitiativeOptions[index];
    if (!next || save.isPending) return;
    setDraft({ ...current, level: next.id });
    save.reset();
  };

  return (
    <form
      noValidate
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.success || !changed || customMissing) return;
        save.mutate(parsed.data);
      }}
    >
      <h3 id={headingId} className="text-sm font-medium">
        互动主动性
      </h3>
      <p className="text-muted-foreground mt-1 text-xs leading-5">调整队友主动发言的频率。</p>
      <div className={`mt-4 ${save.isPending ? "pointer-events-none opacity-50" : ""}`}>
        <div className="relative mx-[10%] h-8">
          <div className="bg-muted absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full">
            <div className="bg-foreground h-full rounded-full" style={{ width: position }} />
            <div
              className="bg-foreground absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-sm"
              style={{ left: position }}
            />
          </div>
          <input
            type="range"
            className="absolute inset-0 z-10 h-full w-full cursor-default appearance-none opacity-0 disabled:cursor-default"
            min={0}
            max={companionInitiativeOptions.length - 1}
            step={1}
            value={levelIndex}
            disabled={save.isPending}
            aria-labelledby={headingId}
            aria-valuetext={`${option.label}。${option.summary}`}
            onChange={(event) => chooseLevel(Number(event.target.value))}
          />
        </div>
        <div className="mt-1 grid grid-cols-5">
          {companionInitiativeOptions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`px-0.5 text-center text-xs ${index === levelIndex ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
              disabled={save.isPending}
              aria-pressed={index === levelIndex}
              onClick={() => chooseLevel(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-muted-foreground mt-3 text-xs leading-5">{option.summary}</p>
      {custom ? (
        <div className="mt-4">
          <label htmlFor={promptId} className="text-sm font-medium">
            互动指导
          </label>
          <Textarea
            id={promptId}
            className="mt-2 min-h-28 leading-6"
            maxLength={2000}
            value={current.prompt}
            disabled={save.isPending}
            placeholder="例如：只在被点名、遇险或轮到自己行动时开口，其余时候保持沉默。"
            onChange={(event) => {
              setDraft({ ...current, prompt: event.target.value });
              save.reset();
            }}
          />
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={!changed || !parsed.success || customMissing || save.isPending}
        >
          {save.isPending ? "保存中…" : "保存"}
        </Button>
        {save.isSuccess && !draft ? (
          <p role="status" className="text-muted-foreground text-xs">
            已保存，下次发言生效。
          </p>
        ) : null}
      </div>
      {customMissing ? (
        <p className="text-muted-foreground mt-2 text-xs">请填写互动指导。</p>
      ) : null}
      {save.error ? (
        <div role="alert" className="text-destructive mt-2 flex items-center gap-2 text-xs">
          <p>无法保存互动主动性：{save.error.message}</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => save.reset()}>
            关闭
          </Button>
        </div>
      ) : null}
    </form>
  );
}
