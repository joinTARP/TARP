import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const queues = new Map<string, Promise<void>>();
let registration = Promise.resolve();

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 尚未创建的文件也按真实父目录归一化，避免目录链接绕过同文件队列。 */
async function queueKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await queueKey(parent), basename(path));
  }
}

/** 保护当前进程内的一次完整文件操作；不同文件并行，失败不阻塞后续操作。 */
export async function withFileMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  // 注册顺序固定，避免异步 realpath 完成顺序改变调用顺序。
  const entry = registration.then(async () => {
    const key = await queueKey(resolve(path));
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((finish) => {
      release = finish;
    });
    const tail = previous.then(() => done);
    queues.set(key, tail);
    return { key, previous, tail, release };
  });
  registration = entry.then(
    () => undefined,
    () => undefined,
  );
  const { key, previous, tail, release } = await entry;
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
