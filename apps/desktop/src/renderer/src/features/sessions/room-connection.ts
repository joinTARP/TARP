import { publicValues, type Character } from "@jointarp/module/character";
import { documentIdentity } from "@jointarp/module/document-path";
import { visibleDocumentProjection } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";
import type { ChatEvent } from "@tarp/core/shared/game";
import {
  ROOM_PROTOCOL_VERSION,
  type RoomReplica,
  type SessionModuleResources,
  type RoomEntity,
} from "@tarp/core/shared/room-state";

import type { RendererDocumentEvaluator } from "../documents/computation/document-worker-protocol";
import { WorkerDocumentEvaluator } from "../documents/computation/worker-document-evaluator";
import { reconnectDelay, type GameClient } from "./game-client";
import { RoomChatStore, emptyRoomChat, type RoomChatSnapshot } from "./room-chat-store";
import { RoomStateStore } from "./room-state-store";

/** 取消单个读取者不会取消其他面板共享的计算。 */
function withCallerAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("读取已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function baselineMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "BASELINE_MISMATCH") return true;
  return (
    error.code === "PRECONDITION_FAILED" &&
    "data" in error &&
    !!error.data &&
    typeof error.data === "object" &&
    "reason" in error.data &&
    error.data.reason === "BASELINE_MISMATCH"
  );
}

export interface LocalRoomModuleLoader {
  resources(roomId: string, signal: AbortSignal): Promise<SessionModuleResources>;
}

export interface RoomConnectionSnapshot extends RoomChatSnapshot {
  replica?: RoomReplica;
  resources?: SessionModuleResources;
  connected: boolean;
  error?: Error;
}

/** 同一个认证客户端和房间的所有面板共享一条房间通知流。 */
export class RoomConnection {
  private state: RoomConnectionSnapshot = {
    ...emptyRoomChat(),
    connected: false,
  };
  readonly chat: RoomChatStore;
  private connectionState: Pick<RoomConnectionSnapshot, "connected" | "error"> = {
    connected: false,
  };
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: ChatEvent) => void>();
  private controller?: AbortController;
  private references = 0;
  private cursor = 0;
  private chatStreamId = "";
  private replica?: RoomStateStore;
  constructor(
    readonly client: GameClient,
    readonly roomId: string,
    readonly localModule: LocalRoomModuleLoader,
    private readonly createEvaluator: () => RendererDocumentEvaluator = () =>
      new WorkerDocumentEvaluator(),
  ) {
    this.chat = new RoomChatStore(client, roomId);
    this.chat.subscribe(() => this.publish(this.chat.getSnapshot()));
  }
  private moduleEpoch = 0;
  private evaluator?: RendererDocumentEvaluator;
  private evaluatorRevision?: number;
  private details = new Map<string, { version: number; promise: Promise<ModuleDocument> }>();
  private documentNames = new Map<string, { version: number; promise: Promise<ModuleDocument> }>();
  private drafts = new Map<string, Promise<ModuleDocument>>();
  private evaluatorItem(entity: RoomEntity) {
    const documentType = this.state.resources!.documentTypes.find(
      (type) => type.id === entity.document.docType,
    );
    const { computed, ...document } = entity.document;
    return documentType
      ? {
          identity: documentIdentity(entity.document.path),
          documentType,
          values: entity.document.values ?? {},
          document,
          computed,
        }
      : entity.document;
  }
  private updateEvaluator() {
    const { replica, resources } = this.state;
    if (!replica || !resources) throw new Error("房间资料尚未同步");
    if (!this.evaluator) {
      this.evaluator = this.createEvaluator();
      this.evaluator.setSnapshot(
        replica.documentRevision,
        Object.values(replica.entities).map((entity) => this.evaluatorItem(entity)),
      );
      this.evaluatorRevision = replica.documentRevision;
    }
    return this.evaluator;
  }
  private syncEvaluator(previous: RoomReplica | undefined, current: RoomReplica) {
    if (!this.evaluator || this.evaluatorRevision === current.documentRevision) return;
    const changed = [];
    const removed: string[] = [];
    for (const id of this.replica!.getChangedEntityIds()) {
      const before = previous?.entities[id];
      const entity = current.entities[id];
      if (before && (!entity || before.document.path !== entity.document.path))
        removed.push(before.document.path);
      if (entity) changed.push(this.evaluatorItem(entity));
    }
    this.evaluator.updateSnapshot(current.documentRevision, changed, removed);
    this.evaluatorRevision = current.documentRevision;
    this.details.clear();
    this.documentNames.clear();
    this.drafts.clear();
  }
  /** 未匹配的 NPC 发言才读取候选名称，避免解析候选头像及正文。 */
  loadDocumentName(entity: RoomEntity, signal: AbortSignal): Promise<ModuleDocument> {
    return this.loadEntityDocument(entity, signal, "name");
  }

  loadDocument(entity: RoomEntity, signal: AbortSignal): Promise<ModuleDocument> {
    return this.loadEntityDocument(entity, signal, "full");
  }

  private loadEntityDocument(
    entity: RoomEntity,
    signal: AbortSignal,
    mode: "name" | "full",
  ): Promise<ModuleDocument> {
    signal.throwIfAborted();
    const path = entity.document.path;
    const cache = mode === "name" ? this.documentNames : this.details;
    const read = (): Promise<ModuleDocument> => {
      const evaluator = this.updateEvaluator();
      const version = this.evaluatorRevision!;
      // 全文结果可以满足名称读取，名称结果不能替代全文。
      const cached = this.details.get(path) ?? cache.get(path);
      if (cached?.version === version) return cached.promise;
      const epoch = this.moduleEpoch;
      const pending = (async () => {
        let document: ModuleDocument;
        try {
          document = await (mode === "name"
            ? evaluator.readDocumentName(path)
            : evaluator.readDocument(path));
        } catch (error) {
          if (epoch === this.moduleEpoch && this.state.replica?.documentRevision !== version)
            return read();
          throw error;
        }
        if (epoch !== this.moduleEpoch) throw new Error("本地模组已重新读取");
        if (this.state.replica?.documentRevision !== version) return read();
        if (mode === "name")
          return visibleDocumentProjection({
            path: document.path,
            title: document.title,
            docType: document.docType,
            valid: document.valid,
            visible: document.visible,
          });
        const type = this.state.resources?.documentTypes.find(
          (item) => item.id === document.docType,
        );
        return visibleDocumentProjection(
          type && document.values
            ? {
                ...document,
                values: publicValues(type.fields, document.values as Record<string, unknown>),
              }
            : document,
        );
      })();
      cache.set(path, { version, promise: pending });
      void pending.catch(() => {
        if (cache.get(path)?.promise === pending) cache.delete(path);
      });
      return pending;
    };
    return withCallerAbort(read(), signal);
  }
  loadDraft(draft: Character, signal: AbortSignal): Promise<ModuleDocument> {
    signal.throwIfAborted();
    const evaluator = this.updateEvaluator();
    const version = this.evaluatorRevision!;
    const key = JSON.stringify([version, draft]);
    const cached = this.drafts.get(key);
    if (cached) return withCallerAbort(cached, signal);
    const epoch = this.moduleEpoch;
    const documentType = this.state.resources!.documentTypes.find(
      (type) => type.id === draft.typeId,
    );
    if (!documentType) return Promise.reject(new Error(`角色类型不存在：${draft.typeId}`));
    const path = draft.sourcePath ?? `${draft.typeId}/draft.json`;
    const assertCurrent = () => {
      if (epoch !== this.moduleEpoch || this.state.replica?.documentRevision !== version)
        throw new Error("草稿资料版本已变化");
    };
    const pending = (async () => {
      let document = await evaluator.evaluateDocument({
        identity: documentIdentity(path),
        documentType,
        values: draft.values,
        computed: draft.computed,
        document: {
          path,
          title: draft.name,
          description: draft.description,
          body: draft.body,
          image: draft.image,
          avatar: draft.avatar,
          docType: draft.typeId,
          contentType: "json",
          valid: true,
          values: draft.values,
        },
      });
      assertCurrent();
      return visibleDocumentProjection({
        ...document,
        values: publicValues(documentType.fields, document.values ?? {}),
      });
    })();
    this.drafts.set(key, pending);
    if (this.drafts.size > 128) this.drafts.delete(this.drafts.keys().next().value!);
    void pending.catch(() => {
      if (this.drafts.get(key) === pending) this.drafts.delete(key);
    });
    return withCallerAbort(pending, signal);
  }
  private clearEvaluator() {
    this.evaluator?.dispose?.();
    this.evaluator = undefined;
    this.evaluatorRevision = undefined;
    this.details.clear();
    this.documentNames.clear();
    this.drafts.clear();
  }
  getSnapshot = () => this.state;
  getConnectionSnapshot = () => this.connectionState;
  getChatActivitySnapshot = () => this.state.replica?.sections.chatActivity;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  onChat(listener: (event: ChatEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }
  private publish(change: Partial<RoomConnectionSnapshot>) {
    this.state = { ...this.state, ...change };
    if (
      this.connectionState.connected !== this.state.connected ||
      this.connectionState.error !== this.state.error
    )
      this.connectionState = { connected: this.state.connected, error: this.state.error };
    for (const listener of this.listeners) listener();
  }
  retain() {
    this.references++;
    if (!this.controller) {
      const controller = new AbortController();
      this.controller = controller;
      void this.connect(controller.signal);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.references) return;
      this.controller?.abort();
      this.controller = undefined;
      this.publish({ connected: false });
      queueMicrotask(() => {
        if (this.references) return;
        this.replica = undefined;
        this.moduleEpoch++;
        this.clearEvaluator();
        this.cursor = 0;
        this.chat.reset();
        this.publish({
          replica: undefined,
          resources: undefined,
          error: undefined,
        });
      });
    };
  }
  reconnect(resetEvaluator = false, reloadModule = false) {
    this.controller?.abort();
    if (
      reloadModule ||
      baselineMismatch(this.state.error) ||
      (this.state.error &&
        "code" in this.state.error &&
        this.state.error.code === "LOCAL_MODULE_UNAVAILABLE")
    ) {
      this.replica = undefined;
      this.moduleEpoch++;
      this.clearEvaluator();
      this.publish({ resources: undefined, replica: undefined, error: undefined });
    } else if (resetEvaluator) {
      this.moduleEpoch++;
      this.clearEvaluator();
    }
    if (!this.references) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.connect(controller.signal);
  }
  private async connect(signal: AbortSignal) {
    let attempt = 0;
    let refreshChat = false;
    while (!signal.aborted) {
      try {
        if (!this.state.resources) {
          let resources: SessionModuleResources;
          try {
            resources = await this.localModule.resources(this.roomId, signal);
          } catch (cause) {
            throw Object.assign(
              new Error(
                `本地冻结模组读取失败：${cause instanceof Error ? cause.message : String(cause)}`,
              ),
              { code: "LOCAL_MODULE_UNAVAILABLE" },
            );
          }
          if (signal.aborted) return;
          this.replica = new RoomStateStore(resources.baseline);
          this.publish({ resources });
        }
        if (!this.state.initialized || refreshChat) {
          const page = refreshChat
            ? await this.chat.refresh(signal)
            : await this.client.chat.history({ roomId: this.roomId }, { signal });
          if (signal.aborted) return;
          this.cursor = page.cursor;
          this.chatStreamId = page.streamId;
          if (!refreshChat) this.chat.initialize(page);
          refreshChat = false;
        }
        const stream = await this.client.room.subscribe(
          {
            roomId: this.roomId,
            protocolVersion: ROOM_PROTOCOL_VERSION,
            baselineVersion: this.state.resources!.baseline.version,
            afterChatCursor: this.cursor,
            afterChatStreamId: this.chatStreamId,
          },
          { signal },
        );
        if (signal.aborted) return;
        this.replica!.resetBaseline();
        let deliveryId: string | undefined;
        let deliverySequence = 0;
        for await (const notification of stream) {
          if (signal.aborted) return;
          if (
            (deliveryId && deliveryId !== notification.delivery.id) ||
            notification.delivery.seq !== deliverySequence + 1
          )
            throw new Error("房间通知不连续，需要重新同步");
          deliveryId = notification.delivery.id;
          if (notification.type === "state") {
            if (this.replica!.apply(notification.frame)) {
              const current = this.replica!.getSnapshot()!;
              this.syncEvaluator(this.state.replica, current);
              this.publish({ replica: current, connected: true, error: undefined });
            }
          } else {
            const event = notification.event;
            if (event.cursor <= this.cursor) {
              await this.client.room.acknowledge(
                {
                  roomId: this.roomId,
                  subscriptionId: notification.delivery.id,
                  sequence: notification.delivery.seq,
                },
                { signal },
              );
              deliverySequence = notification.delivery.seq;
              continue;
            }
            const previousChat = this.chat.getSnapshot();
            try {
              this.chat.applyEvent(event);
            } catch {
              const messageId =
                event.type === "message"
                  ? event.message.id
                  : event.type === "agent"
                    ? event.messageId
                    : undefined;
              if (!messageId) throw new Error("无法还原聊天通知");
              const message = await this.client.chat.get(
                { roomId: this.roomId, messageId },
                { signal },
              );
              if (signal.aborted) return;
              this.chat.acceptMessage(message);
            }
            this.cursor = event.cursor;
            if (this.chat.getSnapshot() !== previousChat)
              for (const listener of this.eventListeners) listener(event);
          }
          await this.client.room.acknowledge(
            {
              roomId: this.roomId,
              subscriptionId: notification.delivery.id,
              sequence: notification.delivery.seq,
            },
            { signal },
          );
          deliverySequence = notification.delivery.seq;
          attempt = 0;
        }
        if (!signal.aborted) this.publish({ connected: false });
      } catch (error) {
        if (signal.aborted) return;
        this.publish({
          connected: false,
          error: error instanceof Error ? error : new Error("房间同步失败"),
        });
        if (
          error &&
          typeof error === "object" &&
          "data" in error &&
          error.data &&
          typeof error.data === "object" &&
          "reason" in error.data &&
          error.data.reason === "CHAT_RESYNC_REQUIRED"
        ) {
          refreshChat = true;
          continue;
        }
        if (
          baselineMismatch(error) ||
          (error &&
            typeof error === "object" &&
            "code" in error &&
            [
              "LOCAL_MODULE_UNAVAILABLE",
              "BASELINE_MISMATCH",
              "PAYLOAD_TOO_LARGE",
              "BAD_REQUEST",
              "FORBIDDEN",
              "NOT_FOUND",
            ].includes(String(error.code)))
        )
          return;
      }
      await reconnectDelay(signal, Math.min(1000 * 2 ** attempt++, 15000));
    }
  }
}

const clients = new WeakMap<GameClient, Map<string, RoomConnection>>();
export function roomConnection(
  client: GameClient,
  roomId: string,
  localModule: LocalRoomModuleLoader,
): RoomConnection {
  let rooms = clients.get(client);
  if (!rooms) clients.set(client, (rooms = new Map()));
  let connection = rooms.get(roomId);
  if (!connection)
    rooms.set(roomId, (connection = new RoomConnection(client, roomId, localModule)));
  if (connection.localModule !== localModule)
    throw new Error("同一房间连接不能混用本地模组 loader");
  return connection;
}
