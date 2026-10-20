import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDesktopInstance } from "./desktop-instance";

test("重复启动只唤醒原实例并传递预览路径，关闭后允许重新启动", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarp-instance-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const opened: (string | undefined)[] = [];
  const first = await acquireDesktopInstance(directory, undefined, (path) => opened.push(path));
  assert.ok(first);
  try {
    assert.equal(
      await acquireDesktopInstance(directory, "/tmp/中文 ?# 模组", () =>
        assert.fail("不应创建第二个宿主"),
      ),
      null,
    );
    assert.deepEqual(opened, ["/tmp/中文 ?# 模组"]);
  } finally {
    await first.close();
  }
  const reopened = await acquireDesktopInstance(directory, undefined, () => {});
  assert.ok(reopened);
  await reopened.close();
});
