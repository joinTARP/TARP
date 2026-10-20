# TARP

TARP（the agentic roleplaying）是 Electrobun、Bun、React、Vite 和 TypeScript 桌面应用，作为 TARP Bun workspace 的 `apps/desktop/` 子包维护。当前为 v0.1 开发版本，尚未发布。

本目录维护桌面应用；共享游戏核心、模组能力与独立 CLI 在 `packages/`，剧情、规则和素材在独立模组仓库维护。`examples/` 仅保留建卡控件演示，平台测试使用独立原创数据。

玩家指南和模组创作规范只在官网文档维护；本仓库只维护[开发文档](../../docs/README.md)。开发 CLI 的安装入口和构建方式见[CLI README](../../packages/module-cli/README.md)。

## 许可证

本应用原创代码与文档采用 [GNU GPL v3（仅此版本）](LICENSE)，SPDX 标识为 `GPL-3.0-only`。版权及授权范围见 [NOTICE.md](NOTICE.md)；第三方依赖、模组、规则和素材保留各自的许可证与授权条件。

本目录的 `LICENSE` 和 `NOTICE.md` 与仓库根目录一致，并随桌面应用打包。更新许可声明时同步这两份文件。

## 本地开发

开发环境要求 Bun 1.4.0 或更新版本，具体约束见 `package.json`。桌面仓库保留 TypeScript 7 和 Oxfmt。

在 `apps/desktop/` 中安装 workspace 依赖并启动桌面应用：

```bash
bun install --cwd ../..
bun run dev
```

本目录是 `@jointarp/desktop` workspace 子包。依赖在 monorepo 根目录统一安装，仅维护根级 `bun.lock`；需要按锁文件安装时从根目录运行 `bun install --frozen-lockfile`。本页桌面命令在 `apps/desktop/` 执行。

首次运行构建、开发或类型检查时，`electrobun prepare` 下载固定的 Electrobun 2.0.4 devkit、配套 Hutch 和 Bun 1.4.0，生成忽略提交的 `.hutch/devkit/`。开发机器的 Bun 负责 workspace 和脚本，随桌面分发的 Bun 由 Electrobun 固定，两者独立。所有依赖仍从仓库根目录安装，仅维护根级 `bun.lock`；`hutch.config.ts` 明确使用 Bun，不生成 `hutch.lock`。

`dev` 使用 Vite 页面热更新，Electrobun 监听主进程与共享包源码并重启应用。发布页面固定从 `views://main/index.html` 加载，不接受开发服务器地址。

系统 WebView 为 macOS 的 WKWebView、Windows 的 WebView2 和 Linux 的 WebKitGTK 4.1。Linux 需安装 GTK 3、WebKitGTK 4.1、Ayatana AppIndicator 和 librsvg；Ubuntu 24.04 的依赖由 CI setup 安装。当前 Electrobun 官方产物支持 macOS ARM64、Windows 和 Linux 的 x64/ARM64；仓库发布矩阵为 macOS ARM64、Windows x64 和 Linux x64，暂不提供 macOS Intel 包。

预演 MCP 统一由设置中的“开发者工具”控制，源码调试也使用此入口。开关、端口与令牌保存在应用配置目录的 `mcp-settings.json`；运行时地址与请求头写入同目录的 `mcp.json`。运行和存档边界见 [MCP 预演实现](../../docs/MCP预演实现.md)。

## 常用命令

```bash
bun run typecheck
bun run fmt
bun run fmt:check
bun run test
bun run test:changed
bun run build
bun run package
bun run dist
```

上述应用命令均在 `apps/desktop/` 运行；根目录提供常用 workspace 转发命令。

测试使用 Bun 内置的 `bun:test`。日常迭代先用 `bun run test:changed` 执行当前 Git 改动影响的测试，或用 `bun run test <文件路径>` 指定功能范围。本目录的 `bun run test` 执行桌面测试；完整平台回归从仓库根目录执行 `bun run test`，包含游戏核心与模组包。模组验收在对应的独立仓库运行，见其 README。测试维护边界见[测试维护](../../docs/测试维护.md)。

Git 钩子由 monorepo 根目录的 [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) 管理。从根目录运行 `bun install` 会安装钩子，提交前由 [lint-staged](https://github.com/lint-staged/lint-staged) 调用 Oxfmt 格式化暂存文件，并把格式化结果重新暂存。

## 打包与分发

在本目录执行 `bun run package` 生成开发应用目录，执行 `bun run dist` 生成稳定通道安装包与更新归档。应用目录在 `out/desktop/`，分发文件在 `release/`。主进程与 React 页面分别构建；仅将 QuickJS Wasm 及其运行依赖作为外部文件分发。已编译进页面的 React 组件库不再完整复制。

发布验收从更新归档解出真实应用，使用包内 Bun 验证 CLI、模组、SQLite、Kysely 和 QuickJS Wasm，不依赖开发目录中的运行库。GUI 还需验证中文输入、音频播放、窗口与菜单行为。桌面启动器不转发命令行参数，独立 CLI 的预览通过 `TARP_MODULE_PREVIEW` 环境变量交给宿主再次校验。

GitHub Actions 的版本 tag、跨平台构建、签名配置和 Release 草稿验收见[发布流程](../../docs/发布流程.md)。

应用图标的 1024 × 1024 完整画布主图保存在 `build/tarp-icon-source.png`，不含圆角裁切；`build/icon.png` 供 Linux 窗口与打包使用。Windows 使用由它缩小得到的 `build/icon-win.png`（256 × 256）；Hutch 的 Windows 打包器只接受边长不超过 256 像素的正方形 PNG。更新 `build/icon.png` 时同步生成 Windows 图标。macOS 使用已定稿的 `build/icon-mac.png`：1024 × 1024 透明画布，832 × 832 底板，四边各留白 96 像素。素材已包含圆角与透明留白，直接使用，不再缩放或补边。`build.mac.icons` 指向生成的 `out/icon.iconset`，配置与转换逻辑分别位于 `electrobun.config.ts` 和 `scripts/desktop.ts`。

更新 macOS 图标时直接替换 `build/icon-mac.png`，保留定稿文件自身的圆角和透明留白。开发环境重启应用后生效，发布包需要重新打包。界面中的横版 TARP 字标继续使用原 SVG。

按 GPL v3 分发桌面应用时，应提供该版本的完整对应源码及构建脚本，或在下载处提供无需额外付费的对应源码获取入口。第三方依赖和素材的许可声明随相应内容保留。

## 目录约定

- `src/main/`：Electrobun 启动与桌面 RPC 入口。`config/` 负责用户配置；`modules/` 负责模组列表与导入；`sessions/` 接入本地房间资源与笔记接口；`game/` 管理本机模型配置、房间模型选择与订阅登录；`tts/` 维护语音服务。房间存档、聊天、状态、开局与 AI 执行位于 `packages/core/`，通用模组加载、校验和计算位于 `packages/module/`。
- `src/renderer/src/native-bridge.ts`：Electrobun 页面桥，连接 oRPC、桌面事件和本地图片服务。
- `src/shared/`：主进程和渲染进程之间的桌面契约。游戏共享契约从 `@tarp/core/shared/*` 导入，浏览器不引用 `node` 入口。
- `src/renderer/src/features/modules/`：模组库列表、打开模组与文档预览。
- `src/renderer/src/features/settings/`：设置导航、常规设置与外观设置。
- `src/renderer/src/components/`：跨功能复用的界面组件，`ui/` 存放基于 Base UI 或原生元素维护的基础组件。

`desktop-rpc.ts` 组合桌面路由，公共上下文和配置错误映射位于 `desktop-rpc-context.ts`。模组、房间与语音路由分别在 `modules/module-router.ts`、`sessions/session-router.ts` 和 `tts/router.ts`；宿主启动时注入统一的 `sessionsRoot`。结束、重开与删除冒险由 `sessions/local-session-lifecycle.ts` 协调，删除必须等运行连接关闭成功后才能移除文件。

页面不直接持有主进程或文件系统 API。原生导航白名单只允许固定页面与同页哈希路由，禁止用户目录协议；新增能力先在 `src/shared/` 定义最小契约，再通过原生桥接入。通信、媒体服务、单实例与发布边界见[桌面宿主实现](../../docs/桌面宿主实现.md)。

## 基础组件

桌面端自行维护基础组件层，复杂交互使用 Base UI 原语，简单元素使用原生 HTML。Button、Input、NumberInput、Textarea、Select、Tabs、Dialog、Tooltip 和 Form 共用 TARP 视觉规则；令牌、形态和桌面交互边界见[界面设计](../../docs/界面设计.md)。业务代码统一引用 `src/renderer/src/components/ui/`。

新增组件优先直接基于 Base UI 实现，状态样式使用其原生 `data-*` 属性。不使用 shadcn CLI 或模板覆盖现有组件。
