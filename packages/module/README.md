# 模组共享能力

`@tarp/module` 提供游戏服务核心、桌面应用与模组 CLI 共用的文档模型、字段计算和加载校验逻辑。房间生命周期与本局状态由 `@tarp/core` 管理，通用模组读取不依赖游戏服务。

- 根级子路径：文档类型、元配置、引用、开局和计算字段等逻辑，可供前端与主进程使用。
- `@tarp/module/node/*`：JSON/TOML/Markdown 编解码、文件加载、模组校验与 ZIP 安全解压，仅供具备文件系统能力的运行时使用。
- `@tarp/module/testing/*`：平台测试共用的类型与临时副本工具。

`test-fixtures/platform/` 保存随 Git 维护的固定功能测试模组，不包含剧情或冒险规则。测试通过 `createTestModule()` 复制到独立临时目录，修改与存档只写入副本，结束后清理。

包不依赖 Electrobun、React、桌面应用源代码或个人配置。桌面游戏客户端在专属 Web Worker 内通过 SES 执行公式，主进程与 CLI 使用原生编译器；各端共用同一求值核心。

在本子包执行 `bun run typecheck`、`bun run test`；依赖和锁文件由 monorepo 根目录维护。源码由消费者的构建工具处理，不添加单独的发布构建。

开发边界见[模组加载与文档实现](../../docs/模组加载与文档实现.md)。面向作者的字段、公式及配置规范统一在官网文档维护。

## 许可证

本包采用 [GNU GPL v3（仅此版本）](../../LICENSE)，SPDX 标识为 `GPL-3.0-only`。版权及授权范围见 [NOTICE.md](../../NOTICE.md)。
