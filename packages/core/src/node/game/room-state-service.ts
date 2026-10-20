import { ORPCError } from "@orpc/server";

import type { ChatEvent, RoomNotification } from "../../shared/game";
import {
  ROOM_PROTOCOL_VERSION,
  type RoomBaseline,
  type RoomProjection,
} from "../../shared/room-state";
import { onRoomChanged, roomGeneration } from "../sessions/room-changes";
import { RoomDeliveryWindow } from "./room-delivery-window";
import { RoomStateEncoder } from "./room-state-encoder";

/** 按消费速度编码最新状态；最多持有一帧和一个有界聊天批次，不排队无限 patch。 */
export async function* subscribeRoomState(
  options: {
    directory: string;
    protocolVersion: number;
    baseline: RoomBaseline;
    afterChatCursor: number;
    project: () => Promise<RoomProjection>;
    chat: (cursor: number, limit: number) => ChatEvent[];
    closed: () => boolean;
    delivery: RoomDeliveryWindow;
  },
  signal?: AbortSignal,
): AsyncGenerator<RoomNotification> {
  if (options.protocolVersion !== ROOM_PROTOCOL_VERSION)
    throw new ORPCError("BAD_REQUEST", { message: "房间同步协议版本不兼容，请更新客户端" });
  const encoder = new RoomStateEncoder(options.baseline);
  let cursor = options.afterChatCursor;
  let generation = -1;
  let wake: (() => void) | undefined;
  const changed = () => wake?.();
  const off = onRoomChanged(options.directory, changed);
  signal?.addEventListener("abort", changed);
  try {
    while (!signal?.aborted && !options.closed()) {
      // 先登记等待再观察版本；变化发生在 await/yield 中时下轮不会丢失。
      const waiting = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const latest = roomGeneration(options.directory);
      if (latest !== generation) {
        const replica = await options.project();
        if (signal?.aborted || options.closed()) return;
        const frame = encoder.update(replica);
        generation = latest;
        if (frame) {
          const delivery = await options.delivery.reserve(
            Buffer.byteLength(JSON.stringify(frame)) + 128,
            signal,
          );
          yield { type: "state", frame, delivery };
        }
      }
      if (signal?.aborted || options.closed()) return;
      const events = options.chat(cursor, 32);
      for (const event of events) {
        if (signal?.aborted || options.closed()) return;
        const delivery = await options.delivery.reserve(
          Buffer.byteLength(JSON.stringify(event)) + 128,
          signal,
        );
        yield { type: "chat", event, delivery };
        cursor = event.cursor;
      }
      if (events.length || generation !== roomGeneration(options.directory)) continue;
      await waiting;
    }
  } finally {
    off();
    signal?.removeEventListener("abort", changed);
  }
}
