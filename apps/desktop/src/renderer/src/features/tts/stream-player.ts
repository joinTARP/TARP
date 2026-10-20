import type { TtsChunk } from "@shared/tts";

import { playAudio } from "./speech-player";

// 一个窗口复用一个音频设备上下文；节点归每次播放所有，停止不会影响下一次播放。
let context: AudioContext | undefined;

/** PCM16LE 解码保留网络片段边界处的不完整帧。 */
export class PcmDecoder {
  private tail = new Uint8Array(0);
  decode(data: string, channels: number): Float32Array[] {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const joined = new Uint8Array(this.tail.length + bytes.length);
    joined.set(this.tail);
    joined.set(bytes, this.tail.length);
    const frames = Math.floor(joined.length / (channels * 2));
    const view = new DataView(joined.buffer);
    const result = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let frame = 0; frame < frames; frame++)
      for (let channel = 0; channel < channels; channel++)
        result[channel]![frame] = view.getInt16((frame * channels + channel) * 2, true) / 32768;
    this.tail = joined.slice(frames * channels * 2);
    return result;
  }
  finish() {
    if (this.tail.length) throw new Error("语音数据不完整，请重试。");
  }
}

export async function playStream(
  open: () => Promise<AsyncIterable<TtsChunk>>,
  signal: AbortSignal,
  onPlaying: () => void,
): Promise<void> {
  signal.throwIfAborted();
  context ??= new AudioContext();
  const audioContext = context;
  const sources = new Set<AudioBufferSourceNode>();
  let wake: (() => void) | undefined;
  const stop = () => {
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    sources.clear();
    wake?.();
  };
  signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 在用户操作触发的调用栈中请求启动设备，避免等网络响应后才解锁音频。
    await Promise.race([
      audioContext.resume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("无法启动音频设备，请点击朗读按钮重试。")), 3000);
      }),
    ]);
    clearTimeout(timer);
    signal.throwIfAborted();
    const chunks = await open();
    const decoder = new PcmDecoder();
    let nextTime = audioContext.currentTime + 0.06;
    let format: string | undefined;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      if (chunk.type === "audio") {
        onPlaying();
        await playAudio(chunk.audio, signal);
        continue;
      }
      const currentFormat = `${chunk.sampleRate}:${chunk.channels}`;
      if (format && format !== currentFormat) throw new Error("语音流的格式发生变化。");
      format = currentFormat;
      const decoded = decoder.decode(chunk.data, chunk.channels);
      if (!decoded[0]!.length) continue;
      const buffer = audioContext.createBuffer(
        chunk.channels,
        decoded[0]!.length,
        chunk.sampleRate,
      );
      decoded.forEach((samples, channel) =>
        buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, channel),
      );
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      sources.add(source);
      source.onended = () => {
        source.disconnect();
        sources.delete(source);
        wake?.();
      };
      nextTime = Math.max(nextTime, audioContext.currentTime + 0.02);
      source.start(nextTime);
      nextTime += buffer.duration;
      onPlaying();
    }
    decoder.finish();
    while (sources.size) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stop();
  }
}
