import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { roomResources } from "@tarp/core/node/agent/pi-runtime";
import {
  defaultHostSystemPrompt,
  hostInputInstructions,
} from "@tarp/core/shared/host-system-prompt";
import { narrativeInstructions } from "@tarp/core/shared/narrative";

import { readAppConfig, updateAppConfig } from "../config/app-config";
import { readGameDefaults, updateGameDefaults } from "../config/app-settings";

test("保存自定义主持指令后替换默认内容，保留模组提示、房间上下文与叙事协议", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tarp-system-prompt-"));
  const configPath = join(directory, "settings.json");
  try {
    await updateAppConfig(configPath, { theme: "light", modulesPath: "/modules" });
    await updateGameDefaults(configPath, {
      hostSystemPrompt: "用简短的文字主持。\n先询问，再推进。",
    });
    const saved = await readGameDefaults(configPath);
    const resources = roomResources(
      "/room/game",
      "资料索引",
      "模组专用指令",
      saved.hostSystemPrompt,
    );
    const prompt = resources.getSystemPrompt()!;
    assert.ok(prompt.startsWith(saved.hostSystemPrompt!));
    assert.ok(!prompt.includes(defaultHostSystemPrompt));
    assert.ok(prompt.includes("/room/game"));
    assert.ok(prompt.includes("资料索引"));
    assert.ok(resources.getAppendSystemPrompt().includes(narrativeInstructions));
    assert.ok(resources.getAppendSystemPrompt().includes(hostInputInstructions));
    assert.equal(saved.hostSystemPrompt, "用简短的文字主持。\n先询问，再推进。");
    // 主持守则与文风均属于可编辑正文，不绕过编辑器固定追加。
    const appended = resources.getAppendSystemPrompt().join("\n");
    assert.ok(!appended.includes(defaultHostSystemPrompt));
    assert.ok(resources.getAppendSystemPrompt().some((part) => part.includes("模组专用指令")));

    for (const hostSystemPrompt of ["  ", "字".repeat(30001)])
      await assert.rejects(updateGameDefaults(configPath, { hostSystemPrompt }));
    assert.equal((await readGameDefaults(configPath)).hostSystemPrompt, saved.hostSystemPrompt);
    await updateGameDefaults(configPath, { hostSystemPrompt: null });
    const reset = await readGameDefaults(configPath);
    assert.equal(reset.hostSystemPrompt, null);
    assert.equal((await readAppConfig(configPath)).theme, "light");
    assert.equal((await readAppConfig(configPath)).modulesPath, "/modules");
    assert.ok(
      roomResources("/room/game", "", "", reset.hostSystemPrompt)
        .getSystemPrompt()!
        .startsWith(defaultHostSystemPrompt),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
