import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import type { ChatEvent } from "../../../shared/game";
import type { SessionDatabase } from "../../storage/session-database";

type WithoutCursor<T> = T extends unknown ? Omit<T, "cursor"> : never;
export type ChatChange = WithoutCursor<ChatEvent>;

/** 当前数据库连接的短期通知；完整消息仍由 SQLite 保存。 */
export class ChatEvents {
  readonly streamId = randomUUID();
  cursor = 0;
  private bytes = 0;
  private events: { event: ChatEvent; bytes: number }[] = [];
  private listeners = new Set<(messageId: string) => void>();

  publish(changes: readonly ChatChange[]) {
    for (const change of changes) {
      const serialized = JSON.stringify({ ...change, cursor: ++this.cursor });
      const event: ChatEvent = JSON.parse(serialized);
      const bytes = Buffer.byteLength(serialized);
      this.events.push({ event, bytes });
      this.bytes += bytes;
      while (this.events.length > 1024 || this.bytes > 8 * 1024 * 1024)
        this.bytes -= this.events.shift()!.bytes;
      const id =
        event.type === "message"
          ? event.message.id
          : event.type === "agent"
            ? event.messageId
            : undefined;
      if (id) for (const listener of this.listeners) listener(id);
    }
  }

  after(streamId: string, cursor: number, limit: number): ChatEvent[] {
    const oldest = this.events[0]?.event.cursor ?? this.cursor + 1;
    if (streamId !== this.streamId || cursor < oldest - 1 || cursor > this.cursor)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "聊天通知已过期，请重新读取消息快照",
        data: { reason: "CHAT_RESYNC_REQUIRED" },
      });
    return this.events
      .filter(({ event }) => event.cursor > cursor)
      .slice(0, limit)
      .map(({ event }) => event);
  }

  onMessage(listener: (messageId: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const rooms = new WeakMap<SessionDatabase, ChatEvents>();
export function chatEvents(db: SessionDatabase) {
  let events = rooms.get(db);
  if (!events) rooms.set(db, (events = new ChatEvents()));
  return events;
}
