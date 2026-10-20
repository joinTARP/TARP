import { describe, it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalGameSettings } from "../game/local-settings";
import { TtsService } from "../tts/service";
import {
  AppConfigError,
  readAppConfig,
  resolveAppConfigLocation,
  resolveModulesPath,
  updateAppConfig,
} from "./app-config";

describe("应用配置路径", () => {
  it("配置跟随指定主目录", () => {
    for (const homeDir of [join(tmpdir(), "tarp-home"), "C:\\Users\\asen"]) {
      const location = resolveAppConfigLocation({ homeDir });
      assert.equal(location.directory, join(homeDir, ".tarp"));
      assert.equal(location.filePath, join(homeDir, ".tarp", "settings.json"));
    }
  });

  it("未配置时使用默认模组路径，~ 会展开为主目录", () => {
    const documentsDir = join("/Users/asen", "Documents");
    const homeDir = "/Users/asen";
    assert.equal(
      resolveModulesPath({}, { documentsDir, homeDir }),
      join(documentsDir, "tarp", "modules"),
    );
    assert.equal(
      resolveModulesPath({ modulesPath: "~/campaigns" }, { documentsDir, homeDir }),
      join(homeDir, "campaigns"),
    );
  });
});

describe("应用配置读写", () => {
  it("应用与语音设置并发保存不互相覆盖，AI 凭据由 pi 独立保存", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tarp-unified-config-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "settings.json");
    assert.deepEqual(await readAppConfig(filePath), {});
    const game = new LocalGameSettings(directory);
    const tts = new TtsService(directory);
    onTestFinished(() => tts.close());
    const voice = (await tts.get()).config;
    await Promise.all([
      updateAppConfig(filePath, { theme: "light" }),
      game.connect({ provider: "openai", custom: false, apiKey: "ai-private-fixture" }),
      tts.save({
        config: voice,
        automatic: true,
        apiKey: "tts-private-fixture",
      }),
    ]);
    const stored = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(stored.app.theme, "light");
    assert.equal(
      JSON.parse(await readFile(join(directory, "auth.json"), "utf8")).openai.key,
      "ai-private-fixture",
    );
    assert.ok(!JSON.stringify(stored).includes("ai-private-fixture"));
    assert.equal(stored.tts.connections[0].apiKey, "tts-private-fixture");
    assert.deepEqual((await readdir(directory)).sort(), ["auth.json", "settings.json"]);
    assert.deepEqual(await readAppConfig(filePath), { theme: "light" });
    assert.deepEqual(await updateAppConfig(filePath, { theme: "dark" }), { theme: "dark" });
    const updated = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(updated.game, stored.game);
    assert.deepEqual(updated.tts, stored.tts);
  });

  it("并发保存不同字段时重新读取最新配置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tarp-config-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "settings.json");
    await writeFile(filePath, '{"app":{"theme":"light"}}');
    await Promise.all([
      updateAppConfig(filePath, { theme: "dark" }),
      updateAppConfig(filePath, { modulesPath: "~/modules" }),
    ]);
    assert.deepEqual(await readAppConfig(filePath), {
      theme: "dark",
      modulesPath: "~/modules",
    });
    assert.deepEqual(await readdir(directory), ["settings.json"]);
  });

  for (const [name, source, detail] of [
    ["JSON 语法损坏", '{"private":"private-fixture-content","app":', "JSON 格式无效"],
    ["TOML 内容", '[app]\ntheme = "light"', "JSON 格式无效"],
    ["主题不合法", '{"app":{"theme":"invalid"}}', "app.theme"],
    ["路径类型错误", '{"app":{"modulesPath":123,"theme":"light"}}', "app.modulesPath"],
  ]) {
    it(`${name}时拒绝读取和保存，保留原文件并提供修复提示`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "tarp-config-"));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const filePath = join(directory, "settings.json");
      await writeFile(filePath, source, "utf8");
      const checkError = (error: unknown) => {
        assert(error instanceof AppConfigError);
        assert(error.message.includes(filePath));
        assert(error.message.includes(detail));
        assert(error.message.includes("原文件已保留"));
        assert(error.message.includes("备份"));
        assert(!error.message.includes("private-fixture-content"));
        return true;
      };
      await assert.rejects(readAppConfig(filePath), checkError);
      await assert.rejects(updateAppConfig(filePath, { theme: "dark" }), checkError);
      assert.equal(await readFile(filePath, "utf8"), source);
      assert.deepEqual(await readdir(directory), ["settings.json"]);
      // 用户修复文件后可以直接重试，无需清除缓存或生成恢复副本。
      await writeFile(filePath, '{"app":{"theme":"light"}}', "utf8");
      const saved = await updateAppConfig(filePath, { modulesPath: join(directory, "modules") });
      assert.equal(saved.theme, "light");
    });
  }

  it("无效的新设置拒绝保存，原有合法配置保持原样", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tarp-config-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "settings.json");
    const source = '{"app":{"theme":"light"}}';
    await writeFile(filePath, source, "utf8");
    await assert.rejects(updateAppConfig(filePath, { theme: "invalid" } as never));
    assert.equal(await readFile(filePath, "utf8"), source);
  });
});
