import { resolve } from "node:path";

// 平台与实际 Bun 版本参与任务指纹，避免本地和不同 runner 误用缓存。
const child = Bun.spawn(
  [process.execPath, "x", "--no-install", "turbo", ...process.argv.slice(2)],
  {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      TARP_TASK_PLATFORM: `${process.platform}-${process.arch}`,
      TARP_TASK_BUN: Bun.version,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await child.exited);
