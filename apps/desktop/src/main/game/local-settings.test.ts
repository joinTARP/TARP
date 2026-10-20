import { it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalGameSettings } from "./local-settings";

it("身份稳定，同服务商更新覆盖原凭据，模型与密钥由 pi 提供且不回显", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-settings-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const settings = new LocalGameSettings(root);
  const [a, b] = await Promise.all([settings.player(), new LocalGameSettings(root).player()]);
  assert.equal(a.id, b.id);
  const connected = await settings.connect({
    provider: "openai",
    custom: false,
    apiKey: "first-key",
  });
  assert.equal(connected.providers.find((provider) => provider.id === "openai")?.hasKey, true);
  const available = await settings.availableModels();
  const models = available.filter((model) => model.provider === "openai");
  assert.ok(models.length > 1);
  assert.equal((await settings.get()).defaultModel, null);
  await settings.setDefaultModel("openai", models[0].model);
  await settings.setDefaultModel("openai", models[1].model);
  await settings.connect({ provider: "openai", custom: false, apiKey: "second-key" });
  await settings.connect({ provider: "openai", custom: false });
  const saved = await settings.get();
  assert.equal(saved.providers.filter((provider) => provider.id === "openai").length, 1);
  assert.equal(saved.defaultModel?.model, models[1].model);
  assert.equal(JSON.stringify(saved).includes("second-key"), false);
  const auth = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
  assert.equal(auth.openai.key, "second-key");
  assert.equal(
    (await (await settings.modelRuntime()).getAuth("openai"))?.auth.apiKey,
    "second-key",
  );
  const disk = await readFile(join(root, "settings.json"), "utf8");
  assert.ok(!disk.includes("key"));
  assert.ok(!disk.includes("profiles"));
  const reopened = new LocalGameSettings(root);
  assert.equal((await reopened.player()).id, a.id);
  assert.equal((await reopened.get()).defaultModel?.model, models[1].model);
  assert.equal((await reopened.credentialsFor(models[1])).config.model, models[1].model);
  await assert.rejects(settings.connect({ provider: "anthropic", custom: false }));
  await assert.rejects(settings.setDefaultModel("openai", "nonexistent-model"));
  await settings.disconnect("openai");
  assert.equal((await settings.get()).defaultModel?.model, models[1].model);
  assert.ok(!(await settings.availableModels()).some((model) => model.provider === "openai"));
  await assert.rejects(settings.credentialsFor(models[1]));
});

it("自定义服务使用 pi 模型定义，保留其他服务配置，地址变更必须重新提供密钥", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-models-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const settings = new LocalGameSettings(root);
  const input = {
    provider: "test-service",
    custom: true,
    api: "openai-completions" as const,
    baseUrl: "https://first.example/v1",
    model: "test-model",
  };
  const connected = await settings.connect({ ...input, apiKey: "custom-key" });
  assert.equal(
    connected.providers.find((provider) => provider.id === input.provider)?.hasKey,
    true,
  );
  const available = await settings.availableModels();
  const selected = available.find((model) => model.provider === input.provider)!;
  assert.equal(selected.model, input.model);
  const runtime = await settings.modelRuntime();
  assert.equal(runtime.getModel(input.provider, input.model)?.baseUrl, input.baseUrl);
  assert.equal((await runtime.getAuth(input.provider))?.auth.apiKey, "custom-key");
  const path = join(root, "models.json");
  const definitions = JSON.parse(await readFile(path, "utf8"));
  definitions.providers[input.provider].models[0].contextWindow = 64000;
  definitions.providers[input.provider].models[0].reasoning = true;
  definitions.providers.other = {
    api: "openai-responses",
    baseUrl: "https://other.example/v1",
    models: [{ id: "other-model" }],
  };
  await writeFile(path, JSON.stringify(definitions));
  // 单独读取也必须加载人工修改，不能依赖后续连接操作刷新目录。
  assert.equal(
    (await settings.modelRuntime()).getModel(input.provider, input.model)?.contextWindow,
    64000,
  );
  await settings.connect(input);
  assert.equal(
    (await settings.modelRuntime()).getModel(input.provider, input.model)?.contextWindow,
    64000,
  );
  assert.equal(
    (await settings.modelRuntime()).getModel(input.provider, input.model)?.reasoning,
    true,
  );
  await assert.rejects(settings.connect({ ...input, baseUrl: "https://second.example/v1" }));
  const updated = await settings.connect({
    ...input,
    baseUrl: "https://second.example/v1",
    apiKey: "new-key",
  });
  const provider = updated.providers.find((provider) => provider.id === input.provider);
  assert.equal(provider?.baseUrl, "https://second.example/v1");
  assert.equal(provider?.hasKey, true);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.providers[input.provider].baseUrl, "https://second.example/v1");
  assert.deepEqual(stored.providers.other, definitions.providers.other);
  assert.ok(!(await readFile(path, "utf8")).includes("new-key"));
  const disconnected = await settings.disconnect(input.provider);
  assert.ok(!disconnected.providers.some((provider) => provider.id === input.provider));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).providers, {
    other: definitions.providers.other,
  });
  await assert.rejects(settings.credentialsFor(selected));
});

it("桌面连接忽略外部认证环境，保存密钥后可用，断开与重启后不会自动恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-ambient-auth-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const variables = {
    MINIMAX_API_KEY: "external-minimax-key",
    ANTHROPIC_AUTH_TOKEN: "external-anthropic-token",
    AWS_ACCESS_KEY_ID: "external-aws-id",
    AWS_SECRET_ACCESS_KEY: "external-aws-secret",
    CLOUDFLARE_ACCOUNT_ID: "external-cloudflare-account",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  onTestFinished(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const settings = new LocalGameSettings(root);
  assert.deepEqual((await settings.get()).providers, []);
  assert.deepEqual(await settings.availableModels(), []);
  const runtime = await settings.modelRuntime();
  for (const provider of ["minimax", "anthropic", "amazon-bedrock"])
    assert.equal(await runtime.getAuth(provider), undefined);
  await runtime.setRuntimeApiKey("cloudflare-workers-ai", "saved-cloudflare-key");
  assert.equal(await runtime.getAuth("cloudflare-workers-ai"), undefined);
  await runtime.removeRuntimeApiKey("cloudflare-workers-ai");
  await assert.rejects(settings.connect({ provider: "minimax", custom: false }));
  await writeFile(
    join(root, "models.json"),
    JSON.stringify({ providers: { minimax: { baseUrl: "https://example.com/anthropic" } } }),
  );
  await settings.connect({ provider: "minimax", custom: false, apiKey: "saved-minimax-key" });
  const selected = (await settings.availableModels()).find(
    (model) => model.provider === "minimax",
  )!;
  assert.ok(selected);
  assert.equal((await runtime.getAuth("minimax"))?.auth.apiKey, "saved-minimax-key");
  assert.equal(
    runtime.getModel("minimax", selected.model)?.baseUrl,
    "https://example.com/anthropic",
  );
  await settings.setDefaultModel(selected.provider, selected.model);
  const disconnected = await settings.disconnect("minimax");
  assert.deepEqual(disconnected.providers, []);
  assert.equal(disconnected.defaultModel?.model, selected.model);
  assert.deepEqual(await settings.availableModels(), []);
  assert.equal(await runtime.getAuth("minimax"), undefined);
  await assert.rejects(settings.credentialsFor(selected));
  const reopened = new LocalGameSettings(root);
  assert.deepEqual((await reopened.get()).providers, []);
  assert.deepEqual(await reopened.availableModels(), []);
  await reopened.connect({ provider: "minimax", custom: false, apiKey: "reconnected-key" });
  assert.equal(
    (await (await reopened.modelRuntime()).getAuth("minimax"))?.auth.apiKey,
    "reconnected-key",
  );
  assert.equal(process.env.MINIMAX_API_KEY, "external-minimax-key");
});
