import { agentDetailSchema, type AgentDetail } from "../../../shared/agent-details";
import { publicAgentEventSchema } from "../../../shared/game";
import type { PublicAgentEvent, ChatMessage, PiMessageReference } from "../../../shared/game";
import type { RunResources } from "./run-diagnostics";
import type { ChatStore } from "./store";
import type { RoomState } from "./types";
export function createRunEventBuffer(
  store: ChatStore,
  state: RoomState,
  resources: RunResources,
  message: ChatMessage,
  abort: AbortController,
) {
  let latest = message;
  let pendingEvents: PublicAgentEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let persistenceError: unknown;
  const toolIds = new Set<string>();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pendingEvents.length && latest.kind === "assistant") {
      const events = pendingEvents;
      latest = store.appendAgentEvents(state, latest, events);
      pendingEvents = [];
    }
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      try {
        flush();
      } catch (error) {
        persistenceError = error;
        abort.abort();
      }
    }, 100);
  };
  const update = (change: Partial<Extract<ChatMessage, { kind: "assistant" }>>) => {
    try {
      flush();
      if (latest.kind !== "assistant") return;
      const next = { ...latest, ...change };
      latest = store.transaction(state, () => store.save(state, next));
    } catch (error) {
      persistenceError = error;
      abort.abort();
      throw error;
    }
  };
  return {
    reload: () => {
      flush();
      latest = store.message(state, latest.id);
    },
    history: (pi: PiMessageReference) => update({ pi }),
    model: (provider: string, model: string, contextWindow?: number) =>
      update({ modelInfo: { provider, model, contextWindow } }),
    flush,
    latest: () => latest,
    error: () => persistenceError,
    reveal: () => {
      flush();
      if (latest.kind !== "assistant" || !latest.internal) return;
      const assistant = latest;
      latest = store.transaction(state, () => store.save(state, { ...assistant, internal: false }));
    },
    detail: (raw: AgentDetail) => {
      const detail = agentDetailSchema.parse(raw);
      const firstTool = detail.kind === "tool" && !toolIds.has(detail.id);
      resources.liveDetails.set(message.id, detail);
      if (firstTool) {
        toolIds.add(detail.id);
        resources.metrics.recordTool(message.id);
      }
      if (firstTool) state.events.emit("change");
    },
    event: (raw: PublicAgentEvent) => {
      const event = publicAgentEventSchema.parse(raw);
      if (event.type === "usage") {
        pendingEvents = pendingEvents.filter(
          (pending) => pending.type !== "usage" || pending.messageIndex !== event.messageIndex,
        );
      }
      const last = pendingEvents.at(-1);
      if (
        event.type === "text_delta" &&
        last?.type === "text_delta" &&
        event.messageIndex === last.messageIndex &&
        event.contentIndex === last.contentIndex
      )
        last.delta += event.delta;
      else pendingEvents.push(event);
      if (event.type === "message_end") flush();
      else schedule();
    },
    close: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
