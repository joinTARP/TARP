import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createTestModule } from "../../packages/module/src/testing/test-module";

const execute = promisify(execFile);
const product = process.argv[2];
assert.ok(product === "cli" || product === "desktop", "请选择 cli 或 desktop");
const manifestPath = product === "cli" ? "packages/module-cli" : "apps/desktop";
const manifest = JSON.parse(await readFile(join(manifestPath, "package.json"), "utf8"));
const fixture = await createTestModule();
try {
  let executable: string;
  let prefix: string[] = [];
  let desktopApp: string | undefined;
  if (product === "cli") {
    await writeFile(
      join(fixture.modulePath, ".types/分发校验.fields.toml"),
      '[fields.note]\ntype = "text"\nrequired = true\n',
    );
    await mkdir(join(fixture.modulePath, "分发校验"));
    await writeFile(join(fixture.modulePath, "分发校验/TOML.toml"), 'note = "TOML"\n');
    await writeFile(
      join(fixture.modulePath, "分发校验/Markdown.md"),
      "---\nnote: Markdown\n---\n分发包解析校验。\n",
    );
    const installation = join(fixture.root, "installation");
    await mkdir(installation);
    await writeFile(
      join(installation, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          [manifest.name]: `file:${resolve(manifestPath, "out/tarp-module-cli.tgz")}`,
        },
      }),
    );
    await execute("bun", ["install", "--cwd", installation, "--production"], { timeout: 120_000 });
    const installed = join(installation, "node_modules", manifest.name);
    const packageJson = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(packageJson.version, manifest.version);
    assert.ok(
      Object.values(packageJson.dependencies).every(
        (value) => !String(value).startsWith("workspace:"),
      ),
    );
    await Promise.all(["LICENSE", "NOTICE.md"].map((file) => readFile(join(installed, file))));
    const installedRequire = createRequire(await realpath(join(installed, "index.js")));
    for (const dependency of Object.keys(packageJson.dependencies)) {
      let directory = dirname(installedRequire.resolve(dependency));
      for (;;) {
        const source = await readFile(join(directory, "package.json"), "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (source && JSON.parse(source).name === dependency) {
          assert.ok((await readFile(join(directory, "LICENSE"), "utf8")).trim(), dependency);
          break;
        }
        const parent = dirname(directory);
        assert.notEqual(parent, directory, `找不到已安装依赖的许可文件：${dependency}`);
        directory = parent;
      }
    }
    console.log("cli 运行依赖与许可文件验收通过。");
    executable = process.execPath;
    prefix = [join(installed, "index.js")];
  } else {
    const os =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
    const channel = process.env.TARP_SMOKE_CHANNEL ?? "stable";
    const appName = channel === "stable" ? "TARP" : `TARP-${channel}`;
    let directory = resolve(`apps/desktop/out/desktop/${channel}-${os}-${process.arch}`);
    if (channel !== "dev") {
      const artifacts = resolve("apps/desktop/release");
      const metadata = JSON.parse(
        await readFile(join(artifacts, `${channel}-${os}-${process.arch}-update.json`), "utf8"),
      );
      const filename = metadata.artifact.file;
      assert.equal(
        filename,
        `${channel}-${os}-${process.arch}-${appName}${os === "macos" ? ".app" : ""}.tar.zst`,
      );
      directory = join(fixture.root, "desktop-payload");
      await mkdir(directory);
      const archive = Bun.zstdDecompressSync(await readFile(join(artifacts, filename)));
      await new Bun.Archive(archive).extract(directory);
    }
    const bundle =
      process.platform === "darwin"
        ? join(directory, `${appName}.app/Contents`)
        : join(directory, appName);
    if (process.platform === "darwin" && channel !== "dev") {
      await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", dirname(bundle)]);
      console.log("macOS 更新归档中的应用签名验收通过。");
    }
    const bin = join(bundle, process.platform === "darwin" ? "MacOS" : "bin");
    desktopApp = join(bundle, "Resources/app");
    executable = join(bin, process.platform === "win32" ? "bun.exe" : "bun");
    prefix = [join(desktopApp, "bun/index.js")];
  }
  const options = {
    cwd: fixture.root,
    env: { ...process.env, TARP_HOME: join(fixture.root, "config") },
    timeout: 30_000,
  };
  const runtimes =
    product === "cli" ? [process.env.TARP_CLI_NODE ?? "node", executable] : [executable];
  for (const runtime of runtimes) {
    const run = (args: string[]) => execute(runtime, [...prefix, ...args], options);
    if (product === "desktop") {
      assert.ok(desktopApp);
      await Promise.all(["LICENSE", "NOTICE.md"].map((file) => readFile(join(desktopApp!, file))));
      const result = await execute(
        executable,
        [join(desktopApp, "smoke.js"), join(fixture.root, "sqlite-probe.sqlite")],
        options,
      );
      console.log(result.stdout.trim());
    }
    assert.equal((await run(["--version"])).stdout.trim(), `TARP ${manifest.version}`);
    assert.match((await run(["--help"])).stdout, /TARP 模组开发工具/);
    const report = JSON.parse((await run(["module", "validate", "./module", "--json"])).stdout);
    assert.equal(report.status, "success");
    assert.equal(report.appVersion, manifest.version);
    assert.deepEqual(report.issues, []);
    await assert.rejects(run(["module", "validate", "--json"]), (error: unknown) => {
      const result = error as { code: number; stdout: string };
      assert.equal(result.code, 2);
      assert.equal(JSON.parse(result.stdout).status, "error");
      return true;
    });
    console.log(
      `${product}（${runtime}）分发产物验收通过：版本、帮助、独立模组加载、计算与退出码。`,
    );
  }
} finally {
  await fixture.cleanup();
}
