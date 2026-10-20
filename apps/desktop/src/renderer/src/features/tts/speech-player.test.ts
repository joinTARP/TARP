import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { TtsAudio } from "@shared/tts";

import { SpeechPlayer } from "./speech-player";

const audio: TtsAudio = { data: "test", mimeType: "audio/wav" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("自动消息顺序播放，重复入队只播放一次", async () => {
  const requested: string[] = [];
  const played: string[] = [];
  const releases: (() => void)[] = [];
  const player = new SpeechPlayer({
    async synthesize(text) {
      requested.push(text);
      return { ...audio, data: text };
    },
    play: (value) => {
      played.push(value.data);
      return new Promise((resolve) => releases.push(resolve));
    },
  });
  player.enqueue({ owner: "room", key: "1", text: "第一句" });
  player.enqueue({ owner: "room", key: "2", text: "第二句" });
  player.enqueue({ owner: "room", key: "2", text: "第二句" });
  await tick();
  assert.deepEqual(requested, ["第一句", "第二句"]);
  assert.deepEqual(played, ["第一句"]);
  releases.shift()!();
  await tick();
  assert.deepEqual(requested, ["第一句", "第二句"]);
  assert.deepEqual(played, ["第一句", "第二句"]);
  releases.shift()!();
  await tick();
  assert.equal(player.getSnapshot().status, "idle");
});

test("当前消息流式播放时预先合成下一条，结束后直接播放预取音频", async () => {
  const streamed: string[] = [];
  const synthesized: string[] = [];
  const played: string[] = [];
  let finishStream!: () => void;
  const player = new SpeechPlayer({
    streamPlay: (text, _speaker, _preview, _signal, onPlaying) => {
      streamed.push(text);
      onPlaying();
      return new Promise((resolve) => {
        finishStream = resolve;
      });
    },
    async synthesize(text) {
      synthesized.push(text);
      return { ...audio, data: text };
    },
    async play(value) {
      played.push(value.data);
    },
  });
  player.enqueue({ owner: "room", key: "1", text: "当前消息" });
  player.enqueue({ owner: "room", key: "2", text: "下一条消息" });
  await tick();
  assert.deepEqual(streamed, ["当前消息"]);
  assert.deepEqual(synthesized, ["下一条消息"]);
  assert.deepEqual(played, []);
  finishStream();
  await tick();
  assert.deepEqual(streamed, ["当前消息"]);
  assert.deepEqual(played, ["下一条消息"]);
  assert.equal(player.getSnapshot().status, "idle");
});

test("停止播放会同时取消下一条的预取合成", async () => {
  let nextSignal!: AbortSignal;
  let finishNext!: (value: TtsAudio) => void;
  const player = new SpeechPlayer({
    synthesize(text, _speaker, _preview, signal) {
      if (text === "下一条") {
        nextSignal = signal;
        return new Promise((resolve) => {
          finishNext = resolve;
        });
      }
      return Promise.resolve(audio);
    },
    play: (_audio, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
  });
  player.enqueue({ owner: "room", key: "1", text: "当前" });
  player.enqueue({ owner: "room", key: "2", text: "下一条" });
  await tick();
  player.stop("room");
  assert.equal(nextSignal.aborted, true);
  finishNext(audio);
  await tick();
  assert.equal(player.getSnapshot().status, "idle");
  assert.equal(player.getSnapshot().queued, 0);
});

test("停止清空队列，迟到的合成不会播放或覆盖新的试听状态", async () => {
  let finishOld!: (audio: TtsAudio) => void;
  let oldSignal!: AbortSignal;
  let playing = 0;
  const player = new SpeechPlayer({
    synthesize(text, _speaker, _preview, signal) {
      if (text === "旧消息") {
        oldSignal = signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      }
      return Promise.resolve(audio);
    },
    play: (_, signal) => {
      playing++;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  });
  player.enqueue({ owner: "room", key: "old", text: "旧消息" });
  player.enqueue({ owner: "room", key: "queued", text: "排队消息" });
  player.replace({ owner: "preview", key: "preview", text: "试听" });
  await tick();
  assert.equal(oldSignal.aborted, true);
  assert.equal(playing, 1);
  finishOld(audio);
  await tick();
  assert.equal(playing, 1);
  assert.equal(player.getSnapshot().owner, "preview");
  player.stop("room");
  assert.equal(player.getSnapshot().owner, "preview");
  player.stop("preview");
  await tick();
  assert.equal(player.getSnapshot().status, "idle");
});

test("合成失败后清空同一房间队列，手动重试可以继续", async () => {
  let fail = true;
  const player = new SpeechPlayer({
    async synthesize() {
      if (fail) throw new Error("额度不足");
      return audio;
    },
    async play() {},
  });
  player.enqueue({ owner: "room", key: "1", text: "你好" });
  player.enqueue({ owner: "room", key: "2", text: "后续" });
  await tick();
  assert.equal(player.getSnapshot().error, "额度不足");
  assert.equal(player.getSnapshot().queued, 0);
  fail = false;
  player.replace({ owner: "room", key: "1", text: "你好" });
  await tick();
  assert.equal(player.getSnapshot().status, "idle");
});
