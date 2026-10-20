import { useMutation } from "@tanstack/react-query";
import type { SessionActorMetrics, SessionMetrics } from "@tarp/core/shared/session-metrics";
import {
  Activity,
  Bot,
  Braces,
  Database,
  Gauge,
  Wrench,
  Minimize2,
  LoaderCircle,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import { desktopRpc } from "../../desktop-rpc";
import { AgentContextDialog } from "./AgentContextDialog";
import { useRoomReplica, useRoomError } from "./use-room-state";

function formatTokens(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatCost(value: number) {
  return value > 0 ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : "—";
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function Stat({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Gauge;
}) {
  return (
    <article className="border-border/70 bg-card relative overflow-hidden rounded-xl border p-4 shadow-sm">
      <Icon className="text-muted-foreground/45 absolute top-3 right-3 size-8" strokeWidth={1.25} />
      <p className="text-muted-foreground text-[11px] font-medium tracking-[0.08em] uppercase">
        {label}
      </p>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-1 text-xs">{note}</p>
    </article>
  );
}

function UsageBar({
  label,
  value,
  max,
  tone = "bg-foreground",
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
}) {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{formatTokens(value)}</span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className={`${tone} h-full rounded-full transition-[width] duration-500`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

function UsageDetails({
  current,
  totals,
  name,
  action,
  compacting,
}: {
  current?: SessionActorMetrics["current"];
  totals: SessionMetrics["totals"];
  name?: string;
  action?: ReactNode;
  compacting?: boolean;
}) {
  const contextRatio = current?.contextWindow
    ? (current.contextTokens ?? 0) / current.contextWindow
    : 0;
  const cacheBase = totals.input + totals.cacheRead;
  const cacheRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
  const statusLabel = compacting
    ? "正在压缩"
    : current?.status === "running"
      ? "正在生成"
      : current?.status === "idle"
        ? "等待首次调用"
        : "最近一次已结束";
  return (
    <div className="space-y-6">
      {current ? (
        <section className="border-border/70 bg-card relative overflow-hidden rounded-2xl border p-6 shadow-sm">
          <div className="from-muted/80 absolute inset-0 bg-gradient-to-br via-transparent to-transparent" />
          <div className="relative flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-[0.1em] uppercase">
                <Activity
                  className={`size-3.5 ${current?.status === "running" ? "text-emerald-500" : ""}`}
                />
                {name} · 运行状态
              </div>
              <h2 className="mt-3 text-xl font-semibold tracking-tight">上下文与模型用量</h2>
              <p className="text-muted-foreground mt-1.5 text-sm">
                {current?.model ? `${current?.provider} · ${current?.model}` : "尚未产生模型调用"}
              </p>
            </div>
            <span
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${current?.status === "running" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-background text-muted-foreground"}`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="relative mt-7 grid gap-5 border-t pt-5 sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-xs">当前上下文</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {current.contextTokens === null
                  ? "待下次调用更新"
                  : formatTokens(current.contextTokens)}
                {current.contextWindow && current.contextTokens !== null ? (
                  <span className="text-muted-foreground text-sm font-normal">
                    {" "}
                    / {formatTokens(current?.contextWindow)}
                  </span>
                ) : null}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">上下文占用</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {current.contextWindow && current.contextTokens !== null
                  ? percent(contextRatio)
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">最近开始时间</p>
              <p className="mt-1 text-sm font-medium">
                {current?.startedAt
                  ? new Date(current?.startedAt).toLocaleString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      month: "numeric",
                      day: "numeric",
                    })
                  : "—"}
              </p>
            </div>
          </div>
          {current.contextWindow && current.contextTokens !== null ? (
            <div className="bg-muted relative mt-4 h-2 overflow-hidden rounded-full">
              <div
                className="bg-foreground h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.min(contextRatio * 100, 100)}%` }}
              />
            </div>
          ) : null}
          {action}
        </section>
      ) : (
        <section className="border-border/70 bg-card rounded-2xl border p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight">会话总消耗</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            汇总主持人与所有 AI 队友的累计用量，包含已离开的队友。各角色的上下文请在对应视图查看。
          </p>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="累计 Token"
          value={formatTokens(totals.totalTokens)}
          note={`输入 ${formatTokens(totals.input)} · 输出 ${formatTokens(totals.output)}`}
          icon={Braces}
        />
        <Stat
          label="缓存命中率"
          value={cacheBase ? percent(cacheRate) : "—"}
          note={`命中 ${formatTokens(totals.cacheRead)} tokens`}
          icon={Database}
        />
        <Stat
          label="工具调用"
          value={String(totals.toolCalls)}
          note={`完成回合 ${totals.completedAttempts} / ${totals.attempts}`}
          icon={Wrench}
        />
        <Stat
          label="模型费用"
          value={formatCost(totals.cost)}
          note={`推理 ${formatTokens(totals.reasoning)} tokens`}
          icon={Bot}
        />
      </section>

      <section className="border-border/70 bg-card rounded-2xl border p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Gauge className="size-4" />
          <h3 className="text-sm font-semibold">用量构成</h3>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <UsageBar label="输入 token" value={totals.input} max={Math.max(totals.totalTokens, 1)} />
          <UsageBar
            label="输出 token"
            value={totals.output}
            max={Math.max(totals.totalTokens, 1)}
            tone="bg-sky-500"
          />
          <UsageBar
            label="缓存读取"
            value={totals.cacheRead}
            max={Math.max(totals.input + totals.cacheRead, 1)}
            tone="bg-emerald-500"
          />
          <UsageBar
            label="缓存写入"
            value={totals.cacheWrite}
            max={Math.max(totals.input + totals.cacheWrite, 1)}
            tone="bg-amber-500"
          />
        </div>
        <p className="text-muted-foreground mt-6 border-t pt-4 text-xs leading-5">
          {current
            ? "上下文采用最近一次有用量的模型请求，按输入与缓存读取之和显示；压缩后等待下次调用返回新读数。"
            : ""}
          缓存命中率为缓存读取 ÷（输入 + 缓存读取）。仅显示服务商实际返回的用量。
        </p>
      </section>
    </div>
  );
}

function SessionStatusContent({
  metrics,
  roomId,
  active,
}: {
  metrics: SessionMetrics;
  roomId: string;
  active: boolean;
}) {
  const [contextActor, setContextActor] = useState<{ id: string; name: string } | null>(null);
  const compact = useMutation({
    mutationFn: (actorId: string) =>
      desktopRpc.sessions.ai.compact({
        roomId,
        companionId: actorId === "host" ? undefined : actorId,
      }),
  });
  const compactingActorId =
    metrics.compactingActorId ?? (compact.isPending ? compact.variables : undefined);
  const running = [metrics.host, ...metrics.companions].some(
    (actor) => actor.current.status === "running",
  );
  const action = (actor: SessionActorMetrics) => {
    const pending = compactingActorId === actor.id;
    const selected = compact.variables === actor.id;
    return (
      <div className="relative mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="text-muted-foreground flex-1 text-xs leading-5">
          {selected && compact.error ? (
            <p role="alert" className="text-destructive">
              {compact.error.message}
            </p>
          ) : selected && compact.isSuccess ? (
            <p role="status">
              压缩完成，已保存游戏记忆。
              {actor.current.contextTokens === null ? "上下文用量将在下次模型调用后更新。" : ""}
            </p>
          ) : (
            <p role={pending ? "status" : undefined}>
              {pending
                ? "正在整理游戏记忆，请稍候…"
                : !active
                  ? "冒险已结束，重新开启后可压缩。"
                  : running
                    ? "请等待当前生成结束后再压缩。"
                    : "将较早对话整理为游戏记忆，保留最近互动和历史聊天。"}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setContextActor(actor)}>
          <Braces className="size-3.5" />
          查看上下文
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!active || running || Boolean(compactingActorId) || actor.totals.attempts === 0}
          onClick={() => compact.mutate(actor.id)}
        >
          {pending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Minimize2 className="size-3.5" />
          )}
          {pending ? "正在压缩…" : "手动压缩"}
        </Button>
      </div>
    );
  };
  return (
    <div className="space-y-6">
      {contextActor ? (
        <AgentContextDialog
          key={contextActor.id}
          roomId={roomId}
          actor={contextActor}
          onClose={() => setContextActor(null)}
        />
      ) : null}
      <Tabs defaultValue="host" className="gap-6">
        <TabsList aria-label="统计视图" className="w-full sm:w-fit">
          <TabsTrigger value="host" className="px-4">
            主持人
          </TabsTrigger>
          <TabsTrigger value="companions" className="px-4">
            AI 队友
          </TabsTrigger>
          <TabsTrigger value="total" className="px-4">
            总消耗
          </TabsTrigger>
        </TabsList>
        <TabsContent value="host">
          <UsageDetails
            {...metrics.host}
            action={action(metrics.host)}
            compacting={compactingActorId === "host"}
          />
        </TabsContent>
        <TabsContent value="companions">
          {metrics.companions.length ? (
            <Tabs
              key={metrics.companions.map((companion) => companion.id).join(",")}
              defaultValue={metrics.companions[0]!.id}
              className="gap-5"
            >
              <TabsList
                aria-label="选择 AI 队友"
                variant="line"
                className="h-auto! max-w-full flex-wrap justify-start gap-2"
              >
                {metrics.companions.map((companion) => (
                  <TabsTrigger key={companion.id} value={companion.id} className="px-3 py-2">
                    {companion.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {metrics.companions.map((companion) => (
                <TabsContent key={companion.id} value={companion.id}>
                  <UsageDetails
                    {...companion}
                    action={action(companion)}
                    compacting={compactingActorId === companion.id}
                  />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <section className="rounded-2xl border p-6">
              <p className="text-muted-foreground text-sm">
                尚无 AI 队友，添加队友后可在这里查看上下文与用量。
              </p>
            </section>
          )}
        </TabsContent>
        <TabsContent value="total">
          <UsageDetails totals={metrics.totals} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function SessionStatus({ roomId }: { roomId: string }) {
  const replica = useRoomReplica(roomId);
  const error = useRoomError(roomId);
  const metrics = { data: replica?.sections.metrics, isPending: !replica && !error, error };
  if (metrics.isPending)
    return (
      <p role="status" className="text-muted-foreground py-4 text-sm">
        正在读取会话状态…
      </p>
    );
  if (metrics.error)
    return (
      <p role="alert" className="text-destructive py-4 text-sm">
        无法读取会话状态：{metrics.error.message}
      </p>
    );
  return metrics.data ? (
    <SessionStatusContent
      key={roomId}
      metrics={metrics.data}
      roomId={roomId}
      active={replica?.sections.room.status === "active"}
    />
  ) : null;
}
