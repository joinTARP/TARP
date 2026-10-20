import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";

/** 同一进程中不同 SQLite 连接共享文件提交锁，允许同一提交内的嵌套读取。 */
const queues = new Map<string, Promise<unknown>>();
const owners = new AsyncLocalStorage<Map<string, { active: boolean }>>();
export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  root = realpathSync(root);
  if (owners.getStore()?.get(root)?.active) return fn();
  const previous = queues.get(root) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const held = new Map(owners.getStore());
      const owner = { active: true };
      held.set(root, owner);
      try {
        return await owners.run(held, fn);
      } finally {
        owner.active = false;
      }
    });
  queues.set(root, next);
  try {
    return await next;
  } finally {
    if (queues.get(root) === next) queues.delete(root);
  }
}
