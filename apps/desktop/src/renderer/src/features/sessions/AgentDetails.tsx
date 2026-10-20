import { useQuery } from "@tanstack/react-query";
import type { ChatMessage } from "@tarp/core/shared/game";
import { ChevronRight, Brain, Wrench } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopRpc } from "../../desktop-rpc";

export function AgentDetails({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const running = message.status === "running";
  const details = useQuery({
    // 结束状态重新读取 Pi 会话，补齐最后一批事件。
    queryKey: ["agent-details", message.roomId, message.id, message.status],
    queryFn: () => desktopRpc.sessions.details({ roomId: message.roomId, messageId: message.id }),
    enabled: message.kind === "assistant" && Boolean(message.attemptId),
    staleTime: running ? 0 : Infinity,
    // 状态切换时保留已读取的详情，避免结束生成时入口闪烁。
    placeholderData: (previous) => previous,
    refetchInterval: running ? 700 : false,
  });
  const entries = details.data?.filter((detail) => detail.text.trim());
  // 先读取记录再决定是否呈现；空推理块和旧记录不显示入口或占位说明。
  if (!entries?.length) return null;
  return (
    <details
      className="group/details text-muted-foreground mb-3 max-w-full min-w-0 text-xs"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="focus-visible:outline-ring flex w-fit cursor-default list-none items-center gap-1.5 rounded py-1.5 focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/details:rotate-90 motion-reduce:transition-none" />
        <span>推理与执行细节</span>
      </summary>
      <ScrollAreaPane
        className="border-border mt-2 max-h-72 w-full max-w-full border-l"
        viewportClassName="max-h-72 overscroll-contain pr-3 pb-1 pl-4"
        viewportProps={{ style: { overflowX: "hidden" } }}
        contentClassName="w-full min-w-0! max-w-full space-y-4 [overflow-wrap:anywhere]"
        scrollbarVisibility="interaction"
      >
        {details.error ? (
          <p role="alert">
            无法读取细节。
            <Button size="sm" variant="ghost" onClick={() => void details.refetch()}>
              重试
            </Button>
          </p>
        ) : null}
        {entries.map((detail) => (
          <div key={detail.id} className="max-w-full min-w-0">
            <div className="flex min-w-0 items-start gap-2 text-[11px]">
              {detail.kind === "thinking" ? (
                <Brain className="size-3.5 shrink-0" />
              ) : (
                <Wrench className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0">
                {detail.kind === "thinking" ? "模型推理" : detail.text}
              </span>
              <span
                className={`shrink-0 ${detail.status === "failed" ? "text-destructive" : "opacity-70"}`}
              >
                {detail.status === "running"
                  ? running
                    ? "进行中"
                    : "已结束"
                  : detail.status === "failed"
                    ? "未完成"
                    : "已完成"}
              </span>
            </div>
            {detail.kind === "thinking" && detail.text ? (
              <p className="mt-2 text-xs leading-6 whitespace-pre-wrap">{detail.text}</p>
            ) : null}
            {detail.kind === "tool" && detail.arguments ? (
              <ToolText label="参数">{detail.arguments}</ToolText>
            ) : null}
            {detail.kind === "tool" && detail.result ? (
              <ToolText label="返回">{detail.result}</ToolText>
            ) : null}
            {detail.kind === "tool" && detail.error ? (
              <p
                role="alert"
                className="text-destructive mt-2 text-xs leading-6 whitespace-pre-wrap"
              >
                {detail.error}
              </p>
            ) : null}
          </div>
        ))}
      </ScrollAreaPane>
    </details>
  );
}

function ToolText({ label, children }: { label: string; children: string }) {
  return (
    <div className="mt-2 max-w-full min-w-0">
      <p className="text-[11px] opacity-70">{label}</p>
      <pre className="bg-muted mt-1 max-w-full rounded-md p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}
