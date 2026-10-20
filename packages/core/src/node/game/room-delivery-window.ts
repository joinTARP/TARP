import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

/** MessagePort 的事件流没有接收端背压，用累计确认限制真正进入传输层的数据。 */
export class RoomDeliveryWindow {
  readonly id = randomUUID();
  private sequence = 0;
  private pending = new Map<number, number>();
  private bytes = 0;
  private wake?: () => void;
  private closed = false;
  constructor(private limits = { count: 64, bytes: 16 * 1024 * 1024, timeoutMs: 15_000 }) {}

  acknowledge(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > this.sequence)
      throw new ORPCError("BAD_REQUEST", { message: "无效的房间同步确认序号" });
    for (const [seq, size] of this.pending) {
      if (seq > sequence) break;
      this.bytes -= size;
      this.pending.delete(seq);
    }
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }

  async reserve(bytes: number, signal?: AbortSignal) {
    if (bytes > this.limits.bytes)
      throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间通知超过发送容量" });
    while (this.pending.size >= this.limits.count || this.bytes + bytes > this.limits.bytes) {
      if (signal?.aborted || this.closed) throw new ORPCError("UNAVAILABLE");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          this.wake = undefined;
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new ORPCError("TIMEOUT", { message: "客户端未及时确认房间状态，请重新同步" }));
        }, this.limits.timeoutMs);
        this.wake = finish;
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted || this.closed) finish();
      });
    }
    if (signal?.aborted || this.closed) throw new ORPCError("UNAVAILABLE");
    const seq = ++this.sequence;
    this.pending.set(seq, bytes);
    this.bytes += bytes;
    return { id: this.id, seq };
  }
}
