# 游戏服务核心

`@jointarp/core` 提供桌面主进程与未来云端宿主共用的房间服务。依赖方向为宿主 → `core` → `module`；核心不引用桌面源码、Electrobun、React 或个人应用配置。

## 入口与职责

| 入口                       | 职责                                                   |
| -------------------------- | ------------------------------------------------------ |
| `@jointarp/core/shared`    | 游戏通信契约、房间与开局类型；浏览器和宿主共用         |
| `@jointarp/core/shared/*`  | 消息处理、同步结构、叙事解析、队友与声音配置等共享能力 |
| `@jointarp/core/node`      | `ChatService`、游戏路由、Pi runtime 和房间存档入口     |
| `@jointarp/core/node/*`    | 房间存储、状态、AI 工具及文件读写等服务端能力          |
| `@jointarp/core/testing/*` | 已有测试共用的独立临时模组与房间数据                   |

`node` 入口在浏览器条件下不可导入。共享入口只引用浏览器可用的实现或类型，不导出 SQLite、文件系统和 AI runtime。

源码组织：

- `src/shared/`：Zod Schema、oRPC 契约、同步数据与业务共享函数。
- `src/node/game/`：聊天、开局、队友、掷骰、投影、同步和房间服务生命周期。
- `src/node/sessions/`：存档、冻结模组、本局文档覆盖、角色及房间设置。
- `src/node/agent/`：Pi 会话、资料检索、游戏工具与公开事件投影。
- `src/node/storage/`：文件队列、编解码、结构化读改写与原子写入。

通用模组格式、加载、校验和计算仍归 `@jointarp/module`。游戏核心负责选择房间的冻结模组、合并本局修改和执行业务命令。

## 宿主接入

宿主创建 `ChatService`，提供存档根目录、runtime 和按房间解析模型配置与凭据的函数，并在退出时调用 `close()`。`createPiRuntime` 接收 `PiRuntimeOptions`：订阅凭据由宿主管理，主持系统提示词在创建时解析并保存到冒险设置，每次运行读取本局正文。`createSession` 接收完整游戏初始化配置，核心不保存桌面配置路径。

`gameRouter` 使用宿主提供的 `GameContext.player`、`chat` 与可信 `isHost` 能力，不绑定 Electrobun 原生桥、HTTP 或其他传输。缺省 `isHost` 视为普通玩家，停止、手动继续、切换提交方式及插话管理由路由验证房主权限。认证与每次操作的房间访问权限由宿主验证，玩家身份和房主能力不能直接信任客户端输入。

桌面宿主在 `apps/desktop/src/main/sessions/local-room-resources.ts` 读取房间后注册本地图片目录；核心加载存档不会注册本地图片目录或启动媒体服务。语音提供商、系统窗口、文件选择、账号登录与本机配置留在桌面应用。

## 云端边界

当前仍使用完整冻结模组基线与原始覆盖同步。`loadSessionModuleResources` 返回完整资源，`public/gm` 字段标记用于展示，不能作为联网的数据权限机制。云端上线前必须同时处理资源、状态覆盖和媒体的玩家权限，不能直接把现有本地资源入口公开给浏览器。

存档使用 SQLite 与房间目录，运行锁、计时器、通知订阅和缓存由当前进程维护。云端初期可以由单个实例配合持久化磁盘托管；多实例需要另外落实房间归属、并发协调和存储方案。本包不提供云端应用、账号系统或分布式调度。

## 开发与验证

依赖在仓库根目录安装，仅维护根级 `bun.lock`。源码由消费者构建工具处理，不增加独立发布构建；Bun 主进程构建将此 workspace 源码打包。

根目录 `bun run typecheck` 与 `bun run test` 包含本包。核心服务测试位于本包，涉及桌面配置、媒体和渲染端连接的集成测试位于桌面应用。测试维护原则见[测试维护](../../docs/测试维护.md)。业务实现与存档契约见[开发文档索引](../../docs/README.md)。

## 许可证

本包采用 [GNU GPL v3（仅此版本）](../../LICENSE)，SPDX 标识为 `GPL-3.0-only`。版权及授权范围见 [NOTICE.md](../../NOTICE.md)。
