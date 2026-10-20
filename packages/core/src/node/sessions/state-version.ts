import type { SessionDatabase } from "../storage/session-database";
import { notifyRoomChanged } from "./room-changes";
import { roomDirectoryForDatabase } from "./session-paths";

/** 版本只用于当前进程内的界面刷新；权威内容始终从房间文件读取。 */
const rooms = new Map<
  string,
  {
    revision: number;
    files: Map<string, number>;
    documentRevision: number;
    dirty: Map<string, number>;
  }
>();

function versions(db: SessionDatabase) {
  const directory = roomDirectoryForDatabase(db);
  let current = rooms.get(directory);
  if (!current) {
    current = { revision: 0, files: new Map(), documentRevision: 0, dirty: new Map() };
    rooms.set(directory, current);
  }
  return current;
}

export function stateRevision(db: SessionDatabase): number {
  return versions(db).revision;
}

export function bumpStateRevision(db: SessionDatabase): void {
  versions(db).revision++;
  notifyRoomChanged(roomDirectoryForDatabase(db));
}

export function fileRevision(db: SessionDatabase, path: string): number {
  return versions(db).files.get(path) ?? 1;
}

export function bumpFileRevision(db: SessionDatabase, path: string, created: boolean): number {
  return bumpFileRevisions(db, [{ path, created }])[0]!;
}

/** 一批文档先共同推进版本，再通知，避免订阅读取到半批版本。 */
export function bumpFileRevisions(
  db: SessionDatabase,
  updates: readonly { path: string; created: boolean }[],
): number[] {
  const current = versions(db);
  const revisions = updates.map(({ path, created }) => {
    const revision = created ? 1 : (current.files.get(path) ?? 1) + 1;
    current.files.set(path, revision);
    current.documentRevision++;
    current.dirty.set(path, current.documentRevision);
    current.revision++;
    return revision;
  });
  if (updates.length) notifyRoomChanged(roomDirectoryForDatabase(db));
  return revisions;
}

export function forgetStateVersions(directory: string): void {
  rooms.delete(directory);
}

/** 仅文件成功提交增长；房间元数据变化不影响此版本。 */
export function documentRevision(db: SessionDatabase): number {
  return versions(db).documentRevision;
}
export function documentDirtyPaths(db: SessionDatabase, afterRevision: number): string[] {
  return [...versions(db).dirty]
    .filter(([, revision]) => revision > afterRevision)
    .map(([path]) => path);
}
