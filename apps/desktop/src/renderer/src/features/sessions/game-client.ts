import type { ContractRouterClient } from "@orpc/contract";
import type { gameContract, ChatMessage } from "@tarp/core/shared/game";

export type GameClient = ContractRouterClient<typeof gameContract>;

/** 合并历史快照或增量还原的消息，避免旧版本覆盖新内容并保留未变化的对象。 */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const messages = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    if (!previous || previous.revision <= message.revision) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

function stockOrpcMessage(code: string) {
  return code
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

const stockOrpcMessages = new Set(
  [
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "PRECONDITION_FAILED",
    "TIMEOUT",
    "TOO_MANY_REQUESTS",
    "PAYLOAD_TOO_LARGE",
    "INTERNAL_SERVER_ERROR",
  ].map(stockOrpcMessage),
);

function readableMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message.trim();
  return "";
}

/** 业务错误原样展示。oRPC 吞掉原因后的英文状态名不直接贴给玩家。 */
export function errorMessage(error: unknown): string {
  const message = readableMessage(error);
  if (!message || stockOrpcMessages.has(message)) return "操作没有完成，请再试一次。";
  return message;
}

export function reconnectDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
