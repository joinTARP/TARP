import type { DocumentType } from "@tarp/module/document-type";

import type { SessionDatabase } from "../storage/session-database";
import { storedTypes } from "./character-db";
import { listGameFileRecords, recognizedType, type GameFileRecord } from "./game-file-index";
import { overlayEntries } from "./game-overlay";
import { gameDirectoryForDatabase } from "./session-paths";

/** 主持仅可查阅已注册类型的文档，以及这些类型的字段定义。 */
export function isGameReadableFile(path: string, types: readonly DocumentType[]): boolean {
  if (path === ".types" || path.startsWith(".types/")) {
    const match = /^\.types\/([^/]+)\.fields\.(json|toml)$/u.exec(path);
    return !!match && types.some((type) => type.id === match[1]);
  }
  return !!recognizedType(path, types);
}

/** 每次查询重新枚举，保证本局新增文档立即可查。 */
export function gameReadableFiles(
  db: SessionDatabase,
  records: readonly GameFileRecord[] = listGameFileRecords(db),
): ReadonlySet<string> {
  const types = storedTypes(db);
  const files = new Set(
    records.filter((record) => isGameReadableFile(record.path, types)).map((record) => record.path),
  );
  for (const entry of overlayEntries(gameDirectoryForDatabase(db), ".types")) {
    const path = `.types/${entry.name}`;
    if (entry.isFile() && isGameReadableFile(path, types)) files.add(path);
  }
  return files;
}

/** 目录仅展示允许文件及其父目录，目录名以 / 结尾。 */
export function gameReadableEntries(files: ReadonlySet<string>, directory: string): string[] {
  const prefix = directory ? `${directory}/` : "";
  const entries = new Set<string>();
  for (const path of files) {
    if (!path.startsWith(prefix)) continue;
    const child = path.slice(prefix.length);
    const slash = child.indexOf("/");
    entries.add(slash < 0 ? child : child.slice(0, slash + 1));
  }
  return [...entries].sort();
}
