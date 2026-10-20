import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { PcmDecoder } from "./stream-player";

test("PCM16LE 解码在任意字节边界保留立体声帧并检查残缺尾帧", () => {
  const decoder = new PcmDecoder();
  assert.equal(decoder.decode(Buffer.from([0]).toString("base64"), 2)[0]!.length, 0);
  const frames = decoder.decode(Buffer.from([128, 255, 127, 0, 64, 0, 192]).toString("base64"), 2);
  assert.deepEqual([...frames[0]!], [-1, 0.5]);
  assert.deepEqual([...frames[1]!], [32767 / 32768, -0.5]);
  decoder.finish();
  decoder.decode("AA==", 1);
  assert.throws(() => decoder.finish(), /不完整/);
});

test("首块在上游结束前开始播放，取消释放节点，下一次播放复用音频上下文", async () => {
  const { playStream } = await import("./stream-player");
  const original = globalThis.AudioContext;
  const nodes: {
    onended: (() => void) | null;
    stopped: boolean;
    disconnected: boolean;
    started: boolean;
  }[] = [];
  let contexts = 0;
  class FakeContext {
    currentTime = 0;
    destination = {};
    constructor() {
      contexts++;
    }
    async resume() {}
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, copyToChannel() {} };
    }
    createBufferSource() {
      const node = {
        onended: null as (() => void) | null,
        stopped: false,
        disconnected: false,
        started: false,
        connect() {},
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      nodes.push(node);
      return node;
    }
  }
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const pcm = { type: "pcm" as const, data: "AAAAAA==", sampleRate: 24000, channels: 1 as const };
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let playing = 0;
  try {
    const first = playStream(
      async () =>
        (async function* () {
          yield pcm;
          await gate;
          yield pcm;
        })(),
      controller.signal,
      () => {
        playing++;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.started, true);
    assert.equal(playing, 1);
    controller.abort();
    assert.equal(nodes[0]!.stopped, true);
    assert.equal(nodes[0]!.disconnected, true);
    release();
    await assert.rejects(first);
    const next = playStream(
      async () =>
        (async function* () {
          yield pcm;
        })(),
      new AbortController().signal,
      () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    nodes[1]!.onended!();
    await next;
    assert.equal(contexts, 1);
  } finally {
    globalThis.AudioContext = original;
    release();
  }
});
