import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { TtsChunk } from "../../shared/tts";
import { SharedTtsJobs } from "./shared-jobs";

const chunk: TtsChunk = { type: "pcm", data: "AAA=", sampleRate: 24000, channels: 1 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("相同任务复用上游，迟到订阅者从头读取，单人停止不影响其他听众", async () => {
  const hub = new SharedTtsJobs();
  const gate = deferred();
  let calls = 0;
  let upstream!: AbortSignal;
  async function* produce(signal: AbortSignal) {
    calls++;
    upstream = signal;
    yield chunk;
    await gate.promise;
    signal.throwIfAborted();
    yield chunk;
  }
  const controller = new AbortController();
  const a = hub.subscribe("same", produce, controller.signal);
  const b = hub.subscribe("same", produce);
  assert.deepEqual((await a.next()).value, chunk);
  assert.deepEqual((await b.next()).value, chunk);
  controller.abort();
  assert.equal(upstream.aborted, false);
  await assert.rejects(a.next());
  gate.resolve();
  assert.deepEqual((await b.next()).value, chunk);
  assert.equal((await b.next()).done, true);
  assert.equal(calls, 1);
});

test("最后订阅者停止才取消上游，旧任务结束不会删除同键的新任务", async () => {
  const hub = new SharedTtsJobs();
  const gate = deferred();
  let upstream!: AbortSignal;
  async function* produce(signal: AbortSignal) {
    upstream = signal;
    yield chunk;
    await gate.promise;
    signal.throwIfAborted();
  }
  const a = hub.subscribe("same", produce);
  await a.next();
  await a.return(undefined);
  assert.equal(upstream.aborted, true);
  let calls = 0;
  const newGate = deferred();
  async function* replacement() {
    calls++;
    yield chunk;
    await newGate.promise;
  }
  const b = hub.subscribe("same", replacement);
  await b.next();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const c = hub.subscribe("same", replacement);
  await c.next();
  assert.equal(calls, 1);
  newGate.resolve();
  await b.return(undefined);
  await c.return(undefined);
});

test("不同任务遵守并发与容量限制；取消排队任务不占用上游", async () => {
  const hub = new SharedTtsJobs(1, 2);
  const gate = deferred();
  const calls: string[] = [];
  const produce = (name: string) =>
    async function* () {
      calls.push(name);
      yield chunk;
      await gate.promise;
    };
  const a = hub.subscribe("a", produce("a"));
  await a.next();
  const controller = new AbortController();
  const b = hub.subscribe("b", produce("b"), controller.signal);
  const next = b.next();
  await assert.rejects(hub.subscribe("c", produce("c")).next(), /任务较多/);
  controller.abort();
  await assert.rejects(next);
  assert.deepEqual(calls, ["a"]);
  gate.resolve();
  await a.return(undefined);
  const c = hub.subscribe("c", produce("c"));
  await c.next();
  await c.return(undefined);
  assert.deepEqual(calls, ["a", "c"]);
});
