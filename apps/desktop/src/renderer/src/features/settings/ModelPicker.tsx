import {
  thinkingLevelSchema,
  type ThinkingLevel,
  type AvailableAiModel,
} from "@tarp/core/shared/game";
import { Check, Search } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search aria-hidden="true" className="text-muted-foreground absolute top-2.5 left-3 size-4" />
      <Input
        autoFocus
        aria-label={placeholder}
        className="h-10 pl-9"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function ModelPicker({
  models,
  selection,
  busy,
  loading,
  onSelect,
  onConnect,
}: {
  models: AvailableAiModel[];
  selection: AvailableAiModel | null;
  busy: boolean;
  loading: boolean;
  onSelect: (model: AvailableAiModel) => void;
  onConnect?: () => void;
}) {
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | "default">(
    selection?.thinkingLevel ?? "default",
  );
  const choose = (model: AvailableAiModel) =>
    onSelect({ ...model, thinkingLevel: thinkingLevel === "default" ? undefined : thinkingLevel });
  const [search, setSearch] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const query = search.trim().toLowerCase();
  const filtered = models.filter((model) =>
    `${model.name} ${model.model} ${model.provider} ${model.providerName}`
      .toLowerCase()
      .includes(query),
  );
  const groups = new Map<string, AvailableAiModel[]>();
  for (const model of filtered) {
    const key = model.provider;
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }
  return (
    <div
      className="space-y-3"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          !busy &&
          !loading &&
          filtered[0]
        ) {
          event.preventDefault();
          choose(filtered[0]);
          return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const buttons = Array.from(
          list.current?.querySelectorAll<HTMLButtonElement>("button[data-model]:not(:disabled)") ??
            [],
        );
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          index < 0
            ? event.key === "ArrowDown"
              ? 0
              : buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }}
    >
      <div className="space-y-2">
        <Select
          value={thinkingLevel}
          onValueChange={(value) => setThinkingLevel(value as ThinkingLevel | "default")}
          disabled={busy || loading}
        >
          <SelectTrigger aria-label="推理强度" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">推理强度：默认（中）</SelectItem>
            {thinkingLevelSchema.options.map((level) => (
              <SelectItem key={level} value={level}>
                推理强度：
                {
                  {
                    off: "关闭",
                    minimal: "最低",
                    low: "低",
                    medium: "中",
                    high: "高",
                    xhigh: "超高",
                    max: "最高",
                  }[level]
                }
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          选择强度后点击模型保存。实际强度由模型支持范围决定，不支持推理的模型会忽略此设置。
        </p>
      </div>
      <SearchField value={search} onChange={setSearch} placeholder="搜索模型名称或服务商" />
      {loading ? (
        <p role="status" className="text-muted-foreground py-6 text-center text-sm">
          正在加载可用模型…
        </p>
      ) : (
        <ScrollAreaPane
          viewportRef={list}
          className="h-[min(20rem,40vh)]"
          contentClassName="space-y-4"
          aria-label="可用模型"
        >
          {[...groups].map(([key, entries]) => (
            <section key={key} aria-label={entries[0].providerName}>
              <h4 className="text-muted-foreground bg-popover sticky top-0 px-3 py-2 text-xs font-medium">
                {entries[0].providerName}
              </h4>
              {entries.map((model) => {
                const selected =
                  selection?.model === model.model && selection.provider === model.provider;
                return (
                  <button
                    type="button"
                    data-model
                    key={model.model}
                    disabled={busy}
                    aria-pressed={selected}
                    className="hover:bg-muted focus-visible:outline-ring flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
                    onClick={() => choose(model)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium break-all">{model.name}</span>
                      {model.name !== model.model ? (
                        <span className="text-muted-foreground mt-1 block text-xs break-all">
                          {model.model}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <Check aria-label="当前模型" className="text-primary size-4" />
                    ) : null}
                  </button>
                );
              })}
            </section>
          ))}
          {!filtered.length ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {models.length
                ? "没有匹配的模型，试试其他关键词。"
                : "还没有可用模型，请先连接服务商。"}
            </p>
          ) : null}
        </ScrollAreaPane>
      )}
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-muted-foreground text-xs">
          {busy ? "正在保存…" : `${filtered.length} 个模型 · ↑ ↓ 选择，Enter 使用`}
        </p>
        {onConnect ? (
          <Button variant="ghost" disabled={busy} onClick={onConnect}>
            管理应用模型配置
          </Button>
        ) : null}
      </div>
    </div>
  );
}
