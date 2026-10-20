import type { TtsChunk } from "../../shared/tts";
import { TtsError } from "./provider";

type Job = {
  key: string;
  controller: AbortController;
  chunks: TtsChunk[];
  bytes: number;
  readers: number;
  changed: Set<() => void>;
  done: boolean;
  error?: unknown;
  produce: (signal: AbortSignal) => AsyncIterable<TtsChunk>;
};

/** 进程内 single-flight：只锁任务登记，网络期间不持有设置锁。
 * 每个订阅者有自己的游标和取消信号；可从头重放已生成片段。
 */
export class SharedTtsJobs {
  private jobs = new Map<string, Job>();
  private retained = new Set<Job>();
  private pending: Job[] = [];
  private active = 0;
  private bytes = 0;
  private closed = false;
  constructor(
    private concurrency = 2,
    private capacity = 16,
  ) {}

  async *subscribe(
    key: string,
    produce: Job["produce"],
    signal?: AbortSignal,
  ): AsyncGenerator<TtsChunk> {
    signal?.throwIfAborted();
    if (this.closed) throw new TtsError("语音服务已关闭。");
    let job = this.jobs.get(key);
    if (!job) {
      if (this.retained.size >= this.capacity) throw new TtsError("语音任务较多，请稍后重试。");
      job = {
        key,
        produce,
        controller: new AbortController(),
        chunks: [],
        bytes: 0,
        readers: 0,
        changed: new Set(),
        done: false,
      };
      this.jobs.set(key, job);
      this.retained.add(job);
      this.pending.push(job);
    }
    if (job.readers >= 32) throw new TtsError("此语音的播放连接过多，请稍后重试。");
    job.readers++;
    const current = job;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.readers--;
      if (!current.readers) {
        if (this.jobs.get(key) === current) this.jobs.delete(key);
        current.controller.abort();
        this.bytes -= current.bytes;
        current.bytes = 0;
        current.chunks = [];
        this.retained.delete(current);
        this.pending = this.pending.filter((item) => item !== current);
      }
      this.wake(current);
    };
    signal?.addEventListener("abort", release, { once: true });
    this.drain();
    let cursor = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (current.error) throw current.error;
        if (cursor < current.chunks.length) {
          yield current.chunks[cursor++]!;
          continue;
        }
        if (current.done) return;
        await new Promise<void>((resolve) => current.changed.add(resolve));
      }
    } finally {
      signal?.removeEventListener("abort", release);
      release();
    }
  }
  close() {
    this.closed = true;
    this.pending = [];
    this.jobs.clear();
    for (const job of this.retained) {
      job.error = new TtsError("语音服务已关闭。");
      job.controller.abort();
      job.chunks = [];
      job.bytes = 0;
      this.wake(job);
    }
    this.bytes = 0;
  }
  private wake(job: Job) {
    const listeners = [...job.changed];
    job.changed.clear();
    for (const wake of listeners) wake();
  }
  private drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      if (!job.readers) continue;
      this.active++;
      void this.run(job);
    }
  }
  private async run(job: Job) {
    const timeout = setTimeout(() => {
      job.error = new TtsError("语音任务超时，请重试。");
      job.controller.abort();
      this.wake(job);
    }, 120_000);
    try {
      for await (const chunk of job.produce(job.controller.signal)) {
        job.controller.signal.throwIfAborted();
        const size = chunk.type === "pcm" ? chunk.data.length : chunk.audio.data.length;
        if (
          job.chunks.length >= 16384 ||
          job.bytes + size > 24 * 1024 * 1024 ||
          this.bytes + size > 32 * 1024 * 1024
        )
          throw new TtsError("语音缓冲区已满，请缩短文本或稍后重试。");
        job.bytes += size;
        this.bytes += size;
        job.chunks.push(chunk);
        this.wake(job);
      }
    } catch (error) {
      job.error ??= error;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    } finally {
      clearTimeout(timeout);
      job.done = true;
      this.wake(job);
      this.active--;
      this.drain();
    }
  }
}
