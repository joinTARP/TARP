import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeTestFile as writeFile } from "@tarp/module/testing/files";
import { createTestModule } from "@tarp/module/testing/test-module";

import { version } from "../package.json";
import { modulePreviewHash, parseModuleCommand, runModuleCommand } from "./commands";

test("开发 Agent 获得版本化 JSON 校验结果，计算与开局正常且不改写工作区", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  await writeFile(
    join(f.modulePath, ".types/地点.fields.json"),
    JSON.stringify({ fields: { target: { type: "reference", targets: ["地点"] } } }),
  );
  const locationPath = join(f.modulePath, "地点/集合点.json");
  const location = JSON.parse(await readFile(locationPath, "utf8"));
  await writeFile(locationPath, JSON.stringify({ ...location, target: "地点/集合点.json" }));
  const metadataBefore = await readFile(join(f.modulePath, "module.json"), "utf8");
  const characterBefore = await readFile(join(f.modulePath, "角色/向导.json"), "utf8");
  const rootBefore = await readdir(f.root);
  const parsed = parseModuleCommand(["module", "validate", "./module", "--json"], f.root);
  assert.equal(parsed.kind, "validate");
  if (parsed.kind !== "validate") return;
  const result = await runModuleCommand(parsed, "0.1.0");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.appVersion, "0.1.0");
  assert.equal(report.path, f.modulePath);
  assert.equal(report.status, "success");
  assert.equal(report.name, "平台测试模组");
  assert.ok(report.documentCount > 0);
  assert.equal(report.pageCount, 1);
  assert.deepEqual(report.issues, []);
  assert.equal(await readFile(join(f.modulePath, "module.json"), "utf8"), metadataBefore);
  assert.equal(await readFile(join(f.modulePath, "角色/向导.json"), "utf8"), characterBefore);
  assert.deepEqual(await readdir(f.root), rootBefore);
  const human = await runModuleCommand({ ...parsed, json: false }, "0.1.0");
  assert.match(human.stdout, /校验通过：平台测试模组/);
});

test("校验一次返回文档、引用、计算、阅读页和开局错误，退出码便于 Agent 判断失败", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  await writeFile(
    join(f.modulePath, ".types/地点.fields.json"),
    JSON.stringify({ fields: { target: { type: "reference", targets: ["地点"] } } }),
  );
  await writeFile(join(f.modulePath, "地点/集合点.json"), JSON.stringify({ target: "角色/向导" }));
  await writeFile(join(f.modulePath, "地点/失效.json"), JSON.stringify({ target: "地点/不存在" }));
  await writeFile(join(f.modulePath, "地点/正常.json"), "{}");
  await writeFile(
    join(f.modulePath, "地点/公式覆盖.json"),
    JSON.stringify({
      target: "地点/被覆盖的缺失.json",
      computed: { target: '"地点/正常.json"' },
    }),
  );
  await writeFile(join(f.modulePath, "地点/损坏.json"), JSON.stringify({ target: 3 }));
  await writeFile(
    join(f.modulePath, ".types/规则.fields.json"),
    JSON.stringify({ fields: { derived: { type: "number", compute: "globalThis.missing()" } } }),
  );
  const metadata = JSON.parse(await readFile(join(f.modulePath, "module.json"), "utf8"));
  metadata.pages = ["不存在.md"];
  metadata.gameStarts[0].playablePaths = ["角色/不存在"];
  await writeFile(join(f.modulePath, "module.json"), JSON.stringify(metadata));
  const result = await runModuleCommand(
    { kind: "validate", path: f.modulePath, json: true },
    "0.1.0",
  );
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "error");
  for (const kind of ["document", "reference", "page", "launch"])
    assert.ok(
      report.issues.some((issue: { kind: string }) => issue.kind === kind),
      kind,
    );
  for (const path of [
    "地点/集合点.json",
    "地点/失效.json",
    "地点/损坏.json",
    "规则/测试约定.md",
    "不存在.md",
  ])
    assert.ok(
      report.issues.some((issue: { path: string }) => issue.path === path),
      path,
    );
  assert.ok(
    report.issues.some((issue: { message: string }) => issue.message.includes("预设角色不存在")),
  );
  assert.ok(
    report.issues.some(
      (issue: { kind: string; path: string; message: string }) =>
        issue.kind === "reference" &&
        issue.path === "地点/公式覆盖.json" &&
        issue.message.includes("被覆盖的缺失"),
    ),
    "计算覆盖不能掩盖原始文档中的无效引用",
  );
});

test("缺少配置返回可解析的错误，参数错误与模组错误使用不同退出码", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const result = await runModuleCommand({ kind: "validate", path: f.root, json: true }, "0.1.0");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).issues.map((issue: { kind: string }) => issue.kind),
    ["metadata", "types"],
  );
  for (const args of [
    ["module", "validate", "--json"],
    ["module", "preview", f.modulePath, "--json"],
    ["module", "validate", f.modulePath, "--unknown", "--json"],
  ]) {
    const command = parseModuleCommand(args);
    assert.equal(command.kind, "error");
    if (command.kind !== "error") continue;
    const result = await runModuleCommand(command, "0.1.0");
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "error");
  }
});

test("预览直接打开工作区，允许查看待修复文档，拒绝无效模组根目录", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  await writeFile(join(f.modulePath, "角色/向导.json"), "{invalid}");
  const command = parseModuleCommand(["module", "preview", "./module"], f.root);
  assert.equal(command.kind, "preview");
  if (command.kind !== "preview") return;
  const result = await runModuleCommand(command, "0.1.0");
  assert.equal(result.exitCode, 0);
  assert.equal(result.previewPath, f.modulePath);
  const hash = modulePreviewHash(`${f.modulePath}/中文 ?#&`);
  assert.equal(
    new URL(hash, "https://localhost").searchParams.get("path"),
    `${f.modulePath}/中文 ?#&`,
  );
  const invalid = await runModuleCommand({ kind: "preview", path: f.root }, "0.1.0");
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.previewPath, undefined);
  assert.match(invalid.stderr, /无法预览模组/);
});

test.each([
  ["Node.js", process.env.TARP_CLI_NODE ?? "node"],
  ["Bun", process.execPath],
])("%s CLI 使用调用目录校验模组，版本与参数错误无需启动桌面应用", async (_runtime, executable) => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const execute = promisify(execFile);
  const entry = join(import.meta.dirname, "../out/index.js");
  const options = { cwd: f.root, env: { ...process.env, TARP_DESKTOP: "不存在的桌面应用" } };
  const result = await execute(
    executable,
    [entry, "module", "validate", "./module", "--json"],
    options,
  );
  assert.equal(await realpath(JSON.parse(result.stdout).path), await realpath(f.modulePath));
  assert.equal(JSON.parse(result.stdout).status, "success");
  assert.equal(
    (await execute(executable, [entry, "--version"], options)).stdout.trim(),
    `TARP ${version}`,
  );
  try {
    await execute(executable, [entry, "module", "validate", "--json"], options);
    assert.fail("无效参数应失败");
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).status, "error");
    assert.equal(result.stderr, "");
  }

  const extraWorld = join(f.modulePath, "世界状态/状态/另一世界.json");
  await writeFile(extraWorld, '{"scenes":[]}');
  const multipleWorlds = await execute(
    executable,
    [entry, "module", "validate", "./module", "--json"],
    options,
  );
  assert.equal(JSON.parse(multipleWorlds.stdout).status, "success");
  await rm(extraWorld);

  await writeFile(
    join(f.modulePath, ".types/规则.fields.json"),
    JSON.stringify({
      fields: {
        derived: { type: "number", compute: '(() => { throw new Error("公式执行失败"); })()' },
      },
    }),
  );
  await assert.rejects(
    execute(executable, [entry, "module", "validate", "./module", "--json"], {
      ...options,
      timeout: 5_000,
    }),
    (error: unknown) => {
      const result = error as Error & { code: number; stdout: string };
      assert.equal(result.code, 1);
      assert.ok(
        JSON.parse(result.stdout).issues.some(
          (issue: { kind: string }) => issue.kind === "document",
        ),
      );
      return true;
    },
  );
});
