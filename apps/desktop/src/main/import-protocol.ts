import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function windowsProtocolCommand(launcher: string): string {
  if (/["\r\n\u0000]/u.test(launcher)) throw new Error("应用启动路径无效。");
  return `"${launcher}" "%1"`;
}

/** 仅由正式版 GUI 调用；首次运行与升级后均修正用户级注册。 */
export async function registerImportProtocol(channel: string): Promise<void> {
  if (channel !== "stable" || process.platform !== "win32") return;
  const launcher = join(dirname(process.execPath), "launcher.exe");
  await access(launcher);
  const key = "HKCU\\Software\\Classes\\tarp";
  for (const [subkey, args] of [
    [key, ["/ve", "/d", "URL:TARP 模组导入"]],
    [key, ["/v", "URL Protocol", "/d", ""]],
    [`${key}\\shell\\open\\command`, ["/ve", "/d", windowsProtocolCommand(launcher)]],
  ] as const) {
    await execute("reg.exe", ["add", subkey, ...args, "/f"], {
      timeout: 10_000,
      windowsHide: true,
    });
  }
}
