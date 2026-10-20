import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const scopeIndex = args.indexOf("--scope");
const scopes: Record<string, string[]> = {
  "@jointarp/desktop": ["apps/desktop/src", "apps/desktop/scripts"],
  "@tarp/core": ["packages/core/src"],
  "@jointarp/module": ["packages/module/src"],
  "@jointarp/module-cli": ["packages/module-cli/src"],
};
const scope = scopeIndex >= 0 ? args.splice(scopeIndex, 2)[1] : undefined;
if (scopeIndex >= 0 && !scope) throw new Error("请指定测试 workspace");
if (scope && !scopes[scope]) throw new Error(`未知测试范围：${scope}`);
// CLI 测试验证实际分发入口，不能依赖此前构建留下的文件。
if (!scope || scope === "@jointarp/module-cli") {
  const build = Bun.spawn([process.execPath, "run", "--filter", "@jointarp/module-cli", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
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
