import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import { hostInputBatchSchema, messageSchema, type ChatMessage } from "../../../shared/game";
import {
  inputReceiptSchema,
  type HostInputBatch,
  type ReceivedInput,
} from "../../agent/input-batch";
import type { PiHistory } from "../../agent/pi-history";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { chatField } from "../../storage/session-database";
import { playerTurnPrompt, type PlayerTurn } from "../player-turn";
import type { ChatStore } from "./store";
import type { RoomState } from "./types";

type Assistant = Extract<ChatMessage, { kind: "assistant" }>;

/** 批次快照在内部表保存并关联主持消息；接收依据 Pi 落盘回执，不以运行完成作为接收条件。 */
export class ChatInputBatches {
  constructor(
    private readonly store: ChatStore,
    private readonly history?: PiHistory,
  ) {}

  prepared(state: RoomState): Assistant[] {
    return state.db
      .all(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("inputBatch.state"), "=", "prepared")
          .orderBy("sequence", "asc"),
      )
      .map((row) => messageSchema.parse(JSON.parse(row.data)))
      .filter((message): message is Assistant => message.kind === "assistant");
  }
  assertResolved(state: RoomState) {
    if (this.prepared(state).length)
      throw new ORPCError("CONFLICT", {
        message: "有尚未送达主持的行动，请房主先重试或放弃该批次；期间可以仅聊天。",
      });
  }
  isPreparedSource(state: RoomState, messageId: string) {
    return this.prepared(state).some((message) =>
      this.get(state, message.inputBatch!.id).sourceIds.includes(messageId),
    );
  }
  create(sourceIds: string[], turns: PlayerTurn[]): HostInputBatch {
    return { id: randomUUID(), state: "prepared", sourceIds, turns };
  }
  save(state: RoomState, messageId: string, batch: HostInputBatch) {
    // 新能力的内部存储按首次提交初始化，不扫描或转换旧会话。
    state.db.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS chat_input_batches (id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)",
    );
    state.db.run(
      state.db.query
        .insertInto("chat_input_batches")
        .values({ id: batch.id, message_id: messageId, data: JSON.stringify(batch) }),
    );
  }
  get(state: RoomState, id: string): HostInputBatch {
    const row = state.db.get(
      state.db.query.selectFrom("chat_input_batches").select("data").where("id", "=", id),
    );
    if (!row) throw new Error("主持输入批次记录缺失");
    return hostInputBatchSchema.parse(JSON.parse(row.data));
  }
  prompt(batch: HostInputBatch) {
    return playerTurnPrompt(batch.turns);
  }

  receive(state: RoomState, receipt: ReceivedInput) {
    const message = this.store.message(state, receipt.messageId);
    if (message.kind !== "assistant" || message.inputBatch?.id !== receipt.batchId)
      throw new Error("主持输入接收批次不匹配");
    if (message.inputBatch.state === "received") return;
    if (message.inputBatch.state !== "prepared") throw new Error("批次已放弃，不能接收");
    this.store.transaction(state, () => {
      this.consume(state, this.get(state, message.inputBatch!.id), "received");
      this.store.save(state, {
        ...message,
        inputBatch: { ...message.inputBatch!, state: "received" },
        pi: receipt.reference,
      });
    });
  }
  /** 非 Pi 宿主没有原生回执时，仅在成功返回后确认；失败仍保留原批次。 */
  complete(state: RoomState, messageId: string) {
    const message = this.store.message(state, messageId);
    if (message.kind !== "assistant" || message.inputBatch?.state !== "prepared") return;
    this.store.transaction(state, () => {
      this.consume(state, this.get(state, message.inputBatch!.id), "received");
      this.store.save(state, {
        ...message,
        inputBatch: { ...message.inputBatch!, state: "received" },
      });
    });
  }
  private consume(state: RoomState, batch: HostInputBatch, status: "received" | "abandoned") {
    state.db.run(
      state.db.query
        .updateTable("chat_input_batches")
        .set({ data: JSON.stringify({ ...batch, state: status }) })
        .where("id", "=", batch.id),
    );
    for (const id of batch.sourceIds) {
      const source = this.store.message(state, id);
      if (!source.pendingAgent && (source.kind !== "assistant" || !source.pendingAction)) continue;
      this.store.save(
        state,
        source.kind === "assistant"
          ? { ...source, pendingAgent: undefined, pendingAction: undefined }
          : { ...source, pendingAgent: undefined },
      );
    }
  }
  abandon(state: RoomState, message: Assistant): ChatMessage {
    if (message.inputBatch?.state === "abandoned") return message;
    if (message.inputBatch?.state !== "prepared")
      throw new ORPCError("CONFLICT", { message: "该批次已送达，不能放弃或重送" });
    return this.store.transaction(state, () => {
      this.consume(state, this.get(state, message.inputBatch!.id), "abandoned");
      return this.store.save(state, {
        ...message,
        status: "cancelled",
        error: "未送达的行动已放弃。",
        inputBatch: { ...message.inputBatch!, state: "abandoned" },
      });
    });
  }
  async recover(state: RoomState) {
    const prepared = this.prepared(state);
    if (!prepared.length || !this.history) return;
    const receipts = await this.history.inputBatches(roomDirectoryForDatabase(state.db));
    for (const receipt of receipts) {
      inputReceiptSchema.parse(receipt);
      if (
        prepared.some(
          (message) =>
            message.id === receipt.messageId && message.inputBatch?.id === receipt.batchId,
        )
      )
        this.receive(state, receipt);
    }
  }
}
