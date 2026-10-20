import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface SqliteOptions {
  fileMustExist?: boolean;
  readonly?: boolean;
  timeout?: number;
}

/** Bun 内置 SQLite；仅适配 Kysely 的参数数组与 reader 契约。 */
export class SqliteDatabase {
  private readonly database: Database;
  private closed = false;
  constructor(
    readonly name: string,
    options: SqliteOptions = {},
  ) {
    if (options.fileMustExist && name !== ":memory:" && !existsSync(name))
      throw new Error(`数据库文件不存在：${name}`);
    const timeout = options.timeout ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("数据库等待时间无效");
    this.database = new Database(name, {
      readonly: options.readonly ?? false,
      create: !options.fileMustExist,
      strict: true,
    });
    this.database.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
  get open(): boolean {
    return !this.closed;
  }
  get inTransaction(): boolean {
    return this.database.inTransaction;
  }
  exec(sql: string): void {
    this.database.exec(sql);
  }
  close(): void {
    this.database.close(true);
    this.closed = true;
  }
  prepare<Parameters extends unknown[] = unknown[], Row = unknown>(sql: string) {
    const statement = this.database.query<Row, SQLQueryBindings[]>(sql);
    const bindings = (parameters: readonly unknown[]): SQLQueryBindings[] =>
      (parameters.length === 1 && Array.isArray(parameters[0])
        ? parameters[0]
        : parameters) as SQLQueryBindings[];
    return {
      reader: statement.columnNames.length > 0,
      all: (...parameters: Parameters): Row[] => statement.all(...bindings(parameters)),
      get: (...parameters: Parameters): Row | undefined => {
        const row = statement.get(...bindings(parameters));
        return row ?? undefined;
      },
      run: (...parameters: Parameters) => statement.run(...bindings(parameters)),
      *iterate(parameters: readonly unknown[]) {
        yield* statement.iterate(...bindings(parameters));
      },
    };
  }
}
