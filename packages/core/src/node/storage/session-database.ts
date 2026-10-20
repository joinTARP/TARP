import { Kysely, SqliteDialect, sql, type Compilable, type Generated } from "kysely";
import { Migrator } from "kysely/migration";

import { chatMessagesMigration } from "./migrations/001-chat-messages";
import { SqliteDatabase, type SqliteOptions } from "./sqlite";

interface SessionSchema {
  chat_messages: { sequence: Generated<number>; id: string; data: string };
  chat_input_batches: { id: string; message_id: string; data: string };
  chat_requests: {
    player_id: string;
    operation: "send" | "continue";
    request_id: string;
    fingerprint: string;
    message_id: string;
  };
  steering_requests: {
    sequence: Generated<number>;
    id: string;
    request_id: string;
    player_id: string;
    state: string;
    run_id: string;
    batch_id: string | null;
    data: string;
  };
  steering_batches: { id: string; request_key: string | null; data: string; received: number };
  steering_meta: { id: number; revision: number };
}

/** 固定 JSON 路径保留 SQLite 表达式索引；查询值仍由 Kysely 参数绑定。 */
export function chatField<T = string>(path: string) {
  return sql<T>`json_extract(data, ${sql.lit(`$.${path}`)})`;
}

/** Kysely 构建 SQL，内置 SQLite 同步执行，业务事务中不引入异步让出。 */
export class SessionDatabase {
  private static migrations = new Map<string, Promise<void>>();
  private readonly closeListeners = new Set<() => void>();
  readonly sqlite: SqliteDatabase;
  readonly query: Kysely<SessionSchema>;

  constructor(path: string, options: SqliteOptions = {}) {
    this.sqlite = new SqliteDatabase(path, { timeout: 5000, ...options });
    this.query = new Kysely<SessionSchema>({
      dialect: new SqliteDialect({ database: this.sqlite }),
    });
  }

  async migrate() {
    // 同进程打开同一文件时共用迁移任务，避免同步 SQLite 锁等待阻塞另一连接的异步提交。
    const path = this.sqlite.name;
    const pending = SessionDatabase.migrations.get(path);
    if (pending) return pending;
    const migration = this.applyMigrations().finally(() => SessionDatabase.migrations.delete(path));
    SessionDatabase.migrations.set(path, migration);
    return migration;
  }

  private async applyMigrations() {
    const migrator = new Migrator({
      db: this.query,
      provider: { getMigrations: async () => ({ "001-chat-messages": chatMessagesMigration }) },
    });
    if ((await migrator.getMigrations()).every((migration) => migration.executedAt)) return;
    // Kysely 的 SQLite 迁移默认不包事务；将结构与迁移记录一并提交，失败时全部回滚。
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const { error } = await migrator.migrateToLatest();
      if (error) throw error;
      this.sqlite.exec("COMMIT");
    } catch (error) {
      if (this.sqlite.inTransaction) this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  all<T>(query: Compilable<T>): T[] {
    const { sql, parameters } = query.compile();
    return this.sqlite.prepare<unknown[], T>(sql).all(...parameters);
  }

  get<T>(query: Compilable<T>): T | undefined {
    const { sql, parameters } = query.compile();
    return this.sqlite.prepare<unknown[], T>(sql).get(...parameters);
  }

  run(query: Compilable<unknown>) {
    const { sql, parameters } = query.compile();
    return this.sqlite.prepare(sql).run(...parameters);
  }

  onClose(listener: () => void) {
    if (!this.sqlite.open) throw new Error("数据库已经关闭");
    this.closeListeners.add(listener);
  }

  close() {
    // 连接由本对象持有；业务关闭保持同步，Kysely 的 SQLite 驱动没有其他资源。
    if (!this.sqlite.open) return;
    this.sqlite.close();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "数据库已关闭，但资源释放失败");
  }
}
