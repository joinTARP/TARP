#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { version } from "../package.json";
import { parseModuleCommand, runModuleCommand } from "./commands";

async function preview(path: string): Promise<number> {
  let executable = process.env.TARP_DESKTOP;
  const args: string[] = [];
  if (!executable) {
    const desktop = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url));
    try {
      const os =
        process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
      const bundle = resolve(desktop, `out/desktop/dev-${os}-${process.arch}`);
      executable =
        process.platform === "darwin"
          ? resolve(bundle, "TARP-dev.app/Contents/MacOS/launcher")
          : resolve(
              bundle,
              "TARP-dev/bin",
              process.platform === "win32" ? "launcher.exe" : "launcher",
            );
      await access(executable);
    } catch {
      throw new Error(
        "预览需要桌面应用。请先构建本仓库的 Electrobun 桌面端，或设置 TARP_DESKTOP 为已安装应用的可执行文件路径。",
      );
    }
  }
  return new Promise<number>((finish, fail) => {
    // Electrobun 原生 launcher 不转发用户参数；预览路径通过进程环境交给宿主再校验。
    const child = spawn(executable!, args, {
      stdio: "inherit",
      env: { ...process.env, TARP_MODULE_PREVIEW: path },
    });
    const stop = () => {
      child.kill();
    };
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", (error) => {
      cleanup();
      fail(error);
    });
    child.once("exit", (code) => {
      cleanup();
      finish(code ?? 1);
    });
  });
}

async function writeOutput(stream: NodeJS.WriteStream, value: string): Promise<void> {
  if (value)
    await new Promise<void>((finish, fail) =>
      stream.write(value, (error) => (error ? fail(error) : finish())),
    );
}

try {
  const parsed = parseModuleCommand(process.argv.slice(2));
  const command = parsed.kind === "desktop" ? { kind: "help" as const } : parsed;
  const result = await runModuleCommand(command, version);
  await writeOutput(process.stdout, result.stdout);
  await writeOutput(process.stderr, result.stderr);
  process.exitCode = result.previewPath ? await preview(result.previewPath) : result.exitCode;
} catch (error) {
  await writeOutput(
    process.stderr,
    `命令执行失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
