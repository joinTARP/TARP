import { randomUUID } from "node:crypto";

import { chatText } from "../../../shared/agent-message";
import type { ChatMessage, Player } from "../../../shared/game";
import { mentionReplyLimitSchema, type MentionTarget } from "../../../shared/mentions";
import { readRoomSettings, updateRoomSettings } from "../../sessions/room-settings";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { publicMentionTargets, readCompanions } from "../companion";
import { playerTurnPrompt } from "../player-turn";
import type { ChatContext, RoomState, RunOptions, ChatAuth, MentionChain } from "./types";

type Reply = Extract<ChatMessage, { kind: "assistant" }>;
interface Job {
  priority: "human" | "automatic";
  message?: Reply;
  run: (alive: () => boolean) => Promise<void>;
}
interface Queue {
  jobs: Job[];
  epoch: number;
  working?: Job;
  draining?: Promise<void>;
}

/** 点名与自动接续共用调度边界，和主持待提交行动队列完全独立。 */
export class ChatMentionQueue {
  private rooms = new WeakMap<RoomState, Queue>();
  private start!: (
    state: RoomState,
    message: ChatMessage,
    prompt: string,
    auth: ChatAuth,
    options: RunOptions,
  ) => void;
  constructor(
    private readonly context: Pick<
      ChatContext,
      "state" | "store" | "activity" | "credentials" | "isClosing"
    >,
  ) {}
  attach(start: ChatMentionQueue["start"]) {
    this.start = start;
  }
  private queue(state: RoomState) {
    let queue = this.rooms.get(state);
    if (!queue) this.rooms.set(state, (queue = { jobs: [], epoch: 0 }));
    return queue;
  }
  async targets(state: RoomState, viewer?: Player) {
    if (viewer) this.context.activity.updatePlayer(state, viewer);
    const targets = await publicMentionTargets(state.db, [
      ...this.context.activity.players(state),
      ...(viewer ? [viewer] : []),
    ]);
    // 真人输入排除本人；AI 上下文仍保留完整参与者身份。
    return viewer ? targets.filter((target) => target.id !== viewer.id) : targets;
  }
  chain(state: RoomState): MentionChain {
    return {
      limit: readRoomSettings(roomDirectoryForDatabase(state.db)).chat.mentionReplyLimit,
      started: 0,
    };
  }
  async setLimit(roomId: string, input: number) {
    const limit = mentionReplyLimitSchema.parse(input);
    const state = await this.context.state(roomId);
    updateRoomSettings(roomDirectoryForDatabase(state.db), (settings) => ({
      ...settings,
      chat: { ...settings.chat, mentionReplyLimit: limit },
    }));
    state.events.emit("change");
    return limit;
  }
  /** 与触发消息共用写事务；提交前不注册或启动内存任务。 */
  prepare(
    state: RoomState,
    source: ChatMessage,
    targets: readonly MentionTarget[],
    chain = this.chain(state),
  ) {
    const jobs: Job[] = [];
    const byId = new Map(targets.map((target) => [target.id, target]));
    // 只调度由正文身份链接解析并经主机确认的点名目标。
    for (const mention of source.mentions ?? []) {
      const target = byId.get(mention.id);
      if (!target) continue;
      if (target.kind === "player" || target.id === source.senderId) continue;
      const hostChat = target.kind === "host";
      const message = this.context.store.save(state, {
        id: randomUUID(),
        roomId: source.roomId,
        sequence: 0,
        revision: 0,
        senderId: target.id,
        ...(hostChat ? { chatOnly: true } : { companionId: target.id }),
        nickname: target.characterName ?? target.nickname,
        createdAt: new Date().toISOString(),
        kind: "assistant",
        agentMessages: [],
        status: "queued",
        replyToMessageId: source.id,
        attemptId: randomUUID(),
      }) as Reply;
      const job: Job = {
        priority: source.kind === "player" ? "human" : "automatic",
        message,
        run: async (alive) => {
          if (chain.started >= chain.limit) {
            this.finishQueued(state, message, "已达到本轮连续响应上限。请发送新消息继续交流。");
            return;
          }
          if (hostChat) {
            const auth = await this.context.credentials(source.roomId);
            if (!alive()) return;
            chain.started++;
            const running = this.context.store.transaction(state, () =>
              this.context.store.save(state, { ...message, status: "running" }),
            );
            this.start(
              state,
              running,
              `本轮输入用途：主持场外聊天，不提交角色行动。\n${playerTurnPrompt([{ playerId: source.senderId, text: chatText(source) }])}`,
              auth,
              { hostChat: true, requestId: source.id, mentionChain: chain },
            );
            return;
          }
          const current = (await this.targets(state)).find(
            (item) => item.id === target.id && item.kind === "companion",
          );
          const companion = readCompanions(state.db).find((item) => item.id === target.id);
          if (!alive()) return;
          if (!current || !companion) {
            this.finishQueued(state, message, "队友已不可用，取消本次响应。");
            return;
          }
          const auth = await this.context.credentials(source.roomId, companion.model);
          if (!alive()) return;
          chain.started++;
          const running = this.context.store.transaction(state, () =>
            this.context.store.save(state, { ...message, status: "running" }),
          );
          this.start(state, running, "", auth, {
            companion,
            mentionChain: chain,
            triggerMessage: source,
            requestId: source.id,
          });
        },
      };
      jobs.push(job);
    }
    return jobs;
  }
  /** 在事务提交后、公开通知发布前同步登记所有已保存回应。 */
  register(state: RoomState, jobs: readonly Job[]) {
    this.queue(state).jobs.push(...jobs);
  }
  defer(state: RoomState, run: (alive: () => boolean) => Promise<void>) {
    this.queue(state).jobs.push({
      priority: "automatic",
      run: async (alive) => {
        if (alive()) await run(alive);
      },
    });
    this.kick(state);
  }
  owns(state: RoomState, id: string) {
    const queue = this.queue(state);
    return queue.working?.message?.id === id || queue.jobs.some((job) => job.message?.id === id);
  }
  private finishQueued(
    state: RoomState,
    message: Reply,
    error?: string,
    status: "cancelled" | "failed" = "cancelled",
  ) {
    this.context.store.transaction(state, () =>
      this.context.store.save(state, { ...message, status, error }),
    );
  }
  cancel(state: RoomState) {
    const queue = this.queue(state);
    queue.epoch++;
    for (const job of [...queue.jobs, ...(queue.working ? [queue.working] : [])])
      if (job.message && this.context.store.message(state, job.message.id).status === "queued")
        this.finishQueued(state, job.message);
    queue.jobs = [];
  }
  async settled(state: RoomState) {
    await this.queue(state).draining;
  }
  kick(state: RoomState) {
    const queue = this.queue(state);
    if (
      queue.draining ||
      this.context.activity.running(state) ||
      state.closed ||
      this.context.isClosing() ||
      !queue.jobs.length
    )
      return;
    if (this.context.activity.isConfiguring(state)) {
      queue.draining = this.context.activity.settled(state).finally(() => {
        queue.draining = undefined;
        this.kick(state);
      });
      return;
    }
    queue.draining = (async () => {
      while (
        !this.context.activity.running(state) &&
        !state.closed &&
        !this.context.isClosing() &&
        queue.jobs.length
      ) {
        const firstHuman = queue.jobs.findIndex((job) => job.priority === "human");
        const job = queue.jobs.splice(firstHuman < 0 ? 0 : firstHuman, 1)[0]!;
        const epoch = queue.epoch;
        queue.working = job;
        const alive = () => epoch === queue.epoch && !state.closed && !this.context.isClosing();
        // 凭据与身份准备期间保护唯一运行槽；新的点名聊天仍可正常入队。
        const finish = this.context.activity.beginHandoff(state);
        try {
          await job.run(alive);
        } catch {
          if (alive() && job.message)
            this.finishQueued(
              state,
              job.message,
              `无法启动${job.message.companionId ? "队友" : "主持"}响应，请检查模型连接后重新点名。`,
              "failed",
            );
        } finally {
          finish();
          queue.working = undefined;
        }
      }
    })().finally(() => {
      queue.draining = undefined;
      this.kick(state);
    });
  }
}
