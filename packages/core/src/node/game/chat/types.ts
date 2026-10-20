import type { EventEmitter } from "node:events";

import type { AgentDetail } from "../../../shared/agent-details";
import type { CompactionSettings } from "../../../shared/compaction-settings";
import type { Companion, CompanionModel } from "../../../shared/companion";
import type { CompanionInitiative } from "../../../shared/companion-initiative";
import type { DiceOptions } from "../../../shared/dice";
import type {
  PublicAgentEvent,
  AiConfig,
  ChatMessage,
  PiMessageReference,
} from "../../../shared/game";
import type { MentionTarget } from "../../../shared/mentions";
import type { HostInputBatch, ReceivedInput } from "../../agent/input-batch";
import type { PiHistory } from "../../agent/pi-history";
import type { SteeringBatch, ReceivedSteering } from "../../agent/steering-batch";
import type { SessionDatabase } from "../../storage/session-database";
import type { ChatActivity } from "./activity";
import type { ChatStore, SubmissionRequest } from "./store";

export interface Runtime {
  readonly history?: PiHistory;
  closeRoom?(roomDirectory: string): Promise<void>;
  run(args: {
    operation?: "compact";
    roomDirectory: string;
    messageId: string;
    requestId?: string;
    text: string;
    inputBatch?: HostInputBatch;
    onInputReceived?: (received: ReceivedInput) => void;
    config: AiConfig;
    compaction?: CompactionSettings;
    onContextWindow?: (tokens: number) => void;
    onHistory?: (reference: PiMessageReference) => void;
    onAgentEvent: (event: PublicAgentEvent) => void;
    onDetail?: (detail: AgentDetail) => void;
    rollDice?: (options: DiceOptions) => Promise<ChatMessage>;
    signal: AbortSignal;
    initialSteering?: SteeringBatch;
    takeSteering?: () => SteeringBatch | undefined;
    onSteering?: (received: ReceivedSteering) => void;
    companion?: {
      id: string;
      personality: string;
      initiative?: CompanionInitiative;
      documentAccess?: boolean;
    };
    /** 场外主持聊天，仅提供只读工具，不接收行动或插话。 */
    hostChat?: boolean;
    /** 只允许撤回本队友指定的待提交行动；消息 ID 保证重试不会误撤新行动。 */
    withdrawAction?: (messageId: string) => Promise<ChatMessage>;
    requireResponse?: boolean;
    mentionTargets?: readonly MentionTarget[];
  }): Promise<void>;
}
export interface ScriptLine {
  postKey: string;
  text: string;
  speakerPath?: string;
  nickname?: string;
}
/** 仅保留房间连接和生命周期；运行缓存由所属模块管理。 */
export interface RoomState {
  readonly db: SessionDatabase;
  readonly events: EventEmitter;
  closed: boolean;
}
export interface CompanionChain {
  remainingIds: string[];
  /** 玩家行动后的补充阶段；结束后按提交模式交主持或保留待提交。 */
  beforeHost?: { source: ChatMessage };
}
export interface RunOptions {
  hostChat?: boolean;
  /** MCP 预演逐次驱动，不自动接续队友、点名或主持。 */
  singleTurn?: boolean;
  mentionChain?: MentionChain;
  triggerMessage?: ChatMessage;
  steeringBatch?: SteeringBatch;
  requestId?: string;
  companion?: Companion;
  companionChain?: CompanionChain;
  inputBatch?: HostInputBatch;
  react?: boolean;
  consumePending?: ChatMessage[];
  submission?: SubmissionRequest;
}
export interface MentionChain {
  limit: number;
  started: number;
}

export type ChatAuth = { config: AiConfig };
export type ChatCredentials = (
  roomId: string,
  selection?: CompanionModel | null,
) => Promise<ChatAuth>;

/** 各业务共享房间访问与持久化入口；不暴露整个 ChatService。 */
export interface ChatContext {
  readonly root: string;
  state(id: string, readOnly?: boolean): Promise<RoomState>;
  readonly store: ChatStore;
  readonly activity: ChatActivity;
  credentials: ChatCredentials;
  isClosing(): boolean;
}
export function isDirectMention(options: RunOptions) {
  return Boolean(options.triggerMessage);
}

export class NoCompanionResponseError extends Error {
  constructor() {
    super("队友未生成有效回应或沉默决定");
  }
}
