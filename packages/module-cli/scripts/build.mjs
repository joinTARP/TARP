import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const output = new URL("../out/", import.meta.url);
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outdir: fileURLToPath(output),
  target: "node",
  minify: true,
  // 仅打包 TARP workspace 源码；第三方库由发布清单声明并在安装时提供。
  external: Object.keys(source.dependencies),
});
if (!result.success) throw new AggregateError(result.logs, "CLI 构建失败");
const manifest = {
  name: source.name,
  homepage: source.homepage,
  version: source.version,
  description: "TARP 模组开发 CLI，提供模组校验和桌面预览入口。",
  license: source.license,
  type: "module",
  bin: { tarp: "./index.js" },
  files: ["index.js", "NOTICE.md"],
  dependencies: source.dependencies,
  engines: source.engines,
  publishConfig: { access: "public" },
};

await writeFile(new URL("package.json", output), `${JSON.stringify(manifest, null, 2)}\n`);
await Promise.all([
  writeFile(
    new URL("README.md", output),
    (await readFile(new URL("../README.md", import.meta.url), "utf8"))
      .replaceAll("../../LICENSE", "./LICENSE")
      .replaceAll("../../NOTICE.md", "./NOTICE.md"),
  ),
  copyFile(new URL("../../../LICENSE", import.meta.url), new URL("LICENSE", output)),
  copyFile(new URL("../../../NOTICE.md", import.meta.url), new URL("NOTICE.md", output)),
]);
