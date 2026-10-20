import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import {
  applyAgentParts,
  chatText,
  companionDisplayText,
  companionMentionRefs,
  successfulAgentMessages,
  publicAssistantText,
} from "../../../shared/agent-message";
import { companionPlainText, companionRulingFromToolCall } from "../../../shared/companion";
import { publicAgentEventSchema } from "../../../shared/game";
import type { AiConfig, ChatMessage } from "../../../shared/game";
import {
  parseMentionRefs,
  resolveMentionRefs,
  type Mention,
  type MentionTarget,
} from "../../../shared/mentions";
import { parseNarrative } from "../../../shared/narrative";
import { gameStatePrompt } from "../../sessions/game-context";
import { readLaunchConfig, readLaunchRoom } from "../../sessions/launch-db";
import { launchStart } from "../../sessions/launch-store";
import { isSessionActive, roomDirectory } from "../../sessions/session-store";
import { readCompactionSettings } from "../compaction-settings";
import { companionCharacters, companionContext, readCompanions } from "../companion";
import type { ChatDice } from "./dice";
import type { ChatInputBatches } from "./input-batches";
import type { ChatMentionQueue } from "./mention-queue";
import type { ChatNarration } from "./narration";
import type { ChatRunDiagnostics } from "./run-diagnostics";
import { createRunEventBuffer } from "./run-events";
import type { ChatSteering } from "./steering";
import type { ChatTurnQueue } from "./turn-queue";
import type { ChatContext, RoomState, RunOptions, CompanionChain, Runtime } from "./types";
import { isDirectMention, NoCompanionResponseError } from "./types";
type RunContext = Pick<ChatContext, "root" | "store" | "activity" | "credentials" | "isClosing"> & {
  runtime: Runtime;
  inputs: ChatInputBatches;
  steering: ChatSteering;
  queue: ChatTurnQueue;
  narration: ChatNarration;
  dice: Pick<ChatDice, "requestAndWaitForDice" | "failPending">;
  diagnostics: ChatRunDiagnostics;
  mentions: ChatMentionQueue;
};

/** AI 回合执行与队友接续。 */
export class ChatRuns {
  constructor(private readonly context: RunContext) {}

  actionCompanions(state: RoomState) {
    return readCompanions(state.db)
      .filter((item) => ["active", "eager"].includes(item.initiative.level))
      .map((item) => item.id);
  }

  afterActionChain(state: RoomState): CompanionChain {
    return {
      remainingIds: readCompanions(state.db)
        .filter((item) => item.initiative.level !== "active")
        .map((item) => item.id),
    };
  }

  reactToAction(state: RoomState, source: ChatMessage, ids: string[]) {
    this.context.mentions.defer(state, async (alive) => {
      await this.continueCompanions(
        state,
        source,
        {
          remainingIds: ids,
          beforeHost: { source },
        },
        new AbortController().signal,
        alive,
      );
    });
  }

  start(
    state: RoomState,
    message: ChatMessage,
    prompt: string,
    auth: { config: AiConfig },
    options: RunOptions = {},
  ) {
    if (state.closed) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭，请稍后重试" });
    message = { ...message, runId: message.runId ?? message.id };
    const abort = new AbortController();
    const running = {
      messageId: message.id,
      runId: message.runId ?? message.id,
      abort,
      done: Promise.resolve(),
    };
    const failDice = () => {
      try {
        this.context.dice.failPending(state, running.runId);
      } catch {
        /* 持久化失败时保留数据库状态，运行收尾及重启恢复会重试。 */
      }
    };
    abort.signal.addEventListener("abort", failDice, { once: true });
    this.context.activity.startRun(state, running);
    const resources = this.context.diagnostics.resources(state);
    state.events.emit("change");
    resources.metrics.start(message, auth.config.provider, auth.config.model);
    running.done = (async () => {
      let buffer = createRunEventBuffer(this.context.store, state, resources, message, abort);
      let companionMessages: Extract<ChatMessage, { kind: "assistant" }>["agentMessages"] = [];
      let hostTurn: string | undefined;
      let withdrewAction = false;
      let chatResponses: typeof companionMessages = [];
      let actionResponses: typeof companionMessages = [];
      let completed = false;
      let targets: MentionTarget[] = [];
      let mentions: Mention[] = [];
      let jobs: ReturnType<ChatMentionQueue["prepare"]> = [];
      let mentionChain = options.mentionChain;
      const hostMessageIds = new Set([message.id]);
      const hostMentionedIds = new Set<string>();
      try {
        buffer.model(auth.config.provider, auth.config.model);
        targets = await this.context.mentions.targets(state);
        const stateContext = options.companion
          ? await companionContext(state.db, options.companion, {
              targets,
              trigger: options.triggerMessage
                ? {
                    id: options.triggerMessage.id,
                    authorId: options.triggerMessage.senderId,
                    authorKind:
                      options.triggerMessage.kind === "assistant"
                        ? options.triggerMessage.companionId
                          ? "companion"
                          : "host"
                        : "player",
                    text: chatText(options.triggerMessage),
                    mentions: options.triggerMessage.mentions ?? [],
                  }
                : undefined,
            })
          : await gameStatePrompt(state.db);
        abort.signal.throwIfAborted();
        await this.context.runtime.run({
          roomDirectory: roomDirectory(this.context.root, message.roomId),
          messageId: message.id,
          requestId: options.requestId,
          text: options.companion
            ? `${stateContext}\n${isDirectMention(options) ? "你被直接 @ 了，请回应 trigger 中的具体消息，不要保持沉默。" : options.companionChain?.beforeHost ? `玩家刚发送了待裁定行动：${JSON.stringify(chatText(options.companionChain.beforeHost.source))}。判断是否提交自己的配合、准备或推进冒险的行动；只声明意图，不预先描述结果。没有必要则沉默。` : "请判断此刻是否需要回应，也可以声明推动冒险的行动。"}`
            : `${stateContext}\n${this.playerHostContext(targets)}\n${prompt}`,
          inputBatch: options.inputBatch,
          onInputReceived: (receipt) => {
            buffer.flush();
            this.context.inputs.receive(state, receipt);
            buffer.reload();
          },
          companion: options.companion,
          withdrawAction: options.companion
            ? async (messageId) => {
                abort.signal.throwIfAborted();
                const converted = this.context.store.transaction(state, () =>
                  this.context.queue.convertToChat(state, messageId, options.companion!.id),
                );
                withdrewAction = true;
                return converted;
              }
            : undefined,
          hostChat: options.hostChat,
          requireResponse: Boolean(options.companion && isDirectMention(options)),
          mentionTargets: targets,
          compaction: readCompactionSettings(state.db)[options.companion ? "companion" : "host"],
          ...auth,
          signal: abort.signal,
          initialSteering: options.steeringBatch,
          takeSteering:
            options.companion || options.hostChat
              ? undefined
              : () => {
                  if (abort.signal.aborted) return;
                  buffer.flush();
                  const latest = buffer.latest();
                  const next: ChatMessage = {
                    id: randomUUID(),
                    runId: running.runId,
                    sequence: 0,
                    revision: 0,
                    roomId: latest.roomId,
                    senderId: "agent",
                    nickname: "主持人",
                    kind: "assistant",
                    agentMessages: [],
                    attemptId: randomUUID(),
                    createdAt: new Date().toISOString(),
                    status: "running",
                    ...(latest.kind === "assistant" ? { modelInfo: latest.modelInfo } : {}),
                  };
                  return this.context.steering.claim(state, running.runId, latest, next);
                },
          onSteering:
            options.companion || options.hostChat
              ? undefined
              : (received) => {
                  buffer.flush();
                  const previous = buffer.latest();
                  const next = this.context.steering.receive(state, received);
                  buffer.close();
                  resources.liveDetails.finish(previous.id);
                  running.messageId = next.id;
                  hostMessageIds.add(next.id);
                  buffer = createRunEventBuffer(this.context.store, state, resources, next, abort);
                  resources.metrics.start(next, auth.config.provider, auth.config.model);
                  state.events.emit("change");
                },
          onDetail: options.companion ? undefined : (detail) => buffer.detail(detail),
          onHistory: (reference) => buffer.history(reference),
          rollDice:
            options.companion ||
            options.hostChat ||
            (readLaunchConfig(state.db) && readLaunchRoom(state.db).openingMessageId === message.id)
              ? undefined
              : async (options) => {
                  buffer.flush();
                  return this.context.dice.requestAndWaitForDice(
                    state,
                    buffer.latest(),
                    buffer.latest(),
                    options,
                    abort,
                  );
                },
          onContextWindow: (tokens) => {
            buffer.model(auth.config.provider, auth.config.model, tokens);
            resources.metrics.contextWindow(buffer.latest(), tokens);
            state.events.emit("change");
          },
          onAgentEvent: options.companion
            ? (event) => {
                if (abort.signal.aborted) return;
                const parsed = publicAgentEventSchema.parse(event);
                companionMessages = applyAgentParts(companionMessages, [parsed]);
                if (JSON.stringify(companionMessages).length > 100_000)
                  throw new Error("队友输出过长");
                if (
                  parsed.type === "toolcall_start" &&
                  (parsed.toolCall.name === "companion_perform" ||
                    parsed.toolCall.name === "companion_request_ruling")
                )
                  buffer.reveal();
                buffer.event(parsed);
              }
            : (event) => buffer.event(event),
        });
        if (options.inputBatch && !this.context.runtime.history) {
          buffer.flush();
          this.context.inputs.complete(state, message.id);
          buffer.reload();
        }
        if (options.companion) {
          abort.signal.throwIfAborted();
          const responses = successfulAgentMessages(companionMessages);
          const toolCalls = responses
            .flatMap((item) => item.content)
            .filter((part) => part.type === "toolCall");
          // 按工具调用分类，聊天中的点名不能把另行提交的行动降为聊天。
          const actionIds = new Set(
            toolCalls
              .filter((call) => {
                const ruling = companionRulingFromToolCall(call);
                return (
                  ruling &&
                  !resolveMentionRefs(parseMentionRefs(companionPlainText(ruling.intent)), targets)
                    .length
                );
              })
              .map((call) => call.id),
          );
          const project = (action: boolean) =>
            responses
              .map((response) => ({
                ...response,
                content: response.content.filter(
                  (part) => part.type === "toolCall" && actionIds.has(part.id) === action,
                ),
              }))
              .filter((response) => response.content.length);
          actionResponses = project(true);
          chatResponses = project(false);
          const ruling = [...toolCalls].reverse().find((call) => actionIds.has(call.id));
          hostTurn = ruling ? companionRulingFromToolCall(ruling)?.intent : undefined;
          mentions = resolveMentionRefs(companionMentionRefs(chatResponses), targets);
          if (isDirectMention(options) && !toolCalls.length && !withdrewAction)
            throw new NoCompanionResponseError();
        }
        const persistenceError = buffer.error();
        if (persistenceError) throw persistenceError;
        buffer.flush();
        let latest = buffer.latest();
        if (
          !abort.signal.aborted &&
          readLaunchConfig(state.db) &&
          readLaunchRoom(state.db).openingMessageId === latest.id &&
          launchStart(state.db).opening.mode === "ai" &&
          !chatText(latest).trim()
        )
          throw new Error("AI 开场未生成叙事");
        const manualHostTurn = Boolean(
          !abort.signal.aborted &&
          hostTurn &&
          (this.context.inputs.prepared(state).length > 0 ||
            this.context.queue.mode(state) === "manual" ||
            (readLaunchConfig(state.db) && readLaunchRoom(state.db).opening !== "complete")),
        );
        latest = this.context.store.transaction(
          state,
          () => {
            if (hostTurn && !abort.signal.aborted && options.companion) {
              this.context.queue.replacePending(state, options.companion.id);
            }
            if (hostTurn && chatResponses.length && latest.kind === "assistant") {
              const chat = this.context.store.save(state, {
                ...latest,
                agentMessages: chatResponses,
                internal: false,
                chatOnly: true,
                mentions: mentions.length ? mentions : undefined,
                status: "complete",
              });
              if (
                !options.singleTurn &&
                mentions.length &&
                !abort.signal.aborted &&
                !state.closed &&
                !this.context.isClosing() &&
                isSessionActive(state.db)
              )
                jobs.push(...this.context.mentions.prepare(state, chat, targets, mentionChain));
              latest = {
                ...latest,
                id: randomUUID(),
                sequence: 0,
                revision: 0,
                agentMessages: actionResponses,
                createdAt: new Date().toISOString(),
              };
              mentions = [];
            }
            if (!options.companion && !abort.signal.aborted) {
              for (const id of hostMessageIds) {
                const source = id === latest.id ? latest : this.context.store.message(state, id);
                if (source.kind !== "assistant") continue;
                const refs = successfulAgentMessages(source.agentMessages).flatMap((item) =>
                  parseNarrative(publicAssistantText(item)).flatMap((segment) =>
                    parseMentionRefs(segment.text),
                  ),
                );
                const confirmed = resolveMentionRefs(refs, targets);
                if (!confirmed.length) continue;
                mentionChain ??= this.context.mentions.chain(state);
                const savedSource = this.context.store.save(state, {
                  ...source,
                  mentions: confirmed,
                  status: "complete",
                });
                if (id === latest.id) latest = savedSource;
                for (const ref of confirmed) hostMentionedIds.add(ref.id);
                if (
                  !options.singleTurn &&
                  !state.closed &&
                  !this.context.isClosing() &&
                  isSessionActive(state.db)
                )
                  jobs.push(
                    ...this.context.mentions.prepare(state, savedSource, targets, mentionChain),
                  );
              }
            }
            const saved = this.context.store.save(state, {
              ...latest,
              ...(latest.kind === "assistant" && options.companion
                ? {
                    internal:
                      (!isDirectMention(options) || withdrewAction) &&
                      !companionDisplayText({ ...latest, status: "complete" }).trim(),
                    chatOnly: mentions.length > 0 || !hostTurn,
                    mentions: mentions.length ? mentions : undefined,
                    ...(hostTurn && !abort.signal.aborted
                      ? { pendingAgent: true, pendingAction: hostTurn }
                      : {}),
                  }
                : {}),
              status: abort.signal.aborted ? "cancelled" : "complete",
            });
            if (
              !abort.signal.aborted &&
              readLaunchConfig(state.db) &&
              readLaunchRoom(state.db).openingMessageId === latest.id
            )
              this.context.narration.completeOpening(state, latest.roomId);
            if (
              !options.singleTurn &&
              options.companion &&
              mentions.length &&
              !abort.signal.aborted &&
              !state.closed &&
              !this.context.isClosing() &&
              isSessionActive(state.db)
            )
              jobs = this.context.mentions.prepare(state, saved, targets, mentionChain);
            return saved;
          },
          () => this.context.mentions.register(state, jobs),
        );
        completed = true;
        if (
          !options.singleTurn &&
          !abort.signal.aborted &&
          !state.closed &&
          !this.context.isClosing() &&
          isSessionActive(state.db)
        ) {
          if (
            hostTurn ||
            options.react ||
            options.companionChain?.remainingIds.length ||
            options.companionChain?.beforeHost
          )
            this.context.mentions.defer(state, async (alive) => {
              if (!alive() || abort.signal.aborted) return;
              if (options.companionChain?.beforeHost) {
                await this.continueCompanions(
                  state,
                  latest,
                  options.companionChain,
                  abort.signal,
                  alive,
                );
                return;
              }
              if (hostTurn && !manualHostTurn) {
                const hostAuth = options.companion
                  ? await this.context.credentials(latest.roomId)
                  : auth;
                if (!alive() || abort.signal.aborted) return;
                if (this.context.queue.mode(state) === "auto") {
                  const pending = this.context.queue.pendingMessages(state);
                  if (!pending.length) return;
                  this.followup(
                    state,
                    latest,
                    this.context.queue.hostPrompt(
                      state,
                      this.context.queue.pendingTurns(state, pending),
                      pending,
                    ),
                    hostAuth,
                    {
                      companionChain: options.companionChain && {
                        remainingIds: [
                          ...new Set([
                            ...options.companionChain.remainingIds,
                            ...(!mentionChain
                              ? readCompanions(state.db)
                                  .filter((item) => item.initiative.level === "eager")
                                  .map((item) => item.id)
                              : []),
                          ]),
                        ],
                      },
                      mentionChain,
                      consumePending: pending,
                    },
                  );
                  return;
                }
              }
              let chain = options.companionChain;
              if (!hostTurn && options.react) {
                const ids = readCompanions(state.db).map((item) => item.id);
                // 轮换起点，避免每次都由同一名队友先表达观点。
                const offset = ids.length ? latest.sequence % ids.length : 0;
                chain = { remainingIds: [...ids.slice(offset), ...ids.slice(0, offset)] };
              }
              if (chain && hostMentionedIds.size)
                chain = {
                  ...chain,
                  remainingIds: chain.remainingIds.filter((id) => !hostMentionedIds.has(id)),
                };
              if (chain?.remainingIds.length)
                await this.continueCompanions(
                  state,
                  latest,
                  chain,
                  abort.signal,
                  alive,
                  options.mentionChain,
                );
            });
        }
      } catch (error) {
        if (completed) return;
        // 模型错误可能包含请求地址或凭据，公开记录使用固定错误信息。
        try {
          buffer.flush();
          const latest = buffer.latest();
          const persistenceFailed = Boolean(buffer.error());
          this.context.store.transaction(state, () =>
            this.context.store.save(state, {
              ...latest,
              status: abort.signal.aborted && !persistenceFailed ? "cancelled" : "failed",
              ...(error instanceof NoCompanionResponseError ? { internal: false } : {}),
              error:
                abort.signal.aborted && !persistenceFailed
                  ? undefined
                  : error instanceof NoCompanionResponseError
                    ? "队友未能生成有效回应，请重新点名。"
                    : latest.kind === "assistant" && latest.inputBatch?.state === "prepared"
                      ? "行动尚未送达主持，请房主重试或放弃该批次；期间可以仅聊天。"
                      : "生成失败，请检查模型配置或网络，然后发送新消息继续。",
            }),
          );
        } catch {
          /* 数据库不可写时不广播未持久化状态；重启时恢复为中断。 */
        }
        if (options.companionChain?.beforeHost && !abort.signal.aborted && !state.closed) {
          this.context.mentions.defer(state, async (alive) => {
            await this.continueCompanions(
              state,
              message,
              options.companionChain!,
              abort.signal,
              alive,
            );
          });
        }
      } finally {
        failDice();
        abort.signal.removeEventListener("abort", failDice);
        buffer.close();
        resources.liveDetails.finish(buffer.latest().id);
        this.context.activity.finishRun(state, running);
        // 预写开场要求运行槽空闲，必须等初始化运行释放后再触发播放。
        if (completed) this.context.narration.kickNarration(state, message.roomId);
        this.context.mentions.kick(state);
        if (!options.companion) {
          try {
            this.context.steering.hold(state, running.runId);
          } catch {
            /* 下次访问恢复。 */
          }
        }
        state.events.emit("change");
      }
    })();
  }

  private playerHostContext(targets: readonly MentionTarget[]) {
    const players = targets
      .filter((target) => target.kind !== "host")
      .map((target) => ({
        playerId: target.id,
        characterId: target.characterId,
        name: target.characterName ?? target.nickname,
      }));
    return `本轮玩家与控制角色（playerId 为点名身份）：${JSON.stringify(players)}`;
  }

  private async continueCompanions(
    state: RoomState,
    source: ChatMessage,
    chain: CompanionChain,
    signal: AbortSignal,
    alive: () => boolean = () => true,
    mentionChain?: RunOptions["mentionChain"],
  ) {
    if (mentionChain && mentionChain.started >= mentionChain.limit) return;
    if (
      chain.beforeHost &&
      !this.context.queue
        .pendingMessages(state)
        .some((item) => item.id === chain.beforeHost!.source.id)
    )
      return;
    const characters = await companionCharacters(state.db);
    const companions = readCompanions(state.db);
    for (let index = 0; index < chain.remainingIds.length; index++) {
      if (!alive() || signal.aborted || state.closed || this.context.isClosing()) return;
      const companion = companions.find((item) => item.id === chain.remainingIds[index]);
      const character =
        companion &&
        characters.find(
          (item) =>
            item.id === companion.characterId &&
            item.controllerId === companion.id &&
            item.aiConfigured,
        );
      if (!companion || !character) continue;
      if (chain.beforeHost) {
        if (
          this.context.queue
            .pendingMessages(state)
            .some((item) => item.kind === "assistant" && item.companionId === companion.id)
        )
          continue;
      }
      let auth;
      try {
        auth = await this.context.credentials(source.roomId, companion.model);
      } catch (error) {
        if (chain.beforeHost) continue;
        throw error;
      }
      if (!alive() || signal.aborted) return;
      if (mentionChain) mentionChain.started++;
      this.followup(
        state,
        source,
        "",
        auth,
        {
          companion,
          mentionChain,
          companionChain: { ...chain, remainingIds: chain.remainingIds.slice(index + 1) },
        },
        character.name,
      );
      return;
    }
    if (
      chain.beforeHost &&
      alive() &&
      !signal.aborted &&
      this.context.queue.mode(state) === "auto"
    ) {
      const auth = await this.context.credentials(source.roomId);
      if (!alive() || signal.aborted || this.context.queue.mode(state) !== "auto") return;
      const pending = this.context.queue.pendingMessages(state);
      if (!pending.some((item) => item.id === chain.beforeHost!.source.id)) return;
      this.followup(
        state,
        chain.beforeHost.source,
        this.context.queue.hostPrompt(
          state,
          this.context.queue.pendingTurns(state, pending),
          pending,
        ),
        auth,
        {
          consumePending: pending,
          companionChain: this.afterActionChain(state),
        },
      );
    }
  }

  followup(
    state: RoomState,
    source: ChatMessage,
    prompt: string,
    auth: { config: AiConfig },
    options: RunOptions,
    nickname = "主持人",
  ) {
    const result = this.context.store.transaction(state, () => {
      const existing =
        options.submission && this.context.store.submissionResult(state, options.submission);
      if (existing) return { message: existing, created: false };
      if (!options.companion && options.consumePending?.length) {
        this.context.inputs.assertResolved(state);
        options.inputBatch = this.context.inputs.create(
          options.consumePending.map((item) => item.id),
          this.context.queue.pendingTurns(state, options.consumePending),
        );
        this.context.queue.consumePending(state, options.consumePending);
      }
      const next = this.context.store.save(state, {
        id: randomUUID(),
        sequence: 0,
        revision: 0,
        roomId: source.roomId,
        senderId: options.companion?.id ?? "agent",
        nickname,
        companionId: options.companion?.id,
        ...(options.companion && !isDirectMention(options) ? { internal: true } : {}),
        createdAt: new Date().toISOString(),
        kind: "assistant",
        agentMessages: [],
        ...(options.inputBatch ? { inputBatch: options.inputBatch } : {}),
        attemptId: randomUUID(),
        status: "running",
      });
      if (options.inputBatch) this.context.inputs.save(state, next.id, options.inputBatch);
      if (options.submission) this.context.store.saveSubmission(state, options.submission, next.id);
      return { message: next, created: true };
    });
    if (result.created)
      this.start(state, result.message, prompt, auth, {
        ...options,
        requestId: options.requestId ?? source.id,
      });
    return result.message;
  }
}
