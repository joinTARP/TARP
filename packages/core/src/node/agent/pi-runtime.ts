import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  createAgentSession,
  createCodemodeExtension,
  createExtensionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type LoadExtensionsResult,
  type ExtensionFactory,
  type ResourceLoader,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadModuleMetadata } from "@tarp/module/node/module-metadata";
import { Type } from "typebox";

import { chatText } from "../../shared/agent-message";
import { resolveCompaction, type CompactionRole } from "../../shared/compaction-settings";
import {
  companionInstructions,
  companionPlainText,
  companionPerformanceSchema,
  companionRulingSchema,
  companionWithdrawalSchema,
} from "../../shared/companion";
import { diceOptionsSchema } from "../../shared/dice";
import { messageSchema } from "../../shared/game";
import {
  hostChatInstructions,
  hostInputInstructions,
  hostMentionInstructions,
  hostStateInstructions,
  hostPlayerControlInstructions,
  resolveHostSystemPrompt,
} from "../../shared/host-system-prompt";
import { identityIdSchema } from "../../shared/identity";
import { parseMentionRefs, resolveMentionRefs } from "../../shared/mentions";
import { narrativeInstructions } from "../../shared/narrative";
import type { Runtime } from "../game/chat/types";
import { NoCompanionResponseError } from "../game/chat/types";
import { gameFolderIndex } from "../sessions/game-state";
import { readLaunchConfig, readLaunchRoom } from "../sessions/launch-db";
import { launchStart } from "../sessions/launch-store";
import { readRoomSettings } from "../sessions/room-settings";
import { openSessionDatabase } from "../sessions/session-store";
import { chatField } from "../storage/session-database";
import { createCompanionDocumentTools } from "./companion-document-tools";
import { prepareCompanionInput } from "./companion-input";
import { ContextSubscriptions } from "./context-subscriptions";
import { AgentDetailsStream } from "./details-stream";
import { createGameCompactionExtension } from "./game-compaction";
import { createGameTools } from "./game-tools";
import { inputBatchCustomType, inputReceiptSchema } from "./input-batch";
import { companionDecisionRetryDetail, companionDecisionRetryType, PiHistory } from "./pi-history";
import { PiSessionCache } from "./pi-session-cache";
import { PublicAgentStream } from "./public-stream";
import { steeringBatchSchema, steeringCustomType } from "./steering-batch";

export interface PiRuntimeOptions {
  readonly modelRuntime: () => Promise<ModelRuntime>;
}

// 跨 runtime 实例防止同一房间的 JSONL 同时被两次运行追加。
const activeRooms = new Set<string>();

async function readHostPrompt(moduleDirectory: string): Promise<string> {
  const metadata = await loadModuleMetadata(moduleDirectory);
  return metadata.hostPrompt?.trim() ?? "";
}

async function readFolderIndex(room: string, gameDirectory: string): Promise<string> {
  const db = await openSessionDatabase(dirname(room), basename(room));
  try {
    return await gameFolderIndex(gameDirectory, db);
  } finally {
    db.close();
  }
}

export async function readOpeningBackground(room: string): Promise<string> {
  const db = await openSessionDatabase(dirname(room), basename(room));
  try {
    if (!readLaunchConfig(db) || !readLaunchRoom(db).startId) return "";
    const start = launchStart(db);
    const scripted = db
      .all(
        db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("kind"), "=", "scripted")
          .orderBy("sequence", "asc"),
      )
      .map((row) => messageSchema.parse(JSON.parse(row.data)))
      .map((message) => ({ speaker: message.nickname, text: chatText(message) }));
    return `## 已发生的开局背景\n以下内容仅用于理解冒险缘起，不代表当前位置或当前状态，不得重新播放或初始化。\n${JSON.stringify({ name: start.name, description: start.description, scripted })}`;
  } finally {
    db.close();
  }
}

export function roomResources(
  gameDirectory: string,
  folderIndex: string,
  hostPrompt: string,
  systemPrompt?: string | null,
  role: CompactionRole = "host",
  onCompactionError?: (error: Error) => void,
  extraExtensions: ExtensionFactory[] = [],
  openingBackground = "",
  hostChat = false,
): ResourceLoader {
  const codemode = role === "host" && !hostChat;
  let extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      `${resolveHostSystemPrompt(systemPrompt)}\n\n本局游戏工作区：${gameDirectory}。工具能力与使用要求见各工具定义。\n\n${folderIndex}`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [
      narrativeInstructions,
      hostInputInstructions,
      ...(role === "host" ? [hostMentionInstructions] : []),
      ...(codemode ? [hostStateInstructions, hostPlayerControlInstructions] : []),
      ...(openingBackground ? [openingBackground] : []),
      ...(codemode
        ? [
            "codemode 用于批量查询、筛选和规则计算。已知状态字段优先用 read 的 fields；批量 read 结果先 JSON.parse，在脚本内筛选和计算，只打印裁定依据、计算结果、必要原值与修改约束及来源路径。未知规则可读取全文，不自动截断或省略规则。关联更新优先 batch_update。实际状态变化逐次 await 保存，成功后才叙述生效；脚本不回滚已提交变更，批量发布可能部分成功，恢复先 read 核对，勿重复结算。store/load 仅存查询等辅助状态，不代替存档，每轮重读当前状态。随机检定须直接调用 roll_dice。",
          ]
        : []),
      ...(hostPrompt ? [`模组主持人提示：\n${hostPrompt}`] : []),
      ...(hostChat ? [hostChatInstructions] : []),
    ],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {
      if (extensions.extensions.length) return;
      // 只加载应用指定的内置扩展，不加载房间资料或全局 Pi 配置中的资源。
      const loader = new DefaultResourceLoader({
        cwd: gameDirectory,
        agentDir: join(dirname(gameDirectory), "agent"),
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          createGameCompactionExtension(role, onCompactionError),
          ...extraExtensions,
          ...(codemode ? [createCodemodeExtension({ mode: "on", models: false })] : []),
        ],
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      if (loaded.errors.length) throw new Error("无法加载游戏 AI 内置扩展");
      extensions = loaded;
    },
  };
}

export function createPiRuntime(options: PiRuntimeOptions): Runtime {
  const sessions = new PiSessionCache();
  return {
    history: new PiHistory(sessions),
    closeRoom: (roomDirectory) => sessions.closeRoom(roomDirectory),
    async run(args) {
      const { signal, config } = args;
      signal.throwIfAborted();
      const room = await realpath(args.roomDirectory);
      if (activeRooms.has(room)) throw new Error("该房间已有正在运行的 AI 会话");
      activeRooms.add(room);
      let sessionFile: string | undefined;
      let manager: SessionManager | undefined;
      let retained = false;
      try {
        const gameDirectory = join(room, "game");
        if ((await realpath(gameDirectory)) !== gameDirectory)
          throw new Error("游戏工作区不能是符号链接");
        const agentDir = join(room, "agent");
        await mkdir(agentDir, { recursive: true });
        if ((await realpath(agentDir)) !== agentDir) throw new Error("会话目录不能是符号链接");
        if (args.companion && !identityIdSchema.safeParse(args.companion.id).success)
          throw new Error("队友会话标识无效");
        sessionFile = join(
          agentDir,
          args.companion ? `companion-${args.companion.id}.jsonl` : "session.jsonl",
        );
        // SDK 对预先存在的空文件立即写入头部。
        const file = await open(
          sessionFile,
          constants.O_CREAT |
            constants.O_APPEND |
            constants.O_WRONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw new Error("会话必须是独立普通文件");
        } finally {
          await file.close();
        }
        if (!(await lstat(sessionFile)).isFile()) throw new Error("会话文件无效");
        manager = await sessions.take(sessionFile, agentDir, room);
        const modelRuntime = await options.modelRuntime();
        const model = modelRuntime.getModel(config.provider, config.model);
        if (!model) throw new Error(`不支持的模型：${config.provider}/${config.model}`);
        if (!(await modelRuntime.getAuth(model, { signal })))
          throw new Error("模型认证不可用，请在设置中重新连接服务商。");
        args.onContextWindow?.(model.contextWindow);
        let companionPerformanceCount = 0;
        let companionPerformanceLength = 0;
        let companionTurnSubmitted = false;
        let companionActionWithdrawn = false;
        let companionSilent = false;
        const companionTools: ToolDefinition<any, any, any>[] = args.companion
          ? [
              {
                name: "companion_silent",
                label: "保持沉默",
                executionMode: "sequential",
                description:
                  "本轮没有新的贡献，选择不发言，不需要说明原因。与聊天、行动互斥；被直接点名时不能沉默。调用成功后直接结束本轮。",
                parameters: Type.Object({}),
                execute: async () => {
                  if (args.requireResponse) throw new Error("被直接点名时必须回应，不能保持沉默");
                  if (
                    companionPerformanceCount ||
                    companionTurnSubmitted ||
                    companionActionWithdrawn
                  )
                    throw new Error("本轮已发言或提交行动，不能再选择沉默");
                  companionSilent = true;
                  return {
                    content: [{ type: "text" as const, text: "请结束本轮。" }],
                    details: {},
                  };
                },
              },
              {
                name: "companion_perform",
                label: "队友聊天",
                executionMode: "sequential",
                description:
                  "像真实玩家一样和其他玩家交流，不作为行动交给主持；点名主持时进行场外聊天。text 是 Markdown 正文；点名在 text 正文写 [@名称](#mention/participants中的身份ID)，不猜 ID；普通 @名字、代码或引用中的链接不产生点名；可以调用多次；聊天后可以另行提交一次行动，分别显示为聊天和行动消息。向 NPC 发言请使用行动工具。",
                parameters: Type.Object({
                  text: Type.String({ minLength: 1, maxLength: 2000 }),
                }),
                execute: async (_id, params) => {
                  if (companionSilent) throw new Error("本轮已选择沉默，请结束回复");
                  if (companionTurnSubmitted) throw new Error("提交行动后不能继续聊天");
                  if (companionActionWithdrawn) throw new Error("撤回行动后请结束本轮");
                  const input = companionPerformanceSchema.parse(params);
                  companionPerformanceCount++;
                  companionPerformanceLength += input.text.length;
                  if (companionPerformanceCount > 8 || companionPerformanceLength > 8000)
                    throw new Error("队友本轮聊天过长");
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "已展示纯聊天消息。可以继续聊天、另行提交一次行动或直接结束回复；无需调用沉默工具。",
                      },
                    ],
                    details: {},
                  };
                },
              },
              {
                name: "companion_request_ruling",
                label: "提交行动",
                executionMode: "sequential",
                description:
                  "像真实玩家一样向主持说明角色意图、台词或场景与规则问题。intent 是 Markdown 正文，可以同时包含动作和台词；向 NPC 说话也交给主持。在 intent 正文写 [@名称](#mention/participants中的身份ID) 点名；含合法身份链接时整条改为聊天。每轮最多一次真正的行动；可以先聊天再提交行动，两者分别显示为独立消息。提交行动后结束本轮。",
                parameters: Type.Object({
                  intent: Type.String({ minLength: 1, maxLength: 2000 }),
                }),
                execute: async (_id, params) => {
                  if (companionSilent) throw new Error("本轮已选择沉默，请结束回复");
                  if (companionActionWithdrawn) throw new Error("撤回行动后请结束本轮");
                  const input = companionRulingSchema.parse(params);
                  if (
                    resolveMentionRefs(
                      parseMentionRefs(companionPlainText(input.intent)),
                      args.mentionTargets ?? [],
                    ).length
                  ) {
                    companionPerformanceCount++;
                    companionPerformanceLength += input.intent.length;
                    if (companionPerformanceCount > 8 || companionPerformanceLength > 8000)
                      throw new Error("队友本轮聊天过长");
                    return {
                      content: [
                        {
                          type: "text" as const,
                          text: "已发送定向聊天，不提交主持。可以继续聊天、另行提交一次不带点名的行动或结束回复。",
                        },
                      ],
                      details: {},
                    };
                  }
                  if (companionTurnSubmitted) throw new Error("本轮已经提交给主持");
                  companionTurnSubmitted = true;
                  return {
                    content: [{ type: "text" as const, text: "行动已记录，请直接结束回复。" }],
                    details: {},
                  };
                },
              },
              {
                name: "companion_withdraw_action",
                label: "将待提交行动改为聊天",
                executionMode: "sequential",
                description:
                  "放弃自己的一条待提交行动，将原消息改为聊天并保留正文，不再交主持裁定。messageId 使用本轮 pendingAction.id，不猜 ID；只能撤回自己的行动，已开始提交给主持的行动不能撤回。普通聊天或沉默不会撤回行动。可以先聊天说明改主意，再调用本工具；成功后结束本轮，不再提交新行动。",
                parameters: Type.Object({ messageId: Type.String() }),
                execute: async (_id, params) => {
                  signal.throwIfAborted();
                  if (companionSilent || companionTurnSubmitted || companionActionWithdrawn)
                    throw new Error("本轮已作出决定，请结束回复");
                  if (!args.withdrawAction) throw new Error("本轮没有撤回行动的能力");
                  const input = companionWithdrawalSchema.parse(params);
                  const message = await args.withdrawAction(input.messageId);
                  companionActionWithdrawn = true;
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "该行动已改为聊天，不再提交主持。请结束本轮。",
                      },
                    ],
                    details: { messageId: message.id },
                  };
                },
              },
            ]
          : [];
        const moduleTools = args.companion
          ? [
              ...companionTools,
              ...(args.companion.documentAccess ? createCompanionDocumentTools(room, signal) : []),
            ]
          : (await createGameTools(room, signal)).filter(
              (tool) => !args.hostChat || ["read", "find", "grep", "ls"].includes(tool.name),
            );
        const subscriptions = new ContextSubscriptions(room, signal, args.companion?.id);
        if (subscriptions.enabled() && !args.hostChat) moduleTools.push(subscriptions.tool());
        const withSubscriptions = async (text: string) => {
          const context = await subscriptions.prompt();
          return context ? `${text}\n\n${context}` : text;
        };
        if (args.rollDice && !args.companion && !args.hostChat)
          moduleTools.push({
            name: "roll_dice",
            label: "掷骰",
            executionMode: "sequential",
            exposure: "model-only",
            description:
              "发起公开掷骰并返回真实结果。先查相关规则与角色状态，确定目标、难度和修正。expression 如 1d20、2d6+3；reason 简述检定用途。玩家角色的检定使用本轮名单中对应的 playerId 作为 targetPlayerId；NPC 或其他无玩家归属的掷骰不传 targetPlayerId。等待工具返回后依据真实结果裁定，不编造点数，也不因中断而重复已经完成的掷骰。",
            parameters: Type.Object({
              expression: Type.String(),
              reason: Type.Optional(Type.String()),
              targetPlayerId: Type.Optional(Type.String()),
            }),
            execute: async (_id, params) => {
              const result = await args.rollDice!(diceOptionsSchema.parse(params));
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result.kind === "dice" ? result.dice : result),
                  },
                ],
                details: {},
              };
            },
          });
        signal.throwIfAborted();
        const hostPrompt = args.companion ? "" : await readHostPrompt(join(room, "module"));
        let failure: Error | undefined;
        const resources = roomResources(
          gameDirectory,
          args.companion ? "" : await readFolderIndex(room, gameDirectory),
          hostPrompt,
          !args.companion ? readRoomSettings(room).hostSystemPrompt : undefined,
          args.companion ? "companion" : "host",
          (error) => {
            failure = error;
          },
          !args.companion && args.takeSteering
            ? [
                (pi) => {
                  pi.on("turn_end", async (event, ctx) => {
                    if (signal.aborted || event.outcome !== "completed") return;
                    try {
                      const batch = args.takeSteering!();
                      if (!batch) return;
                      return {
                        entries: [
                          {
                            type: "custom_message",
                            customType: steeringCustomType,
                            content: await withSubscriptions(batch.prompt),
                            display: false,
                            details: batch,
                          },
                        ],
                        continue: true,
                      };
                    } catch (error) {
                      failure = error instanceof Error ? error : new Error("插话接收失败");
                      ctx.abort();
                      return;
                    }
                  });
                },
              ]
            : [],
          args.companion ? "" : await readOpeningBackground(room),
          args.hostChat,
        );
        if (args.companion) {
          resources.getSystemPrompt = () =>
            companionInstructions(
              args.companion!.personality,
              args.companion!.initiative,
              args.companion!.documentAccess,
              readRoomSettings(room).companionRoleplayPrompt,
            );
          resources.getAppendSystemPrompt = () => [];
        }
        await resources.reload();
        signal.throwIfAborted();
        const { session } = await createAgentSession({
          cwd: gameDirectory,
          agentDir,
          sessionManager: manager,
          modelRuntime,
          model,
          // 显式覆盖历史会话的强度，恢复默认时也不沿用旧配置。
          thinkingLevel: config.thinkingLevel ?? "medium",
          resourceLoader: resources,
          settingsManager: SettingsManager.inMemory({
            // 预留一段输出与摘要空间；保留最近互动，较早记录由 Pi 写成持久化摘要。
            // 按实际模型窗口计算，避免较小窗口在触发阈值前就无可压缩内容。
            compaction: resolveCompaction(
              args.compaction ?? { thresholdTokens: null },
              model.contextWindow,
            ),
            // Pi 只重试失败的模型请求，继续使用此前已完成的工具结果。
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
          }),
          tools: [
            ...moduleTools.map((tool) => tool.name),
            ...(args.companion || args.hostChat ? [] : ["codemode"]),
          ],
          customTools: moduleTools,
        });
        if (args.companion) {
          const finishTurn = session.agent.finishTurn;
          session.agent.finishTurn = async (turn, turnSignal) => {
            const decision = await finishTurn?.(turn, turnSignal);
            // 此边界在工具结果落盘之后执行；正常结束，不能伪装成用户取消。
            if (
              !turnSignal?.aborted &&
              (companionSilent || companionTurnSubmitted || companionActionWithdrawn)
            )
              return { action: "end" };
            return decision ?? undefined;
          };
        }
        if (args.operation === "compact") {
          const abortCompaction = () => session.abortCompaction();
          signal.addEventListener("abort", abortCompaction, { once: true });
          try {
            signal.throwIfAborted();
            await session.compact();
            signal.throwIfAborted();
          } catch (error) {
            if (failure) throw failure;
            if (error instanceof Error && error.message === "Already compacted")
              throw new Error("该角色的会话已经压缩，产生新对话后可再次压缩");
            if (
              error instanceof Error &&
              error.message === "Nothing to compact (session too small)"
            )
              throw new Error("当前会话较短，暂无可压缩的旧记录");
            throw error;
          } finally {
            signal.removeEventListener("abort", abortCompaction);
            session.dispose();
          }
          await sessions.retain(sessionFile, room, manager);
          retained = true;
          return;
        }
        let publicStream = new PublicAgentStream(
          args.onAgentEvent,
          args.companion
            ? {
                text: false,
                toolNames: new Set(["companion_perform", "companion_request_ruling"]),
              }
            : undefined,
        );
        let detailsStream = args.onDetail ? new AgentDetailsStream(args.onDetail) : null;
        let modelFailure: Error | undefined;
        let companionResponded = false;
        let abortTask: Promise<void> | undefined;
        const abort = () => {
          abortTask ??= session.abort();
        };
        const unsubscribe = session.subscribe((event) => {
          publicStream.accept(event);
          detailsStream?.accept(event);
          if (
            event.type === "tool_execution_end" &&
            !event.isError &&
            (event.toolName === "companion_perform" ||
              event.toolName === "companion_request_ruling" ||
              event.toolName === "companion_withdraw_action")
          )
            companionResponded = true;
          if (event.type === "message_end" && event.message.role === "assistant") {
            // 重试成功后清除请求错误；压缩或插话的业务错误仍单独保留。
            modelFailure =
              event.message.stopReason === "error" || event.message.stopReason === "aborted"
                ? new Error(event.message.errorMessage || "模型运行中断")
                : undefined;
          }
        });
        let reference = {
          sessionId: manager.getSessionId(),
          beforeEntryId: manager.getLeafId(),
          afterEntryId: manager.getLeafId(),
        };
        const currentManager = manager;
        const companionInput = args.companion
          ? prepareCompanionInput(manager, args.text)
          : undefined;
        const appendMessage = manager.appendMessage;
        // 普通 message_end 先通知订阅者，再由 SDK 落盘；这里在原生写入成功后保存条目关联。
        manager.appendMessage = (message) => {
          const id = appendMessage.call(currentManager, message);
          args.onHistory?.({ ...reference, afterEntryId: id });
          return id;
        };
        const appendCustomMessage = manager.appendCustomMessageEntry;
        manager.appendCustomMessageEntry = (customType, content, display, details) => {
          const beforeEntryId = currentManager.getLeafId();
          const id = appendCustomMessage.call(
            currentManager,
            customType,
            content,
            display,
            details,
          );
          if (customType === inputBatchCustomType) {
            const receipt = inputReceiptSchema.parse(details);
            args.onInputReceived?.({
              ...receipt,
              reference: {
                sessionId: currentManager.getSessionId(),
                beforeEntryId,
                afterEntryId: id,
              },
            });
            args.onHistory?.({ ...reference, afterEntryId: id });
          }
          if (customType === steeringCustomType) {
            const batch = steeringBatchSchema.parse(details);
            reference = {
              sessionId: currentManager.getSessionId(),
              beforeEntryId,
              afterEntryId: id,
            };
            // 原生写入已成功，才移动聊天投影并切换流的消息编号。
            args.onSteering?.({ batch, reference });
            publicStream = new PublicAgentStream(args.onAgentEvent);
            detailsStream = args.onDetail ? new AgentDetailsStream(args.onDetail) : null;
          }
          return id;
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          args.onHistory?.(reference);
          signal.throwIfAborted();
          if (args.initialSteering) {
            await session.sendCustomMessage(
              {
                customType: steeringCustomType,
                content: args.initialSteering.prompt,
                display: false,
                details: args.initialSteering,
              },
              { triggerTurn: false },
            );
            signal.throwIfAborted();
          }
          if (args.inputBatch && !args.companion) {
            await session.sendCustomMessage(
              {
                customType: inputBatchCustomType,
                content: await withSubscriptions(args.text),
                display: false,
                details: { batchId: args.inputBatch.id, messageId: args.messageId },
              },
              { triggerTurn: true },
            );
          } else {
            await session.prompt(await withSubscriptions(companionInput?.text ?? args.text), {
              expandPromptTemplates: false,
            });
          }
          signal.throwIfAborted();
          if (failure) throw failure;
          if (modelFailure) throw modelFailure;
          if (args.companion && !companionResponded && !companionSilent) {
            // 空输出不是明确的沉默；在原会话补问一次，不重跑已完成的工具。
            manager.appendCustomEntry(companionDecisionRetryType);
            args.onHistory?.({ ...reference, afterEntryId: manager.getLeafId() });
            args.onDetail?.({ ...companionDecisionRetryDetail });
            await session.prompt(
              await withSubscriptions(
                args.requireResponse
                  ? "你被明确点名了。请回应刚才 trigger 中的消息，调用 companion_perform、companion_request_ruling 或在确需撤回自己待提交行动时调用 companion_withdraw_action；不要保持沉默。"
                  : "本轮尚未收到有效决定。需要回应时调用 companion_perform 或 companion_request_ruling；需要撤回自己待提交的行动时调用 companion_withdraw_action；没有新的贡献时调用 companion_silent，无需说明原因。",
              ),
              { expandPromptTemplates: false },
            );
            signal.throwIfAborted();
            if (failure) throw failure;
            if (modelFailure) throw modelFailure;
            if (args.requireResponse && !companionResponded) throw new NoCompanionResponseError();
          }
        } finally {
          signal.removeEventListener("abort", abort);
          try {
            await abortTask;
          } finally {
            currentManager.appendMessage = appendMessage;
            currentManager.appendCustomMessageEntry = appendCustomMessage;
            unsubscribe();
            session.dispose();
          }
        }
        if (!signal.aborted) {
          companionInput?.acknowledge();
          await sessions.retain(sessionFile, room, manager);
          retained = true;
        }
      } finally {
        if (sessionFile && manager && !retained) sessions.discard(sessionFile, manager);
        activeRooms.delete(room);
      }
    },
  };
}
