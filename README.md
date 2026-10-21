# TARP

TARP（the agentic roleplaying）是一个由 AI 主持的桌面跑团应用。你扮演自己的角色，用自然语言描述行动；AI 主持负责描述场景、查阅规则、调用掷骰工具，并根据结果推进故事。一个人也能开团，需要同伴时，可以让 AI 队友扮演其他角色。

冒险由模组提供故事、规则、人物、地点和物品。TARP 把对话与本局状态连接起来：主持可以读取模组资料，在允许的范围内更新角色、物品和场景，让下一次行动接着已经发生的变化继续。

## 已有功能

- **AI 主持与检定**：主持按需读取资料、处理行动，骰点由程序生成，聊天中展示检定结果。
- **AI 队友**：队友以玩家身份参与讨论和行动，可以用 `@角色名` 点名交流。
- **模组与状态管理**：加载本地模组，为每局冒险保存独立状态；源模组与本局存档分开维护。
- **角色与场景展示**：模组可配置角色卡、世界卡和分阶段建卡，供玩家查看与交互。
- **语音朗读**：连接语音服务后，可以朗读游戏消息。
- **模组开发工具**：支持 Node.js 和 Bun 的独立 CLI 可在不启动桌面端的情况下加载、校验和预览模组数据。

## 当前状态

当前为 **v0.1 开发版本**，桌面安装包尚未发布，暂不支持真人在线联机。

模组和冒险存档保存在本机。AI 主持、队友与语音朗读需要连接相应服务，相关内容会发送给所选服务商；调用费用取决于服务及账户。规则适用和剧情回应仍依赖模型判断，可能出现误判。

## 文档入口

- **开始游玩**：[认识 TARP](https://jointarp.party/docs/getting-started/introduction/) · [第一次冒险](https://jointarp.party/docs/getting-started/first-adventure/) · [连接模型服务](https://jointarp.party/docs/getting-started/models/)
- **创作模组**：[模组目录结构](https://jointarp.party/docs/modules/structure/) · [模组开发 CLI](packages/module-cli/README.md)
- **参与开发**：[桌面开发说明](apps/desktop/README.md) · [开发文档索引](docs/README.md) · [发布流程](docs/发布流程.md)

玩家指南和模组配置规范在官网文档中维护，本仓库提供开发文档。

## 本地开发

需要 Bun 1.4.0 或更新版本。从仓库根目录安装依赖并启动桌面应用：

```sh
bun install --frozen-lockfile
bun run dev
```

常用命令：

| 命令                | 用途                             |
| ------------------- | -------------------------------- |
| `bun run typecheck` | 检查各 workspace 的类型          |
| `bun run test`      | 使用 Bun 运行各 workspace 的测试 |
| `bun run fmt:check` | 检查格式                         |
| `bun run build`     | 构建各 workspace                 |
| `bun run package`   | 打包桌面应用目录                 |
| `bun run dist`      | 生成桌面分发产物                 |

类型检查与构建由 Turborepo 调度，可复用 CLI 和页面构建结果；缓存范围与 Actions 配置见[发布流程](docs/发布流程.md)。完整测试与桌面原生打包仍实际执行。

构建 CLI 后，可以直接用 Bun 校验模组：

```sh
bun run --filter @jointarp/module-cli build
bun run cli module validate ./apps/desktop/examples/建卡控件演示 --json
```

更多 CLI 命令和预览方式见[模组开发 CLI](packages/module-cli/README.md)。

测试范围、定向运行和改动筛选见[测试维护](docs/测试维护.md)。

## 仓库结构

本仓库使用 Bun workspace，依赖从根目录统一安装，仅维护根级 `bun.lock`。

| 目录                   | 内容                                             |
| ---------------------- | ------------------------------------------------ |
| `apps/desktop/`        | Electrobun、Bun、React 与 Vite 桌面应用          |
| `packages/core/`       | 桌面与未来云端共用的游戏契约、房间服务和 AI 执行 |
| `packages/module/`     | 桌面端与 CLI 共用的模组加载、校验和计算逻辑      |
| `packages/module-cli/` | 支持 Node.js 和 Bun 的独立模组开发 CLI           |

官网和剧情模组在独立仓库维护。源码中的 `examples/` 提供功能演示，平台测试使用独立测试数据。

## 许可证

本仓库原创代码与文档采用 [GNU GPL v3（仅此版本）](LICENSE)，SPDX 标识为 `GPL-3.0-only`，允许商业使用。版权及授权范围见 [NOTICE.md](NOTICE.md)；第三方依赖、模组、规则和素材保留各自的许可证与授权条件。
