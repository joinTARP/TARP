import type {
  ChatMessage,
  SubmissionModeSnapshot,
  SteeringSnapshot,
} from "@jointarp/core/shared/game";
import { AutomaticSpeechTracker, type SpeechPart } from "@shared/speech-text";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { errorMessage, type GameClient } from "./game-client";
import { localRoomModuleLoader } from "./local-room-module";
import { roomConnection } from "./room-connection";

export interface ChatLogActions {
  acceptMessage(message: ChatMessage): void;
  acceptSteering(snapshot: SteeringSnapshot): void;
  confirmSubmissionMode(snapshot: SubmissionModeSnapshot): void;
  reportError(message: string): void;
  requestSignal(): AbortSignal | undefined;
}

interface ChatLogOptions {
  client: GameClient;
  roomId: string;
  bottom: { current: boolean };
  onAssistantSettled?: () => void;
  onSpeechMessage?: (id: string, parts: SpeechPart[]) => void;
  playerCharacterNames?: ReadonlySet<string>;
  playerCharacterPaths?: ReadonlySet<string>;
}

/** 订阅权威聊天快照，仅保留分页反馈、未读和朗读等视图状态。 */
export function useChatLog({
  client,
  roomId,
  bottom,
  onAssistantSettled,
  onSpeechMessage,
  playerCharacterNames,
  playerCharacterPaths,
}: ChatLogOptions) {
  const shared = useMemo(
    () => roomConnection(client, roomId, localRoomModuleLoader),
    [client, roomId],
  );
  const snapshot = useSyncExternalStore(shared.chat.subscribe, shared.chat.getSnapshot);
  const connection = useSyncExternalStore(shared.subscribe, shared.getConnectionSnapshot);
  const chatActivity = useSyncExternalStore(shared.subscribe, shared.getChatActivitySnapshot);
  const [error, reportError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [unread, setUnread] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  const historyLock = useRef(false);
  const onSettledRef = useRef(onAssistantSettled);
  onSettledRef.current = onAssistantSettled;
  const onSpeechRef = useRef(onSpeechMessage);
  onSpeechRef.current = onSpeechMessage;
  const playerNamesRef = useRef(playerCharacterNames);
  playerNamesRef.current = playerCharacterNames;
  const playerPathsRef = useRef(playerCharacterPaths);
  playerPathsRef.current = playerCharacterPaths;

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const speechTracker = new AutomaticSpeechTracker();
    let seeded = false;
    const seed = () => {
      const value = shared.getSnapshot();
      if (seeded || !value.initialized) return;
      speechTracker.seed(value.messages);
      seeded = true;
    };
    const off = shared.chat.subscribe(seed);
    const offChat = shared.onChat((event) => {
      if (event.type !== "message") return;
      if (!bottom.current) setUnread(true);
      const spoken = speechTracker.takeParts(
        event.message,
        playerNamesRef.current,
        playerPathsRef.current,
      );
      if (spoken) onSpeechRef.current?.(event.message.id, spoken);
      if (event.message.kind === "assistant" && event.message.status !== "running")
        onSettledRef.current?.();
    });
    seed();
    const release = shared.retain();
    return () => {
      controller.abort();
      off();
      offChat();
      release();
    };
  }, [shared, bottom]);

  async function loadOlder() {
    if (historyLock.current) return;
    historyLock.current = true;
    setLoadingHistory(true);
    const signal = lifecycle.current?.signal;
    try {
      await shared.chat.loadOlder(signal);
    } catch (reason) {
      if (!signal?.aborted) reportError(errorMessage(reason));
    } finally {
      historyLock.current = false;
      if (!signal?.aborted) setLoadingHistory(false);
    }
  }

  const actions = useMemo<ChatLogActions>(
    () => ({
      acceptMessage: (message) => shared.chat.acceptMessage(message),
      acceptSteering: (snapshot) => shared.chat.acceptSteering(snapshot),
      confirmSubmissionMode: (mode) => shared.chat.confirmSubmissionMode(mode),
      reportError,
      requestSignal: () => lifecycle.current?.signal,
    }),
    [shared],
  );
  const clearUnread = useCallback(() => setUnread(false), []);
  const pendingIds = useMemo(
    () => new Set(snapshot.pendingMessageIds),
    [snapshot.pendingMessageIds],
  );
  return {
    messages: snapshot.messages,
    submissionMode: snapshot.submissionMode.mode,
    chatActivity,
    steering: snapshot.steering,
    isHost: snapshot.isHost,
    pendingIds,
    actions,
    error,
    reportError,
    connection: connection.connected
      ? "已连接"
      : connection.error
        ? `同步失败：${connection.error.message}`
        : "正在连接…",
    hasMore: snapshot.hasMore,
    loadingHistory,
    ready: snapshot.initialized && chatActivity !== undefined,
    viewReady: snapshot.initialized || Boolean(connection.error),
    unread,
    clearUnread,
    loadOlder,
  };
}
