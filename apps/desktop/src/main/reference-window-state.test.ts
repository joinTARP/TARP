import { it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReferenceWindowState } from "./reference-window-state";

async function pathFor() {
  const root = await mkdtemp(join(tmpdir(), "tarp-window-state-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return join(root, "bounds.json");
}
const bounds = { x: 10, y: 20, width: 800, height: 600 };

it("连续移动最后一次位置被保存，刷新后可重新读取", async () => {
  const path = await pathFor();
  const state = new ReferenceWindowState(path);
  const saves = Array.from({ length: 20 }, (_, x) => state.save({ ...bounds, x }));
  await state.flush();
  await Promise.all(saves);
  const reopened = new ReferenceWindowState(path);
  await reopened.load();
  assert.deepEqual(reopened.value, { ...bounds, x: 19 });
  const copy = state.value!;
  Reflect.set(copy, "x", 999);
  assert.equal(state.value?.x, 19);
});

it("加载旧位置期间发生移动，新位置优先", async () => {
  const path = await pathFor();
  await writeFile(path, JSON.stringify(bounds));
  const state = new ReferenceWindowState(path);
  const loading = state.load();
  const saving = state.save({ ...bounds, x: 42 });
  await loading;
  assert.equal(state.value?.x, 42);
  await saving;
  assert.equal(JSON.parse(await readFile(path, "utf8")).x, 42);
});

it("缺失时默认无位置，无效尺寸不覆盖已有位置", async () => {
  const path = await pathFor();
  const state = new ReferenceWindowState(path);
  await state.load();
  assert.equal(state.value, null);
  await state.save(bounds);
  await assert.rejects(state.save({ ...bounds, width: 0 }));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), bounds);
});
