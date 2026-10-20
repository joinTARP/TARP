import { messageSchema, type ChatMessage } from "../../shared/game";
import type { SessionActorMetrics, SessionMetrics } from "../../shared/session-metrics";
import type { PiHistory, PiMessageSummary } from "../agent/pi-history";
import { chatField } from "../storage/session-database";
import type { SessionDatabase } from "../storage/session-database";
import { chatEvents } from "./chat/events";
import { companionCharacters, readCompanions } from "./companion";

type Totals = { -readonly [K in keyof SessionActorMetrics["totals"]]: number };
type Assistant = Extract<ChatMessage, { kind: "assistant" }>;
interface MessageMetrics {
  usageTimestamp?: number;
  id: string;
  sequence: number;
  history?: PiMessageSummary;
  name: string;
  current: SessionActorMetrics["current"];
  totals: Totals;
  publicToolCalls: number;
}
interface ActorMetrics {
  messages: Map<string, MessageMetrics>;
  latest?: MessageMetrics;
  lastMeasured?: MessageMetrics;
  totals: Totals;
}
interface RunMetadata {
  messageId: string;
  provider: string;
  model: string;
  contextWindow?: number;
}
function emptyTotals(): Totals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    attempts: 0,
    completedAttempts: 0,
    toolCalls: 0,
  };
}
function addTotals(target: Totals, value: Totals, sign = 1) {
  for (const key of Object.keys(target) as (keyof Totals)[]) target[key] += sign * value[key];
}
function messageMetrics(message: Assistant, toolCalls: number): MessageMetrics {
  const totals = emptyTotals();
  totals.attempts = Number(Boolean(message.modelInfo || message.agentMessages.length));
  totals.completedAttempts = Number(message.status === "complete");
  let publicToolCalls = 0;
  for (const item of message.agentMessages) {
    const { usage } = item;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.reasoning += usage.reasoning ?? 0;
    totals.totalTokens += usage.totalTokens;
    totals.cost += usage.cost.total;
    publicToolCalls += item.content.filter((part) => part.type === "toolCall").length;
  }
  totals.toolCalls = Math.max(publicToolCalls, toolCalls);
  const last = [...message.agentMessages]
    .reverse()
    .find((item) => item.usage.input + item.usage.cacheRead > 0);
  return {
    id: message.id,
    sequence: message.sequence,
    name: message.nickname,
    publicToolCalls,
    totals,
    usageTimestamp: last?.timestamp,
    current: {
      provider: message.modelInfo?.provider ?? last?.provider ?? null,
      model: message.modelInfo?.model ?? last?.model ?? null,
      status: message.status === "queued" ? "idle" : message.status,
      startedAt: message.createdAt,
      contextTokens: last ? last.usage.input + last.usage.cacheRead : 0,
      contextWindow: message.modelInfo?.contextWindow ?? null,
    },
  };
}

/** 首次恢复扫描存档，随后只读取已提交通知中变动的消息；不缓存正文或幕后详情。 */
export class RoomMetrics {
  compactingActorId?: string;
  private initialized = false;
  private release: () => void;
  private actors = new Map<string, ActorMetrics>();
  private liveToolCalls = new Map<string, number>();
  private changedMessages = new Set<string>();
  // 当前模型信息只保留每个角色最近一次运行。
  private metadata = new Map<string, RunMetadata>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private db: SessionDatabase,
    private room: string,
    private history: PiHistory,
  ) {
    this.release = chatEvents(db).onMessage((id) => this.changedMessages.add(id));
  }
  close() {
    this.release();
  }

  start(message: ChatMessage, provider: string, model: string) {
    if (message.kind !== "assistant") return;
    this.metadata.set(message.companionId ?? "host", { messageId: message.id, provider, model });
  }
  contextWindow(message: ChatMessage, tokens: number) {
    if (message.kind !== "assistant") return;
    const metadata = this.metadata.get(message.companionId ?? "host");
    if (metadata && metadata.messageId === message.id) metadata.contextWindow = tokens;
  }
  recordTool(messageId: string) {
    this.liveToolCalls.set(messageId, (this.liveToolCalls.get(messageId) ?? 0) + 1);
    this.changedMessages.add(messageId);
  }
  private actor(id: string) {
    let actor = this.actors.get(id);
    if (!actor) {
      actor = { messages: new Map(), totals: emptyTotals() };
      this.actors.set(id, actor);
    }
    return actor;
  }
  private async update(message: Assistant) {
    const persisted = await this.history.summary(this.room, message);
    const actor = this.actor(message.companionId ?? "host");
    const previous = actor.messages.get(message.id);
    const live = this.liveToolCalls.get(message.id) ?? 0;
    const next = messageMetrics(message, Math.max(live, persisted?.toolCalls ?? 0));
    next.history = persisted;
    if (previous) addTotals(actor.totals, previous.totals, -1);
    addTotals(actor.totals, next.totals);
    actor.messages.set(message.id, next);
    if (!actor.latest || next.sequence >= actor.latest.sequence) actor.latest = next;
    if (
      next.current.contextTokens &&
      (!actor.lastMeasured || next.sequence >= actor.lastMeasured.sequence)
    )
      actor.lastMeasured = next;
    if (message.status !== "running" && persisted && persisted.toolCalls >= live)
      this.liveToolCalls.delete(message.id);
  }
  private async syncMessages() {
    const ids = new Set(this.changedMessages);
    this.changedMessages.clear();
    const messages: Assistant[] = [];
    if (!this.initialized) {
      for (const row of this.db.all(
        this.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("kind"), "=", "assistant")
          .orderBy("sequence", "asc"),
      )) {
        const message = messageSchema.parse(JSON.parse(String(row.data)));
        if (message.kind === "assistant") messages.push(message);
      }
    } else if (ids.size) {
      const query = this.db.query.selectFrom("chat_messages").select("data");
      for (const id of ids) {
        const row = this.db.get(query.where("id", "=", id));
        if (!row) continue;
        const message = messageSchema.parse(JSON.parse(String(row.data)));
        if (message.kind === "assistant") messages.push(message);
      }
    }
    try {
      await Promise.all(messages.map((message) => this.update(message)));
      this.initialized = true;
    } catch (error) {
      for (const message of messages) this.changedMessages.add(message.id);
      throw error;
    }
  }
  read(): Promise<SessionMetrics> {
    const result = this.queue.then(() => this.snapshot());
    this.queue = result.catch(() => undefined);
    return result;
  }
  async settled() {
    await this.queue;
  }
  private async snapshot(): Promise<SessionMetrics> {
    await this.syncMessages();
    this.actor("host");
    const configured = readCompanions(this.db);
    const characters = configured.length
      ? await companionCharacters(
          this.db,
          configured.map((companion) => companion.characterId),
        )
      : [];
    const names = new Map(
      [...this.actors]
        .filter(([id]) => id !== "host")
        .map(([id, actor]) => [id, actor.latest!.name]),
    );
    for (const companion of configured)
      names.set(
        companion.id,
        characters.find((item) => item.id === companion.characterId)?.name ?? "AI 队友",
      );
    const summarize = async (id: string, name: string): Promise<SessionActorMetrics> => {
      const actor = this.actors.get(id);
      const latest = actor?.latest;
      const saved = latest?.history;
      const metadata = this.metadata.get(id);
      const live = metadata?.messageId === latest?.id ? metadata : undefined;
      const persistedContext = await this.history.contextTokens(
        this.room,
        id === "host" ? undefined : id,
        latest?.current.status === "running" &&
          latest.current.contextTokens &&
          latest.usageTimestamp !== undefined
          ? { tokens: latest.current.contextTokens, timestamp: latest.usageTimestamp }
          : undefined,
      );
      const contextTokens =
        persistedContext !== undefined
          ? persistedContext
          : (actor?.lastMeasured?.current.contextTokens ?? 0);
      return {
        id,
        name,
        current: {
          provider: saved?.provider ?? live?.provider ?? latest?.current.provider ?? null,
          model: saved?.model ?? live?.model ?? latest?.current.model ?? null,
          status: latest?.current.status ?? "idle",
          startedAt: latest?.current.startedAt ?? null,
          contextTokens,
          contextWindow: live?.contextWindow ?? latest?.current.contextWindow ?? null,
        },
        totals: { ...(actor?.totals ?? emptyTotals()) },
      };
    };
    const [host, ...companions] = await Promise.all([
      summarize("host", "主持人"),
      ...[...names].map(([id, name]) => summarize(id, name)),
    ]);
    const totals = { ...host.totals };
    for (const companion of companions) addTotals(totals, companion.totals);
    return {
      host: host!,
      companions,
      totals,
      ...(this.compactingActorId ? { compactingActorId: this.compactingActorId } : {}),
    };
  }
}
