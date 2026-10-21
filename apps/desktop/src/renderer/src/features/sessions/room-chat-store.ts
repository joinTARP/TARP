import { applyChatEvent } from "@jointarp/core/shared/agent-message";
import type {
  ChatEvent,
  ChatMessage,
  SubmissionModeSnapshot,
  SteeringSnapshot,
} from "@jointarp/core/shared/game";

import { mergeMessages, type GameClient } from "./game-client";

export interface RoomChatSnapshot {
  messages: ChatMessage[];
  submissionMode: SubmissionModeSnapshot;
  pendingMessageIds: string[];
  hasMore: boolean;
  initialized: boolean;
  steering: SteeringSnapshot;
  isHost: boolean;
}
export function emptyRoomChat(): RoomChatSnapshot {
  return {
    messages: [],
    submissionMode: { mode: "auto", revision: 0 },
    pendingMessageIds: [],
    hasMore: false,
    initialized: false,
    steering: { enabled: false, revision: 0, entries: [] },
    isHost: false,
  };
}

/** 消息、提交模式和待提交集合的唯一状态归属，统一合并通知、响应和历史。 */
export class RoomChatStore {
  private state = emptyRoomChat();
  private submissionModeKnown = false;
  private listeners = new Set<() => void>();
  private historyRequest?: Promise<ChatMessage[]>;
  private historyEpoch = 0;
  private refreshRequest?: Promise<Awaited<ReturnType<GameClient["chat"]["history"]>>>;
  constructor(
    private readonly client: GameClient,
    private readonly roomId: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<RoomChatSnapshot>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  initialize(page: Omit<RoomChatSnapshot, "initialized">) {
    const submissionMode = this.acceptSubmissionMode(page.submissionMode);
    this.publish({
      messages: page.messages,
      submissionMode,
      pendingMessageIds: page.pendingMessageIds,
      hasMore: page.hasMore,
      initialized: true,
      steering:
        page.steering.revision >= this.state.steering.revision
          ? page.steering
          : this.state.steering,
      isHost: page.isHost,
    });
  }
  reset() {
    this.historyEpoch++;
    this.submissionModeKnown = false;
    this.publish(emptyRoomChat());
  }
  async refresh(signal: AbortSignal) {
    if (this.refreshRequest) return this.refreshRequest;
    const oldestLoaded = this.state.messages[0]?.sequence;
    const epoch = ++this.historyEpoch;
    const request = (async () => {
      const first = await this.client.chat.history({ roomId: this.roomId, limit: 100 }, { signal });
      signal.throwIfAborted();
      let page = first;
      let messages = page.messages;
      while (
        oldestLoaded !== undefined &&
        page.hasMore &&
        page.messages[0] &&
        page.messages[0].sequence > oldestLoaded
      ) {
        page = await this.client.chat.history(
          { roomId: this.roomId, limit: 100, beforeSequence: page.messages[0].sequence },
          { signal },
        );
        signal.throwIfAborted();
        if (page.streamId !== first.streamId)
          throw Object.assign(new Error("聊天通知已更新，请重新同步"), {
            code: "PRECONDITION_FAILED",
            data: { reason: "CHAT_RESYNC_REQUIRED" },
          });
        if (!page.messages.length) break;
        messages = mergeMessages(messages, page.messages);
      }
      if (epoch === this.historyEpoch)
        this.initialize({ ...first, messages, hasMore: page.hasMore });
      return first;
    })();
    this.refreshRequest = request;
    try {
      return await request;
    } finally {
      if (this.refreshRequest === request) this.refreshRequest = undefined;
    }
  }
  acceptSteering(snapshot: SteeringSnapshot) {
    if (snapshot.revision > this.state.steering.revision) this.publish({ steering: snapshot });
  }
  confirmSubmissionMode(snapshot: SubmissionModeSnapshot) {
    const submissionMode = this.acceptSubmissionMode(snapshot);
    if (submissionMode !== this.state.submissionMode) this.publish({ submissionMode });
  }
  private acceptSubmissionMode(snapshot: SubmissionModeSnapshot) {
    if (this.submissionModeKnown && snapshot.revision <= this.state.submissionMode.revision)
      return this.state.submissionMode;
    this.submissionModeKnown = true;
    return snapshot;
  }

  private publishMessages(
    messages: ChatMessage[],
    changedIds: readonly string[],
    change: Partial<Pick<RoomChatSnapshot, "hasMore">> = {},
  ) {
    const changed = new Set(changedIds);
    const pending = new Set(this.state.pendingMessageIds);
    for (const message of messages) {
      if (!changed.has(message.id)) continue;
      if (message.pendingAgent) pending.add(message.id);
      else pending.delete(message.id);
    }
    const previous = this.state.pendingMessageIds;
    const pendingMessageIds =
      pending.size === previous.length && previous.every((id) => pending.has(id))
        ? previous
        : [...pending];
    this.publish({ ...change, messages, pendingMessageIds });
  }
  acceptMessage(message: ChatMessage) {
    const previous = this.state.messages.find((item) => item.id === message.id);
    if (previous && previous.revision >= message.revision) return;
    this.publishMessages(mergeMessages(this.state.messages, [message]), [message.id]);
  }
  applyEvent(event: ChatEvent) {
    if (event.type === "steering") {
      this.acceptSteering(event.snapshot);
      return;
    }
    if (event.type === "mode") {
      this.confirmSubmissionMode(event.snapshot);
      return;
    }
    if (event.type === "message") {
      this.acceptMessage(event.message);
      return;
    }
    const messages = applyChatEvent(this.state.messages, event);
    if (messages !== this.state.messages) this.publishMessages(messages, [event.messageId]);
  }
  async loadOlder(signal?: AbortSignal) {
    await this.refreshRequest;
    // 所有面板共享分页边界；等待另一个面板加载时不发出重复请求。
    if (this.historyRequest) return this.historyRequest;
    if (!this.state.hasMore || !this.state.messages.length) return [];
    const beforeSequence = this.state.messages[0].sequence;
    const epoch = this.historyEpoch;
    const request = (async () => {
      const page = await this.client.chat.history(
        { roomId: this.roomId, beforeSequence },
        { signal },
      );
      if (signal?.aborted || epoch !== this.historyEpoch) return [];
      this.publishMessages(
        mergeMessages(this.state.messages, page.messages),
        page.messages.map((message) => message.id),
        { hasMore: page.hasMore },
      );
      return page.messages;
    })();
    this.historyRequest = request;
    try {
      return await request;
    } finally {
      if (this.historyRequest === request) this.historyRequest = undefined;
    }
  }
}
