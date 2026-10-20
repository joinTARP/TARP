import { join } from "node:path";

import type { SessionDatabase } from "../storage/session-database";

const databaseDirectories = new WeakMap<SessionDatabase, string>();

export function associateSessionDirectory(db: SessionDatabase, directory: string): void {
  databaseDirectories.set(db, directory);
}

export function roomDirectoryForDatabase(db: SessionDatabase): string {
  const directory = databaseDirectories.get(db);
  if (!directory) throw new Error("数据库未关联冒险目录");
  return directory;
}

export function gameDirectoryForDatabase(db: SessionDatabase): string {
  return join(roomDirectoryForDatabase(db), "game");
}
