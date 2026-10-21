import { it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthCredential, OAuthAuth } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { waitFor } from "@jointarp/module/testing/async";

import { LocalGameSettings } from "./local-settings";
import { SubscriptionAuth } from "./subscription-auth";

const credential: OAuthCredential = {
  type: "oauth",
  access: "secret-access",
  refresh: "secret-refresh",
  expires: Date.now() + 3600000,
};

it("订阅登录由 pi 持久化和刷新，保留其他服务商密钥，退出后模型即时不可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "subscription-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const settings = new LocalGameSettings(root);
  await settings.connect({ provider: "openai", custom: false, apiKey: "api-fixture" });
  const runtime = await settings.modelRuntime();
  let refreshes = 0;
  runtime.registerNativeProvider({
    ...openaiCodexProvider(),
    auth: {
      oauth: {
        name: "test",
        isSubscription: true,
        login: async () => credential,
        refresh: async (value) => {
          refreshes++;
          return { ...value, access: "refreshed", expires: Date.now() + 3600000 };
        },
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
  });
  const auth = new SubscriptionAuth(
    async () => runtime,
    async () => {},
  );
  const started = await auth.start("browser");
  await waitFor(async () => {
    const status = await auth.status();
    assert.equal(status.status, "success");
    assert.equal(status.connected, true);
  });
  const path = join(root, "auth.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.openai.key, "api-fixture");
  saved["openai-codex"].expires = 0;
  await writeFile(path, JSON.stringify(saved));
  await Promise.all([1, 2, 3].map(() => runtime.getAuth("openai-codex")));
  assert.equal(refreshes, 1);
  const available = (await settings.availableModels()).filter(
    (model) => model.provider === "openai-codex",
  );
  assert.ok(available.length > 0);
  assert.equal((await settings.credentialsFor(available[0])).config.provider, "openai-codex");
  assert.ok(!JSON.stringify(await settings.get()).includes("secret"));
  assert.ok(!JSON.stringify(await auth.status()).includes("secret"));
  await auth.cancel(started.id);
  await auth.logout();
  assert.equal((await auth.status()).connected, false);
  assert.ok(!(await settings.availableModels()).some((model) => model.provider === "openai-codex"));
  await assert.rejects(settings.credentialsFor(available[0]));
  assert.equal(JSON.parse(await readFile(path, "utf8")).openai.key, "api-fixture");
});

it("浏览器登录桥接回调输入，取消后 pi 不保存凭据，状态不暴露令牌", async () => {
  const root = await mkdtemp(join(tmpdir(), "subscription-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const urls: string[] = [];
  const oauth: OAuthAuth = {
    name: "test",
    async login(interaction) {
      assert.equal(
        await interaction.prompt({ type: "select", message: "method", options: [] }),
        "browser",
      );
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize" });
      await interaction.prompt({
        type: "manual_code",
        message: "callback",
        signal: interaction.signal,
      });
      return credential;
    },
    refresh: async (value) => value,
    toAuth: async (value) => ({ apiKey: value.access }),
  };
  const settings = new LocalGameSettings(root);
  const runtime = await settings.modelRuntime();
  runtime.registerNativeProvider({ ...openaiCodexProvider(), auth: { oauth } });
  const auth = new SubscriptionAuth(
    async () => runtime,
    async (url) => {
      urls.push(url);
    },
  );
  const first = await auth.start("browser");
  await auth.cancel(first.id);
  assert.equal((await auth.status()).connected, false);
  const second = await auth.start("browser");
  await waitFor(async () => assert.equal((await auth.status()).manual, true));
  auth.submit(second.id, "callback");
  await waitFor(async () => assert.equal((await auth.status()).connected, true));
  assert.equal(JSON.stringify(await auth.status()).includes("secret-access"), false);
  assert.equal(urls.length, 2);
  await auth.logout();
  assert.equal((await auth.status()).connected, false);
});

it("打包后的真实订阅认证可打开浏览器并获取设备码，取消后不保存凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "subscription-bundle-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "entry.ts");
  await writeFile(
    entry,
    `
import { strict as assert } from "node:assert";
import { LocalGameSettings } from ${JSON.stringify(join(import.meta.dirname, "local-settings.ts"))};
import { SubscriptionAuth } from ${JSON.stringify(join(import.meta.dirname, "subscription-auth.ts"))};

const urls = [];
const requests = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push(url);
  if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
    return Response.json({ device_auth_id: "fixture", user_code: "TEST-CODE", interval: 0 });
  }
  assert.equal(url, "https://auth.openai.com/api/accounts/deviceauth/token");
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("cancelled"));
    init.signal.addEventListener("abort", abort, { once: true });
    if (init.signal.aborted) abort();
  });
};
const settings = new LocalGameSettings(process.argv[2]);
const auth = new SubscriptionAuth(() => settings.modelRuntime(), async (url) => { urls.push(url); });
async function ready(check) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = await auth.status();
    assert.notEqual(status.status, "error", status.message);
    if (check(status)) return;
    assert.ok(Date.now() < deadline, "未收到登录步骤");
    await Bun.sleep(10);
  }
}
try {
  await auth.start("browser");
  await ready((status) => status.manual && urls.length === 1);
  assert.equal(new URL(urls[0]).pathname, "/oauth/authorize");
  await auth.cancel();
  await auth.start("device_code");
  await ready((status) => status.userCode === "TEST-CODE" && urls.length === 2);
  assert.equal(urls[1], "https://auth.openai.com/codex/device");
  assert.ok(requests.includes("https://auth.openai.com/api/accounts/deviceauth/usercode"));
} finally {
  await auth.cancel();
}
assert.equal((await auth.status()).connected, false);
`,
  );
  const build = await Bun.build({ entrypoints: [entry], outdir: root, target: "bun" });
  assert.equal(build.success, true, build.logs.map(String).join("\n"));
  const child = Bun.spawn([process.execPath, join(root, "entry.js"), join(root, "settings")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill());
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
}, 20_000);
