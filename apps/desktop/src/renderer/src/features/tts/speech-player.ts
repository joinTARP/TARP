import { splitSpeechText } from "@shared/speech-text";
import type { TtsAudio, TtsPreview, TtsSpeaker } from "@shared/tts";

export interface SpeechJob {
  owner: string;
  key: string;
  text: string;
  speaker?: TtsSpeaker;
  preview?: TtsPreview;
}
export interface SpeechSnapshot {
  owner?: string;
  key?: string;
  status: "idle" | "loading" | "playing" | "error";
  error?: string;
  queued: number;
}
export interface SpeechTransport {
  streamPlay?(
    text: string,
    speaker: TtsSpeaker | undefined,
    preview: TtsPreview | undefined,
    signal: AbortSignal,
    onPlaying: () => void,
  ): Promise<void>;
  synthesize(
    text: string,
    speaker: TtsSpeaker | undefined,
    preview: TtsPreview | undefined,
    signal: AbortSignal,
  ): Promise<TtsAudio>;
  play(audio: TtsAudio, signal: AbortSignal): Promise<void>;
}

/** 全应用只播放一段音频；请求取消、队列和具体语音服务商无关。 */
export class SpeechPlayer {
  private queue: SpeechJob[] = [];
  private active?: {
    job: SpeechJob;
    controller: AbortController;
    prefetchController?: AbortController;
  };
  private prefetched?: {
    job: SpeechJob;
    controller: AbortController;
    audio: Promise<TtsAudio[]>;
  };
  private listeners = new Set<() => void>();
  private snapshot: SpeechSnapshot = { status: "idle", queued: 0 };
  constructor(private transport: SpeechTransport) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Omit<SpeechSnapshot, "queued">) {
    this.snapshot = { ...value, queued: this.queue.length };
    for (const listener of this.listeners) listener();
  }
  enqueue(job: SpeechJob) {
    if (
      !job.text.trim() ||
      this.active?.job.key === job.key ||
      this.queue.some((item) => item.key === job.key)
    )
      return;
    this.queue.push(job);
    this.update(this.snapshot);
    this.prefetchNext();
    void this.next();
  }
  replace(job: SpeechJob) {
    this.stop();
    this.enqueue(job);
  }
  stop(owner?: string) {
    this.queue = owner ? this.queue.filter((job) => job.owner !== owner) : [];
    if (this.prefetched && (!owner || this.prefetched.job.owner === owner)) {
      this.prefetched.controller.abort();
      this.prefetched = undefined;
    }
    if (this.active && (!owner || this.active.job.owner === owner)) {
      const active = this.active;
      this.active = undefined;
      active.controller.abort();
      active.prefetchController?.abort();
    }
    if (!owner || this.snapshot.owner === owner) this.update({ status: "idle" });
    else this.update(this.snapshot);
    this.prefetchNext();
    void this.next();
  }
  /** 当前消息播放时同时合成队首，最多提前一条。 */
  private prefetchNext() {
    if (!this.active) return;
    const job = this.queue[0];
    if (!job) {
      this.prefetched?.controller.abort();
      this.prefetched = undefined;
      return;
    }
    if (this.prefetched?.job.key === job.key) return;
    this.prefetched?.controller.abort();
    const controller = new AbortController();
    const audio = (async () => {
      const result: TtsAudio[] = [];
      for (const text of splitSpeechText(job.text))
        result.push(
          await this.transport.synthesize(text, job.speaker, job.preview, controller.signal),
        );
      controller.signal.throwIfAborted();
      return result;
    })();
    // 预取失败由该任务真正轮到播放时统一处理。
    void audio.catch(() => {});
    this.prefetched = { job, controller, audio };
  }
  private async next() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    const active: NonNullable<SpeechPlayer["active"]> = {
      job,
      controller: new AbortController(),
    };
    this.active = active;
    const { signal } = active.controller;
    const prefetched = this.prefetched?.job.key === job.key ? this.prefetched : undefined;
    if (prefetched) {
      this.prefetched = undefined;
      active.prefetchController = prefetched.controller;
    }
    this.prefetchNext();
    try {
      if (prefetched) {
        this.update({ owner: job.owner, key: job.key, status: "loading" });
        const audio = await prefetched.audio;
        signal.throwIfAborted();
        for (const part of audio) {
          signal.throwIfAborted();
          this.update({ owner: job.owner, key: job.key, status: "playing" });
          await this.transport.play(part, signal);
        }
      } else {
        for (const text of splitSpeechText(job.text)) {
          this.update({ owner: job.owner, key: job.key, status: "loading" });
          const playing = () => {
            if (!signal.aborted) this.update({ owner: job.owner, key: job.key, status: "playing" });
          };
          if (this.transport.streamPlay) {
            await this.transport.streamPlay(text, job.speaker, job.preview, signal, playing);
          } else {
            const audio = await this.transport.synthesize(text, job.speaker, job.preview, signal);
            signal.throwIfAborted();
            playing();
            await this.transport.play(audio, signal);
          }
          signal.throwIfAborted();
        }
      }
      this.update({ status: "idle" });
    } catch (error) {
      if (!signal.aborted) {
        this.queue = this.queue.filter((item) => item.owner !== job.owner);
        if (this.prefetched?.job.owner === job.owner) {
          this.prefetched.controller.abort();
          this.prefetched = undefined;
        }
        this.update({
          owner: job.owner,
          key: job.key,
          status: "error",
          error: error instanceof Error ? error.message : "语音播放失败，请重试。",
        });
      }
    } finally {
      if (this.active === active) {
        this.active = undefined;
        void this.next();
      }
    }
  }
}

export function playAudio(audio: TtsAudio, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const bytes = Uint8Array.from(atob(audio.data), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: audio.mimeType }));
  const element = new Audio(url);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      element.onended = null;
      element.onerror = null;
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    element.onended = () => finish();
    element.onerror = () => finish(new Error("音频无法播放，请重新合成。"));
    void element
      .play()
      .catch(() => finish(new Error("无法开始播放，请点击消息旁的朗读按钮重试。")));
  });
}
