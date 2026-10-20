import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** 当前未发布存档的初始结构，不读取或迁移历史开发格式。 */
export const chatMessagesMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("chat_messages")
      .addColumn("sequence", "integer", (column) => column.primaryKey().autoIncrement())
      .addColumn("id", "text", (column) => column.notNull().unique())
      .addColumn("data", "text", (column) => column.notNull())
      .execute();
    await sql`CREATE INDEX chat_messages_kind_status
      ON chat_messages(json_extract(data,'$.kind'),json_extract(data,'$.status'))`.execute(db);
    await db.schema
      .createTable("chat_input_batches")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("message_id", "text", (c) => c.notNull().unique())
      .addColumn("data", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("chat_requests")
      .addColumn("player_id", "text", (c) => c.notNull())
      .addColumn("operation", "text", (c) => c.notNull())
      .addColumn("request_id", "text", (c) => c.notNull())
      .addColumn("fingerprint", "text", (c) => c.notNull())
      .addColumn("message_id", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("chat_request_identity", ["player_id", "operation", "request_id"])
      .execute();
    await db.schema
      .createTable("steering_requests")
      .addColumn("sequence", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("id", "text", (c) => c.notNull().unique())
      .addColumn("request_id", "text", (c) => c.notNull())
      .addColumn("player_id", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("run_id", "text", (c) => c.notNull())
      .addColumn("batch_id", "text")
      .addColumn("data", "text", (c) => c.notNull())
      .addUniqueConstraint("steering_request_identity", ["player_id", "request_id"])
      .execute();
    await db.schema
      .createTable("steering_batches")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("request_key", "text", (c) => c.unique())
      .addColumn("data", "text", (c) => c.notNull())
      .addColumn("received", "integer", (c) => c.notNull())
      .execute();
    await db.schema
      .createTable("steering_meta")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("revision", "integer", (c) => c.notNull())
      .execute();
    await db.insertInto("steering_meta").values({ id: 1, revision: 0 }).execute();
  },
  // 插话请求保留终态，用于重试去重；公开快照只读取尚未接收的条目。
  async down(db) {
    await db.schema.dropTable("steering_requests").execute();
    await db.schema.dropTable("steering_batches").execute();
    await db.schema.dropTable("steering_meta").execute();
    await db.schema.dropTable("chat_input_batches").execute();
    await db.schema.dropTable("chat_requests").execute();
    await db.schema.dropTable("chat_messages").execute();
  },
};
