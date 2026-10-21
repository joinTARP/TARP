# 模组开发 CLI

`@tarp/module-cli` 是同时支持 Node.js 和 Bun 的独立命令行子包。校验使用 `@tarp/module` 的真实加载器，无需桌面运行时、桌面构建或个人应用配置，不创建存档、不修改模组。

## npm 安装

发布到 npm 后，Node.js 22.12.0 或更新版本可直接运行 `tarp`；Bun 可显式执行同一份 JavaScript 产物：

```sh
npm install -g @tarp/module-cli
tarp --help
tarp module validate ./module --json
```

安装时自动提供 YAML、Zod、smol-toml，不需要源码仓库。预览仍需安装桌面应用，并设置 `TARP_DESKTOP` 为其可执行文件路径。包名与 scope 需在实际发布前确认。

完整使用说明只在「官网 CLI 指南」维护。本页保留 npm 最小入口及源码开发、协议验收和发布步骤。

## 仓库内使用

仓库内安装、构建与测试框架使用 Bun 1.4.0 或更新版本；CLI 兼容性测试还需要 Node.js 22.12.0 或更新版本。两种运行时执行同一份构建产物，独立 CLI 不依赖 SQLite。

从 monorepo 根目录安装依赖、构建 CLI 后执行：

```sh
bun install --frozen-lockfile
bun run --filter @tarp/module-cli build
bun run cli --help
bun run cli --version
bun run cli module validate ./apps/desktop/examples/建卡控件演示 --json
```

模组路径相对于命令执行目录解析，含空格的路径请加引号。子包提供基于 `#!/usr/bin/env node` 的 `tarp` 可执行入口，指向构建后的 `out/index.js`。也可以直接用 `node packages/module-cli/out/index.js` 或 `bun packages/module-cli/out/index.js` 执行。仅安装 Bun 时，使用显式 `bun` 命令；公开包发布后也可使用 `bunx --bun @tarp/module-cli`，避免按 Node.js shebang 启动。

CLI 的校验输出与退出码属于共享协议：`0` 成功，`1` 校验或操作失败，`2` 参数错误。Agent 使用退出码及 JSON 字段判断，不依赖中文提示措辞。`--json` 包含 `schemaVersion`、`appVersion`、`status`、路径、数量和 `issues`；`appVersion` 是当前执行入口版本。

预览开发路径由 CLI 先校验目录，再启动桌面入口，不创建冒险或复制模组。本地默认启动最近构建的桌面应用，需先完成 Electrobun 桌面构建；已运行的桌面复用窗口，再次调用重新载入外部修改。安装版通过 `TARP_DESKTOP` 解析可执行文件路径，不接受 shell 命令或额外参数。完整命令与预览操作见「官网 CLI 指南」。

## 开发与验收

```sh
bun run typecheck
bun run test
bun run build
```

这些命令在本子包内执行；也可以从 monorepo 根目录验证所有 workspace。`build` 输出 `out/index.js`，用 `node out/index.js` 或 `bun out/index.js` 执行。构建只打包 CLI 与共享模组源码；YAML、Zod、smol-toml 保留为运行依赖，由包管理器安装并保留各包的许可文件。产物不携带 Node.js 或 Bun 运行时。

## 打包与发布

在本子包执行 `bun run pack`，生成 `out/tarp-module-cli.tgz`。构建通过 `Bun.build` 的 Node.js 目标，将 CLI 与 `@tarp/module` workspace 源码打进 `index.js`；第三方库不打入产物，发布目录中的 `package.json.dependencies` 声明其运行依赖，没有 `workspace:*` 或源码导出。

发布包只包含 `index.js`、`package.json`、README、GPL v3 LICENSE 和 NOTICE.md。发布时使用独立的 `out/` 目录。`bun run pack` 只生成本地产物，不上传到 npm。

推送与 CLI 版本一致的 `cli-v*` tag 后，GitHub Actions 验收 tgz，再将同一份包自动发布到 npm；需要预先配置 `NPM_TOKEN`。用户安装的是构建后的 JavaScript，无需在安装时运行 Bun 构建。

GitHub Actions 的 CLI tag、独立安装验收、Release 草稿和 npm 自动发布见[发布流程](../../docs/发布流程.md)。

## 许可证

本包采用 [GNU GPL v3（仅此版本）](../../LICENSE)，SPDX 标识为 `GPL-3.0-only`。版权及授权范围见 [NOTICE.md](../../NOTICE.md)。

发布 CLI 安装包时，应按 GPL v3 同时提供该版本的完整对应源码和构建脚本，或在下载处提供无需额外付费的对应源码获取入口；只有编译后的 `index.js` 不能替代完整对应源码。
