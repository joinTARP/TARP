import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

type FrameScheduler = {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
  now(): number;
};

const browserFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

/** 合并约 40ms 内的更新，整批展示已收到的原文，不人为拆开 Markdown 标记。 */
export function frameTextBuffer(
  display: (text: string) => void,
  frames: FrameScheduler = browserFrames,
  initial = "",
) {
  let latest = initial;
  let shown = initial;
  let frame: number | undefined;
  let started = 0;
  const cancel = () => {
    if (frame === undefined) return;
    frames.cancel(frame);
    frame = undefined;
  };
  const tick = (time: number) => {
    frame = undefined;
    if (time - started < 40) {
      frame = frames.request(tick);
      return;
    }
    shown = latest;
    display(shown);
  };
  return {
    push(text: string) {
      // 重试、修订或工具参数改写不能继续播放旧的尾部。
      if (!text.startsWith(latest)) {
        this.flush(text);
        return;
      }
      latest = text;
      if (shown !== latest && frame === undefined) {
        started = frames.now();
        frame = frames.request(tick);
      }
    },
    flush(text: string) {
      cancel();
      latest = shown = text;
      display(text);
    },
    pending: () => shown !== latest,
    dispose: cancel,
  };
}

/** 历史直接展示；正常结束收完短缓冲，停止或失败立即显示权威正文。 */
export function useFrameText(text: string, streaming: boolean, immediate = false): string {
  const reducedMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(text);
  const [buffer] = useState(() => frameTextBuffer(setDisplayed, browserFrames, text));
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (!immediate && !reducedMotion && (streaming || wasStreaming.current || buffer.pending()))
      buffer.push(text);
    else buffer.flush(text);
    wasStreaming.current = streaming;
  }, [buffer, text, streaming, immediate, reducedMotion]);
  useEffect(() => () => buffer.dispose(), [buffer]);
  return !immediate && !reducedMotion && text.startsWith(displayed) ? displayed : text;
}
