import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const scopeIndex = args.indexOf("--scope");
const scopes: Record<string, string[]> = {
  "@jointarp/desktop": ["apps/desktop/src", "apps/desktop/scripts"],
  "@jointarp/core": ["packages/core/src"],
  "@jointarp/module": ["packages/module/src"],
  "@jointarp/module-cli": ["packages/module-cli/src"],
};
const scope = scopeIndex >= 0 ? args.splice(scopeIndex, 2)[1] : undefined;
if (scopeIndex >= 0 && !scope) throw new Error("请指定测试 workspace");
if (scope && !scopes[scope]) throw new Error(`未知测试范围：${scope}`);
// CLI 测试验证实际分发入口；Turbo 按源码和运行环境构建或恢复对应产物。
if (!scope || scope === "@jointarp/module-cli") {
  const build = Bun.spawn(
    [process.execPath, "scripts/tasks.ts", "run", "build", "--filter=./packages/module-cli"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (await build.exited) process.exit(1);
}
const ignored = scope
  ? Object.entries(scopes)
      .filter(([name]) => name !== scope)
      .flatMap(([, paths]) => paths.map((path) => `**/${path}/**`))
  : [];
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--isolate",
    ...ignored.flatMap((path) => ["--path-ignore-patterns", path]),
    ...args,
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
);
process.exit(await child.exited);
