import type { CreationAnswer } from "@jointarp/module/creation-workbench";
import type { LaunchAction, LaunchState } from "@tarp/core/shared/launch";
import type { RoomLaunchState } from "@tarp/core/shared/room-state";
import { Dices, Check } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { Button } from "../../components/ui/button";
import { NumberInput } from "../../components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { documentMarkdownPlugins } from "../modules/document-markdown";
import {
  DocumentReference,
  DocumentReferences,
  documentMarkdownComponents,
} from "../modules/DocumentReferences";
import { FieldInput } from "./CharacterFields";
import { CharacterPreview } from "./CharacterPreview";
const ReactMarkdown = lazy(() => import("react-markdown"));

function optionPreview(source: string | undefined): string {
  if (!source) return "";
  const line = source
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(
      (value) =>
        value &&
        !value.startsWith("#") &&
        !value.startsWith("---") &&
        !value.startsWith("|") &&
        !value.startsWith("-") &&
        !value.startsWith("*"),
    );
  return (line ?? "").replace(/^>\s*/u, "").replaceAll(/[*_`]/gu, "");
}

export function CreationWorkbench({
  state,
  act,
}: {
  state: LaunchState;
  act: (
    args: Omit<LaunchAction, "roomId" | "revision" | "roomRevision">,
  ) => Promise<RoomLaunchState | null | undefined>;
}) {
  const view = state.workbench!;
  const progress = state.progress.workbench;
  const stage = progress?.stage ?? 0;
  const [answers, setAnswers] = useState<Record<string, CreationAnswer>>({});
  const [pair, setPair] = useState<string[]>([]);
  const type = state.types.find((t) => t.id === state.progress.typeId)!;
  const items = view.items.filter((i) => i.stage === stage);
  async function send(
    operation: NonNullable<LaunchAction["operation"]>,
    extra: Partial<LaunchAction> = {},
  ) {
    const result = await act({
      action: "workbench",
      operation,
      requestId: crypto.randomUUID(),
      answers,
      ...extra,
    });
    if (result) setAnswers({});
  }
  const editable = items.filter((i) =>
    ["input", "choice", "reference", "purchase"].includes(i.kind),
  );
  const rolled = items.filter((i) => ["roll", "table"].includes(i.kind));
  const stageReady = view.stages[stage].complete && !Object.keys(answers).length;
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">正在载入建卡资料…</p>}>
      <div className="space-y-4">
        <nav
          aria-label="建卡阶段"
          className="bg-background/95 border-border sticky top-0 z-10 -mx-1 flex flex-wrap gap-1 border-b px-1 py-2 backdrop-blur-sm"
        >
          {view.stages.map((s, i) => (
            <Button
              key={s.id}
              size="sm"
              variant={i === stage ? "secondary" : "ghost"}
              disabled={i > (progress?.visited ?? 0)}
              aria-current={i === stage ? "step" : undefined}
              onClick={() => void send("navigate", { stageIndex: i })}
            >
              {s.complete ? (
                <Check className="size-3.5" />
              ) : (
                <span className="text-muted-foreground">0{i + 1}</span>
              )}
              {s.title}
            </Button>
          ))}
        </nav>
        <div className="space-y-5">
          <div className="min-w-0">
            <div className="space-y-4 pb-16">
              <header>
                <p className="text-muted-foreground mb-1 text-xs tracking-widest">
                  创建角色 · {stage + 1} / {view.stages.length}
                </p>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {view.stages[stage].title}
                </h2>
              </header>
              {editable.map((item) => (
                <div key={item.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    {item.kind !== "input" ? (
                      <label htmlFor={item.key} className="text-sm font-medium">
                        {item.title}
                      </label>
                    ) : null}
                    {item.kind === "reference" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void send("randomReference")}
                      >
                        <Dices className="size-4" />
                        随机选择
                      </Button>
                    ) : null}
                  </div>
                  {item.private ? (
                    <p className="text-muted-foreground text-xs">仅你与主持人可见</p>
                  ) : null}
                  {item.error ? <p className="text-destructive text-xs">{item.error}</p> : null}
                  {item.kind === "purchase" ? (
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-xs">
                        {item.spendAll ? "需用完预算" : "可保留余款"} · 预算 {item.budget}{" "}
                        {item.currency ?? ""}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={item.spendAll && item.budget !== 0}
                        onClick={() =>
                          void send("save", { answers: { ...answers, [item.key]: {} } })
                        }
                      >
                        不购买物品
                      </Button>
                      {item.options.map((o) => (
                        <label
                          key={o.value}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span>{o.label}</span>
                          <NumberInput
                            quantity
                            min={0}
                            max={100}
                            aria-label={`${o.label}数量`}
                            className="w-28"
                            value={
                              ((answers[item.key] ?? item.answer ?? {}) as Record<string, number>)[
                                o.value
                              ] ?? 0
                            }
                            onValueChange={(next) =>
                              setAnswers((current) => ({
                                ...current,
                                [item.key]: {
                                  ...((current[item.key] ?? item.answer ?? {}) as Record<
                                    string,
                                    number
                                  >),
                                  [o.value]: next ?? 0,
                                },
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  ) : item.kind === "input" && item.field ? (
                    <FieldInput
                      field={{ ...item.field, label: item.title }}
                      allowPrivate
                      value={Object.hasOwn(answers, item.key) ? answers[item.key] : item.answer}
                      references={state.references}
                      onChange={(value) =>
                        setAnswers((current) => ({
                          ...current,
                          [item.key]: JSON.parse(JSON.stringify(value ?? null)) as CreationAnswer,
                        }))
                      }
                    />
                  ) : item.kind === "choice" ? (
                    <Select
                      items={[{ value: "", label: "请选择" }, ...item.options]}
                      value={typeof item.answer === "string" ? item.answer : ""}
                      onValueChange={(next) =>
                        void send("save", { answers: { ...answers, [item.key]: next ?? "" } })
                      }
                    >
                      <SelectTrigger id={item.key} aria-label={item.title} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">请选择</SelectItem>
                        {item.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div
                      className={`grid gap-1.5 ${item.options.some((option) => option.body) ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"}`}
                    >
                      {item.options.map((o) => (
                        <div
                          key={o.value}
                          className={`min-w-0 rounded-md border ${item.answer === o.value ? "border-primary bg-primary/5" : "border-border"}`}
                        >
                          <button
                            type="button"
                            aria-pressed={item.answer === o.value}
                            className="flex w-full items-start justify-between gap-2 p-2.5 text-left text-sm"
                            onClick={() =>
                              void send("save", { answers: { ...answers, [item.key]: o.value } })
                            }
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{o.label}</span>
                              {o.body ? (
                                <span className="text-muted-foreground mt-1 block truncate text-xs">
                                  {optionPreview(o.body)}
                                </span>
                              ) : null}
                            </span>
                            {item.answer === o.value ? (
                              <Check className="mt-0.5 size-4 shrink-0" />
                            ) : null}
                          </button>
                          <DocumentReferences documents={state.references} types={state.types}>
                            <div className="px-2.5 pb-2 text-xs">
                              <DocumentReference value={o.value}>查看资料</DocumentReference>
                            </div>
                          </DocumentReferences>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {rolled.length ? (
                <section className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-muted-foreground text-sm">掷骰结果会显示在角色卡中。</p>
                    <Button
                      disabled={!rolled.some((i) => i.missing)}
                      onClick={() => void send("generate")}
                    >
                      <Dices className="size-4" />
                      随机选择
                    </Button>
                  </div>
                  <div className="divide-border border-border divide-y rounded-lg border px-4">
                    {rolled.map((item) => (
                      <div key={item.key} className="py-4">
                        <p className="text-muted-foreground mb-1 text-xs">
                          {item.title}
                          {item.private ? " · 仅你与主持人可见" : ""}
                        </p>
                        <div className="[&_td]:border-border [&_th]:border-border [&_th]:bg-muted/50 text-sm leading-7 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left">
                          <DocumentReferences documents={state.references} types={state.types}>
                            <ReactMarkdown
                              components={documentMarkdownComponents}
                              remarkPlugins={documentMarkdownPlugins}
                            >
                              {item.result === undefined ? "等待掷骰" : String(item.result)}
                            </ReactMarkdown>
                          </DocumentReferences>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {Object.keys(answers).length ? (
                <Button onClick={() => void send("save")}>保存输入</Button>
              ) : null}
              {view.swap.length &&
              view.swap.every(({ path }) => {
                const value = path
                  .split(".")
                  .reduce<unknown>(
                    (current, key) =>
                      current && typeof current === "object"
                        ? (current as Record<string, unknown>)[key]
                        : undefined,
                    view.draft.values,
                  );
                return typeof value === "number";
              }) ? (
                <div className="border-border space-y-3 rounded-lg border p-4">
                  <p className="text-sm">可以交换两项数值，或保留当前结果。</p>
                  <div className="flex flex-wrap gap-2">
                    {view.swap.map(({ path: f, label }) => (
                      <Button
                        key={f}
                        size="sm"
                        variant={pair.includes(f) ? "secondary" : "outline"}
                        onClick={() =>
                          setPair(
                            pair.includes(f) ? pair.filter((p) => p !== f) : [...pair.slice(-1), f],
                          )
                        }
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    disabled={pair.length !== 2}
                    onClick={() => void send("swap", { swap: pair as [string, string] })}
                  >
                    采用这组交换
                  </Button>
                  {progress?.swap ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void send("swap", { swap: null })}
                    >
                      恢复原顺序
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {stage === view.stages.length - 1 && view.missing.length ? (
                <p className="text-muted-foreground text-sm">待完成：{view.missing.join("、")}</p>
              ) : null}
            </div>
            <footer className="bg-background/95 border-border sticky bottom-0 z-10 -mx-1 flex justify-between border-t px-1 py-3 shadow-[0_-8px_20px_-16px_hsl(var(--foreground)/.5)] backdrop-blur-sm">
              <Button
                variant="ghost"
                disabled={stage === 0}
                onClick={() => void send("navigate", { stageIndex: stage - 1 })}
              >
                上一步
              </Button>
              <Button
                disabled={
                  !stageReady || (stage === view.stages.length - 1 && view.missing.length > 0)
                }
                onClick={() =>
                  void send(stage === view.stages.length - 1 ? "review" : "navigate", {
                    stageIndex: stage + 1,
                  })
                }
              >
                {stage === view.stages.length - 1 ? "预览角色" : "下一步"}
              </Button>
            </footer>
          </div>
          {stage === view.stages.length - 1 ? (
            <aside className="border-border bg-card/50 rounded-lg border p-4">
              <details open>
                <summary className="text-muted-foreground cursor-default text-xs">角色卡</summary>
                <h3 className="my-3 text-xl font-semibold tracking-tight">
                  {view.draft.name || "尚未命名"}
                </h3>
                <CharacterPreview
                  character={state.draftView ?? view.draft}
                  type={type}
                  types={state.types}
                  references={state.references}
                />
              </details>
            </aside>
          ) : null}
        </div>
      </div>
    </Suspense>
  );
}
