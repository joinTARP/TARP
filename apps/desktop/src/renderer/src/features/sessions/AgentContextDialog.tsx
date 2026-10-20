import { useMutation, useQuery } from "@tanstack/react-query";
import type { AgentContext } from "@tarp/core/shared/agent-context";
import { Copy, RefreshCw } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopRpc } from "../../desktop-rpc";

export function contextText(context: AgentContext) {
  return context.groups
    .map(
      (group, index) =>
        `## ${index + 1}. ${group.title}\n\n${group.blocks.map((block) => `### ${block.title}\n\n${block.text}`).join("\n\n")}`,
    )
    .join("\n\n");
}

export function AgentContextContents({ context }: { context: AgentContext }) {
  return context.groups.length ? (
    <div className="space-y-6">
      {context.groups.map((group, index) => (
        <section key={index} aria-label={`${index + 1}. ${group.title}`} className="space-y-3">
          <h3 className="text-sm font-semibold">
            <span className="text-muted-foreground mr-2 font-mono text-xs">
              {String(index + 1).padStart(2, "0")}
            </span>
            {group.title}
          </h3>
          <div className="divide-border overflow-hidden rounded-xl border">
            {group.blocks.map((block, blockIndex) => (
              <details
                key={blockIndex}
                open={block.kind !== "tool" && block.kind !== "thinking"}
                className="border-b last:border-b-0"
              >
                <summary className="bg-muted/40 cursor-pointer px-4 py-2.5 text-xs font-medium">
                  {block.title}
                </summary>
                {block.imageUrl ? (
                  <img
                    src={block.imageUrl}
                    alt={block.text}
                    className="max-h-96 max-w-full object-contain p-4"
                  />
                ) : (
                  <pre className="m-0 p-4 font-mono text-xs leading-6 wrap-anywhere whitespace-pre-wrap">
                    {block.text}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  ) : (
    <p role="status" className="text-muted-foreground py-10 text-center text-sm">
      该角色尚无上下文记录。
    </p>
  );
}

export function AgentContextDialog({
  roomId,
  actor,
  onClose,
}: {
  roomId: string;
  actor: { id: string; name: string };
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["agent-context", roomId, actor.id],
    queryFn: () =>
      desktopRpc.sessions.ai.context({
        roomId,
        companionId: actor.id === "host" ? undefined : actor.id,
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const copy = useMutation({
    mutationFn: async () => {
      if (query.data) await navigator.clipboard.writeText(contextText(query.data));
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <div className="space-y-2 border-b p-6 pr-14">
          <DialogTitle>{actor.name} · 当前上下文</DialogTitle>
          <DialogDescription>
            按上下文注入顺序分组，展示已记录的有效内容；最终发送形式与 token 消耗由 Pi
            和模型接口决定。
          </DialogDescription>
          <p className="text-muted-foreground text-xs">
            待处理消息尚未计入。生成中可刷新查看已记录内容。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-6 py-3">
          <p className="text-muted-foreground text-xs" role="status">
            {query.isFetching
              ? "正在读取上下文…"
              : query.data
                ? `读取于 ${new Date(query.data.readAt).toLocaleTimeString("zh-CN")}`
                : "尚未读取"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => {
                copy.reset();
                void query.refetch();
              }}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : ""} />
              刷新
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!query.data?.groups.length || copy.isPending}
              onClick={() => copy.mutate()}
            >
              <Copy />
              {copy.isSuccess ? "已复制" : "复制全部"}
            </Button>
          </div>
        </div>
        <ScrollAreaPane className="min-h-0 flex-1" viewportClassName="p-6 overscroll-contain">
          {query.error ? (
            <p role="alert" className="text-destructive mb-4 text-sm">
              读取失败：{query.error.message}，请点击刷新重试。
            </p>
          ) : null}
          {copy.error ? (
            <p role="alert" className="text-destructive mb-4 text-sm">
              复制失败：{copy.error.message}
            </p>
          ) : null}
          {query.data ? <AgentContextContents context={query.data} /> : null}
        </ScrollAreaPane>
      </DialogContent>
    </Dialog>
  );
}
