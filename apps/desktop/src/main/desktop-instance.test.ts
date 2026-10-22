import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDesktopInstance, type DesktopActivation } from "./desktop-instance";

test("重复启动只唤醒原实例并传递预览路径，关闭后允许重新启动", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarp-instance-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const opened: DesktopActivation[] = [];
  const first = await acquireDesktopInstance(directory, { kind: "activate" }, (request) =>
    opened.push(request),
  );
  assert.ok(first);
  try {
    assert.equal(
      await acquireDesktopInstance(directory, { kind: "preview", path: "/tmp/中文 ?# 模组" }, () =>
        assert.fail("不应创建第二个宿主"),
      ),
      null,
    );
    const request = { kind: "import" as const, url: "tarp://import?repository=author%2Frepo" };
    assert.equal(
      await acquireDesktopInstance(directory, request, () => assert.fail("不应创建第二实例")),
      null,
    );
    assert.deepEqual(opened, [{ kind: "preview", path: "/tmp/中文 ?# 模组" }, request]);
    const identifier = createHash("sha256").update(directory).digest("hex").slice(0, 32);
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\tarp-${identifier}`
        : Buffer.byteLength(join(directory, "desktop.sock")) < 104
          ? join(directory, "desktop.sock")
          : join(tmpdir(), `tarp-${identifier.slice(0, 16)}.sock`);
    await new Promise<void>((resolve, reject) => {
      const client = connect(endpoint);
      client.on("error", reject);
      client.on("connect", () => client.end('{"kind":"import","url":42}\n'));
      client.on("data", () => reject(new Error("畸形消息不应获得成功确认")));
      client.on("close", () => resolve());
    });
    assert.equal(opened.length, 2);
  } finally {
    await first.close();
  }
  const reopened = await acquireDesktopInstance(directory, { kind: "activate" }, () => {});
  assert.ok(reopened);
  await reopened.close();
});
