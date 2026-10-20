import { constants, type Stats } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

function sameFileVersion(a: Stats, b: Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
interface CachedSession {
  room: string;
  manager: SessionManager;
  version: Stats;
  active: boolean;
}

/** 运行、详情与统计共用管理器；活动实例不淘汰，结束后按文件预算释放。 */
export class PiSessionCache {
  private files = new Map<string, CachedSession>();
  private loading = new Map<string, Promise<SessionManager | undefined>>();

  private async version(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const version = await file.stat();
      if (!version.isFile() || version.nlink !== 1) throw new Error("Pi 会话必须是独立普通文件");
      return version;
    } finally {
      await file.close();
    }
  }

  private get(path: string, room: string): Promise<SessionManager | undefined> {
    const cached = this.files.get(path);
    if (cached?.active) return Promise.resolve(cached.manager);
    const pending = this.loading.get(path);
    if (pending) return pending;
    const loading = this.load(path, room).finally(() => this.loading.delete(path));
    this.loading.set(path, loading);
    return loading;
  }

  private async load(path: string, room: string) {
    let version;
    try {
      version = await this.version(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.files.delete(path);
      return undefined;
    }
    if (version.size === 0) {
      this.files.delete(path);
      return undefined;
    }
    const cached = this.files.get(path);
    if (cached && sameFileVersion(cached.version, version)) {
      this.touch(path, cached);
      return cached.manager;
    }
    this.files.delete(path);
    const manager = SessionManager.open(path, dirname(path), room);
    // 首次空文件初始化可能改写头部，缓存 SDK 加载后的版本。
    version = await this.version(path);
    this.touch(path, { room, manager, version, active: false });
    this.trim();
    return manager;
  }

  async read(roomDirectory: string, companionId?: string) {
    const room = await realpath(roomDirectory);
    return this.get(
      join(room, "agent", companionId ? `companion-${companionId}.jsonl` : "session.jsonl"),
      room,
    );
  }

  async take(path: string, agentDirectory: string, room: string) {
    let manager = await this.get(path, room);
    if (!manager) {
      // 只有运行入口初始化空文件；只读查询不能因 SDK.open 写入会话头。
      await this.version(path);
      manager = SessionManager.open(path, agentDirectory, room);
    }
    const entry = this.files.get(path);
    if (entry) entry.active = true;
    else this.files.set(path, { room, manager, version: await this.version(path), active: true });
    return manager;
  }

  async retain(path: string, room: string, manager: SessionManager) {
    try {
      const version = await this.version(path);
      if (manager.getSessionFile() !== path) {
        this.discard(path, manager);
        return;
      }
      this.touch(path, { room, manager, version, active: false });
      this.trim();
    } catch {
      this.discard(path, manager);
    }
  }

  discard(path: string, manager: SessionManager) {
    if (this.files.get(path)?.manager === manager) this.files.delete(path);
  }

  private touch(path: string, entry: CachedSession) {
    this.files.delete(path);
    this.files.set(path, entry);
  }

  private trim() {
    let bytes = [...this.files.values()].reduce((total, entry) => total + entry.version.size, 0);
    for (const [path, entry] of this.files) {
      if (this.files.size <= 8 && bytes <= 64 * 1024 * 1024) break;
      if (entry.active) continue;
      this.files.delete(path);
      bytes -= entry.version.size;
    }
  }

  async closeRoom(roomDirectory: string) {
    const requested = resolve(roomDirectory);
    const room = await realpath(requested).catch(() => requested);
    // 调用方先结束运行与查询；关闭后重开的房间从文件恢复。
    for (const [path, entry] of this.files) {
      if (entry.room === room || entry.room === requested) this.files.delete(path);
    }
  }
}
