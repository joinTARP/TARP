import { ORPCError } from "@orpc/server";

import { applyAgentParts } from "../../../shared/agent-message";
import { messageSchema } from "../../../shared/game";
import type { ChatMessage, PublicAgentEvent, SubmissionModeSnapshot } from "../../../shared/game";
import {
  beginAdventureEdit,
  commitAdventureEdit,
  discardAdventureEdit,
} from "../../sessions/adventure-state";
import { chatField } from "../../storage/session-database";
import { chatEvents, type ChatChange } from "./events";
import type { RoomState } from "./types";

export interface SubmissionRequest {
  playerId: string;
  operation: "send" | "continue";
  requestId: string;
  fingerprint: string;
}

/** 聊天消息版本和事务通知的唯一写入入口。 */
export class ChatStore {
  private pending = new WeakMap<RoomState, ChatChange[]>();

  transaction<T>(state: RoomState, fn: () => T, onCommitted?: (result: T) => void): T {
    state.db.sqlite.exec("BEGIN IMMEDIATE");
    let result: T;
    const pending: ChatChange[] = [];
    this.pending.set(state, pending);
    try {
      beginAdventureEdit(state.db);
      result = fn();
      state.db.sqlite.exec("COMMIT");
      this.pending.delete(state);
      onCommitted?.(result);
      chatEvents(state.db).publish(pending);
      commitAdventureEdit(state.db);
    } catch (error) {
      this.pending.delete(state);
      discardAdventureEdit(state.db);
      if (state.db.sqlite.inTransaction) state.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    state.events.emit("change");
    return result;
  }
  event(state: RoomState, change: ChatChange) {
    const pending = this.pending.get(state);
    if (!pending) throw new Error("聊天通知必须在写事务中暂存");
    pending.push(JSON.parse(JSON.stringify(change)));
  }
  /** 设置文件已原子落盘；仅发布配置通知，不开启空的数据库事务。 */
  publishSubmissionMode(state: RoomState, snapshot: SubmissionModeSnapshot) {
    chatEvents(state.db).publish([{ type: "mode", snapshot }]);
    state.events.emit("change");
  }
  submissionResult(state: RoomState, request: SubmissionRequest): ChatMessage | undefined {
    const saved = state.db.get(
      state.db.query
        .selectFrom("chat_requests")
        .selectAll()
        .where("player_id", "=", request.playerId)
        .where("operation", "=", request.operation)
        .where("request_id", "=", request.requestId),
    );
    if (!saved) return;
    if (saved.fingerprint !== request.fingerprint)
      throw new ORPCError("CONFLICT", { message: "重复请求的内容不同" });
    return this.message(state, saved.message_id);
  }
  saveSubmission(state: RoomState, request: SubmissionRequest, messageId: string) {
    if (!this.pending.has(state)) throw new Error("提交请求必须与消息一起保存");
    state.db.run(
      state.db.query.insertInto("chat_requests").values({
        player_id: request.playerId,
        operation: request.operation,
        request_id: request.requestId,
        fingerprint: request.fingerprint,
        message_id: messageId,
      }),
    );
  }
  save(state: RoomState, message: ChatMessage): ChatMessage {
    if (message.kind === "assistant" && message.inputBatch)
      message = {
        ...message,
        inputBatch: { id: message.inputBatch.id, state: message.inputBatch.state },
      };
    if (!message.sequence) {
      const result = state.db.run(
        state.db.query.insertInto("chat_messages").values({ id: message.id, data: "{}" }),
      );
      message = { ...message, sequence: Number(result.lastInsertRowid) };
    }
    message = { ...message, revision: message.revision + 1 };
    const data = JSON.stringify(message);
    state.db.run(
      state.db.query.updateTable("chat_messages").set({ data }).where("id", "=", message.id),
    );
    this.event(state, { type: "message", message });
    return message;
  }
  message(state: RoomState, id: string): ChatMessage {
    const row = state.db.get(
      state.db.query.selectFrom("chat_messages").select("data").where("id", "=", id),
    );
    if (!row) throw new ORPCError("NOT_FOUND", { message: "消息不存在" });
    return messageSchema.parse(JSON.parse(String(row.data)));
  }

  runningMessages(state: RoomState, kind: "assistant" | "dice") {
    return state.db
      .all(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("kind"), "=", kind)
          .where(chatField("status"), "=", "running"),
      )
      .map((row) => messageSchema.parse(JSON.parse(String(row.data))));
  }
  queuedMessages(state: RoomState): ChatMessage[] {
    return state.db
      .all(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("status"), "=", "queued")
          .orderBy("sequence", "asc"),
      )
      .map((row) => messageSchema.parse(JSON.parse(String(row.data))));
  }
  firstQueuedMessage(state: RoomState) {
    const row = state.db.get(
      state.db.query
        .selectFrom("chat_messages")
        .select("data")
        .where(chatField("kind"), "=", "assistant")
        .where(chatField("status"), "=", "queued")
        .orderBy("sequence", "asc")
        .limit(1),
    );
    return row ? messageSchema.parse(JSON.parse(String(row.data))) : undefined;
  }

  appendAgentEvents(
    state: RoomState,
    message: Extract<ChatMessage, { kind: "assistant" }>,
    events: PublicAgentEvent[],
  ) {
    const next = {
      ...message,
      revision: message.revision + 1,
      agentMessages: applyAgentParts(message.agentMessages, events),
    };
    this.transaction(state, () => {
      state.db.run(
        state.db.query
          .updateTable("chat_messages")
          .set({ data: JSON.stringify(next) })
          .where("id", "=", next.id),
      );
      this.event(state, {
        type: "agent",
        messageId: next.id,
        attemptId: next.attemptId!,
        revision: next.revision,
        events,
      });
    });
    return next;
  }

  history(state: RoomState, beforeSequence: number | undefined, limit: number) {
    const rows = state.db.all(
      state.db.query
        .selectFrom("chat_messages")
        .select("data")
        .where("sequence", "<", beforeSequence ?? Number.MAX_SAFE_INTEGER)
        .orderBy("sequence", "desc")
        .limit(limit + 1),
    );
    return {
      messages: rows
        .slice(0, limit)
        .map((row) => messageSchema.parse(JSON.parse(String(row.data))))
        .reverse(),
      cursor: chatEvents(state.db).cursor,
      streamId: chatEvents(state.db).streamId,
      hasMore: rows.length > limit,
    };
  }

  eventsAfter(state: RoomState, streamId: string, cursor: number, limit: number) {
    return chatEvents(state.db).after(streamId, cursor, limit);
  }
}
