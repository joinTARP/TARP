import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 配置目录隔离实例；第二次启动仅唤醒现有窗口，模组预览路径仍交给原宿主。 */
export async function acquireDesktopInstance(
  directory: string,
  modulePath: string | undefined,
  activate: (path?: string) => void,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identifier = createHash("sha256").update(directory).digest("hex").slice(0, 32);
  const localSocket = join(directory, "desktop.sock");
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tarp-${identifier}`
      : Buffer.byteLength(localSocket) < 104
        ? localSocket
        : join(tmpdir(), `tarp-${identifier.slice(0, 16)}.sock`);
  const notify = () =>
    new Promise<boolean>((resolve, reject) => {
      const client = connect(endpoint);
      client.setTimeout(3000);
      client.once("connect", () => {
        client.end(`${JSON.stringify({ modulePath })}\n`);
      });
      client.once("data", (data) => {
        client.destroy();
        resolve(data.toString() === "ok");
      });
      client.once("error", (error: NodeJS.ErrnoException) => {
        if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? "")) resolve(false);
        else reject(error);
      });
      client.once("end", () => reject(new Error("已有桌面实例未确认唤醒请求")));
      client.once("timeout", () => {
        client.destroy();
        reject(new Error("已有桌面实例暂时没有响应"));
      });
    });
  if (await notify()) return null;
  const server = createServer((socket) => {
    let input = "";
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("data", (data) => {
      input += data.toString();
      if (input.length > 16_384) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      try {
        const value = JSON.parse(input.trim());
        const path = typeof value.modulePath === "string" ? value.modulePath : undefined;
        activate(path);
        socket.end("ok");
      } catch {
        socket.destroy();
      }
    });
  });
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await notify()) return null;
    if (process.platform === "win32") throw error;
    // 无进程响应的 Unix socket 来自异常退出；活跃实例不会走到这里。
    await unlink(endpoint);
    await listen();
  }
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
