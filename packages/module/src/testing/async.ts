import { onTestFinished } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { install } from "@sinonjs/fake-timers";

let clock: ReturnType<typeof install> | undefined;

/** 异步业务测试需要在推进时钟时让 Promise、文件与网络操作继续执行。 */
export function useFakeTimers(options: NonNullable<Parameters<typeof install>[0]> = {}) {
  useRealTimers();
  clock = install({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    ...options,
  });
  onTestFinished(useRealTimers);
}

export function useRealTimers() {
  clock?.uninstall();
  clock = undefined;
}

function activeClock() {
  if (!clock) throw new Error("请先启用测试时钟");
  return clock;
}

export function advanceTimersByTime(milliseconds: number) {
  activeClock().tick(milliseconds);
}

export async function advanceTimersByTimeAsync(milliseconds: number) {
  await activeClock().tickAsync(milliseconds);
}

export function getTimerCount() {
  return activeClock().countTimers();
}

/** 等待可观察结果；超时时保留最后一次断言错误。 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const { timeout = 1000, interval = 20 } = options;
  const started = performance.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (performance.now() - started >= timeout) throw error;
    }
    if (clock) await clock.tickAsync(interval);
    await delay(interval);
  }
}
