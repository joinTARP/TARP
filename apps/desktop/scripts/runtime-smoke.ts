import { strict as assert } from "node:assert";

import { SqliteDatabase } from "@tarp/core/node/storage/sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { getQuickJS } from "quickjs-emscripten";

const path = process.argv[2];
assert.ok(path, "需要独立测试数据库路径");
const native = new SqliteDatabase(path);
const db = new Kysely<{ probe: { id: number; text: string } }>({
  dialect: new SqliteDialect({ database: native }),
});
try {
  await db.schema
    .createTable("probe")
    .addColumn("id", "integer", (column) => column.primaryKey())
    .addColumn("text", "text", (column) => column.notNull())
    .execute();
  await db.insertInto("probe").values({ id: 1, text: "原生数据库验收" }).execute();
  await assert.rejects(
    db.transaction().execute(async (transaction) => {
      await transaction.insertInto("probe").values({ id: 2, text: "必须回滚" }).execute();
      throw new Error("rollback probe");
    }),
    /rollback probe/,
  );
} finally {
  await db.destroy();
}
const reopened = new SqliteDatabase(path, { fileMustExist: true });
try {
  assert.deepEqual(reopened.prepare("SELECT * FROM probe").all(), [
    { id: 1, text: "原生数据库验收" },
  ]);
} finally {
  reopened.close();
}
const context = (await getQuickJS()).newContext();
try {
  const result = context.evalCode("6 * 7");
  assert.equal(result.error, undefined);
  assert.equal(context.dump(result.value!), 42);
  result.value!.dispose();
} finally {
  context.dispose();
}
console.log(`打包运行时验收通过：Bun ${Bun.version}、SQLite 写入与回滚、重开恢复、QuickJS Wasm。`);
