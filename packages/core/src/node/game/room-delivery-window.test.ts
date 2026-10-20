import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { RoomDeliveryWindow } from "./room-delivery-window";

test("通知按数量及字节限制发送，累计确认释放额度并拒绝越界确认", async () => {
  const window = new RoomDeliveryWindow({ count: 2, bytes: 100, timeoutMs: 500 });
  const first = await window.reserve(60);
  let delivered = false;
  const waiting = window.reserve(50).then((value) => {
    delivered = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(delivered, false);
  assert.throws(() => window.acknowledge(2), /确认序号/);
  window.acknowledge(first.seq);
  assert.equal((await waiting).seq, 2);
  await window.reserve(10);
  const blocked = window.reserve(1);
  window.acknowledge(3);
  assert.equal((await blocked).seq, 4);
  window.acknowledge(1); // 重复或迟到确认不会产生负额度。
  await assert.rejects(window.reserve(101), /容量/);
});

test("慢客户端超时关闭；取消和房间关闭立即释放等待", async () => {
  const window = new RoomDeliveryWindow({ count: 1, bytes: 100, timeoutMs: 10 });
  await window.reserve(1);
  await assert.rejects(window.reserve(1), /及时确认/);
  const abort = new AbortController();
  const cancelled = window.reserve(1, abort.signal);
  abort.abort();
  await assert.rejects(cancelled);
  const closed = window.reserve(1);
  window.close();
  await assert.rejects(closed);
});

test("默认发送窗口容纳10MiB帧的base64通知", async () => {
  const window = new RoomDeliveryWindow();
  const delivery = await window.reserve(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 1024);
  assert.equal(delivery.seq, 1);
  window.acknowledge(delivery.seq);
  window.close();
});
