import { parseModuleCommand, runModuleCommand } from "@tarp/module-cli/commands";

import manifest from "../../package.json";

async function launchDesktop(path?: string): Promise<void> {
  try {
    const { startDesktop } = await import("./desktop");
    await startDesktop(path);
  } catch (error) {
    console.error("桌面端启动失败", error);
    const { Utils } = await import("electrobun/main");
    await Utils.showMessageBox({
      type: "error",
      title: "无法启动 TARP",
      message: error instanceof Error ? error.message : String(error),
    });
    Utils.quit(1);
  }
}

const command = parseModuleCommand(
  process.env.TARP_MODULE_PREVIEW
    ? ["module", "preview", process.env.TARP_MODULE_PREVIEW]
    : process.argv.slice(2),
);
if (command.kind === "desktop") {
  await launchDesktop();
} else {
  try {
    const result = await runModuleCommand(command, manifest.version);
    if (result.stdout) await Bun.write(Bun.stdout, result.stdout);
    if (result.stderr) await Bun.write(Bun.stderr, result.stderr);
    if (result.previewPath) {
      await launchDesktop(result.previewPath);
    } else process.exit(result.exitCode);
  } catch (error) {
    console.error(`命令执行失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
