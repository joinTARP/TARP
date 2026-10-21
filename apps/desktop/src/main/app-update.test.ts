import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { AppUpdateService, createAcceleratedUpdater } from "./app-update";

function fixture() {
  let listener: Parameters<ConstructorParameters<typeof AppUpdateService>[0]["onStatusChange"]>[0];
  const local = {
    channel: "stable",
    version: "0.1.0",
    identifier: "test",
    name: "TARP",
    hash: "old",
    baseUrl: "https://example.test",
  };
  const info = {
    version: "0.2.0",
    hash: "new",
    updateAvailable: true,
    updateReady: false,
    error: "",
  };
  let confirmed = false;
  let applied = 0;
  let checks = 0;
  let finishDownload: () => void = () => {};
  const downloaded = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  const runtime: ConstructorParameters<typeof AppUpdateService>[0] = {
    getLocalInfo: async () => local,
    checkForUpdate: async () => {
      checks++;
      return info;
    },
    updateInfo: () => info,
    onStatusChange: (callback) => {
      listener = callback;
    },
    downloadUpdate: () => downloaded,
    applyUpdate: async () => {
      applied++;
    },
  };
  const service = new AppUpdateService(runtime, local.version, async () => confirmed);
  return {
    service,
    runtime,
    local,
    info,
    finishDownload,
    confirm: () => {
      confirmed = true;
    },
    applied: () => applied,
    checks: () => checks,
    progress: (value: number) =>
      listener?.({
        status: "download-progress",
        message: "",
        timestamp: 0,
        details: { progress: value },
      }),
  };
}

test("下载期间不重新检查或安装，准备完成后取消重启不会退出，确认后才安装", async () => {
  const f = fixture();
  assert.equal((await f.service.check()).state, "available");
  assert.equal(f.applied(), 0);
  const downloading = f.service.download();
  assert.equal(f.service.get().state, "downloading");
  f.progress(42);
  assert.equal(f.service.get().progress, 42);
  await f.service.check();
  assert.equal(f.checks(), 1);
  await assert.rejects(f.service.restart(), /尚未准备完成/);
  f.info.updateReady = true;
  f.finishDownload();
  assert.equal((await downloading).state, "ready");
  assert.equal((await f.service.restart()).state, "ready");
  assert.equal(f.applied(), 0);
  f.confirm();
  await f.service.restart();
  assert.equal(f.applied(), 1);
});

test("检查从加速线路开始，错误返回和异常均换源；下载沿用可用线路，归档失败后直连", async () => {
  const f = fixture();
  const checks: string[] = [];
  const downloads: string[] = [];
  f.runtime.checkForUpdate = async () => {
    const { baseUrl } = await f.runtime.getLocalInfo();
    checks.push(baseUrl);
    f.info.error = baseUrl.startsWith("https://gh-proxy.com/")
      ? "update.json is not valid JSON"
      : "";
    return f.info;
  };
  f.runtime.downloadUpdate = async () => {
    const { baseUrl } = await f.runtime.getLocalInfo();
    downloads.push(baseUrl);
    if (baseUrl.startsWith("https://ghfast.top/")) throw new Error("归档下载中断");
    f.info.error = "";
    f.info.updateReady = true;
  };
  const accelerated = createAcceleratedUpdater(f.runtime);
  const service = new AppUpdateService(accelerated, f.local.version, async () => false);
  assert.equal((await service.check()).state, "available");
  assert.deepEqual(checks, [
    "https://gh-proxy.com/https://github.com/joinTARP/TARP/releases/latest/download",
    "https://ghfast.top/https://github.com/joinTARP/TARP/releases/latest/download",
  ]);
  assert.equal((await service.download()).state, "ready");
  assert.deepEqual(downloads, [
    checks[1]!,
    "https://github.com/joinTARP/TARP/releases/latest/download",
  ]);
  assert.equal(f.local.baseUrl, "https://example.test");
});

test("全部线路失败显示可重试错误，下轮检查重新优先加速；框架返回下载错误也会继续换源", async () => {
  const f = fixture();
  const hosts: string[] = [];
  let offline = true;
  f.runtime.checkForUpdate = async () => {
    hosts.push(new URL((await f.runtime.getLocalInfo()).baseUrl).hostname);
    if (offline) throw new Error("网络超时");
    f.info.error = "";
    return f.info;
  };
  f.runtime.downloadUpdate = async () => {
    const host = new URL((await f.runtime.getLocalInfo()).baseUrl).hostname;
    hosts.push(host);
    f.info.error = host === "github.com" ? "" : "HTTP 503";
    f.info.updateReady = host === "github.com";
  };
  const service = new AppUpdateService(
    createAcceleratedUpdater(f.runtime),
    f.local.version,
    async () => false,
  );
  const failed = await service.check();
  assert.equal(failed.state, "error");
  assert.match(failed.error!, /GH-Proxy.*GHFast.*GitHub/);
  assert.deepEqual(hosts, ["gh-proxy.com", "ghfast.top", "github.com"]);
  offline = false;
  assert.equal((await service.check()).state, "available");
  assert.equal(hosts.at(-1), "gh-proxy.com");
  assert.equal((await service.download()).state, "ready");
  assert.deepEqual(hosts.slice(-3), ["gh-proxy.com", "ghfast.top", "github.com"]);
});

test("框架通过返回值报告检查或下载错误时允许重试，不把失败当作已准备好", async () => {
  const f = fixture();
  f.info.error = "HTTP 503";
  assert.equal((await f.service.check()).error, "HTTP 503");
  f.info.error = "";
  assert.equal((await f.service.check()).state, "available");
  f.info.error = "下载中断";
  f.finishDownload();
  assert.equal((await f.service.download()).state, "error");
  assert.equal(f.service.get().error, "下载中断");
  assert.equal(f.applied(), 0);
  f.info.error = "";
  await f.service.check();
  assert.equal((await f.service.download()).state, "error");
  assert.match(f.service.get().error!, /尚未准备完成/);
});

test("开发通道和预发布不请求更新，同版本、旧版本及远端预发布不会触发安装", async () => {
  for (const local of [
    { channel: "dev", version: "0.1.0" },
    { channel: "stable", version: "0.2.0-beta.1" },
  ]) {
    const f = fixture();
    Object.assign(f.local, local);
    assert.equal((await f.service.check()).state, "disabled");
    assert.equal(f.checks(), 0);
  }
  for (const version of ["0.1.0", "0.0.9", "0.2.0-beta.1"]) {
    const f = fixture();
    f.info.version = version;
    assert.equal((await f.service.check()).state, "current");
    await assert.rejects(f.service.download(), /检查可用更新/);
  }
  const f = fixture();
  f.local.version = "0.2.9";
  f.info.version = "0.10.0";
  assert.equal((await f.service.check()).state, "available");
});
