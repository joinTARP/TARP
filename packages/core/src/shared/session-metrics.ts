/** 会话运行状态：只记录模型返回的用量，不估算或伪造 token。 */
export interface SessionActorMetrics {
  readonly id: string;
  readonly name: string;
  readonly current: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly status: "idle" | "running" | "complete" | "cancelled" | "failed" | "interrupted";
    readonly startedAt: string | null;
    /** 压缩后尚无模型实测用量时为 null。 */
    readonly contextTokens: number | null;
    readonly contextWindow: number | null;
  };
  readonly totals: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly attempts: number;
    readonly completedAttempts: number;
    readonly toolCalls: number;
  };
}

/** 上下文属于单个角色；房间层级只汇总可累加的消耗。 */
export interface SessionMetrics {
  readonly compactingActorId?: string;
  readonly host: SessionActorMetrics;
  readonly companions: readonly SessionActorMetrics[];
  readonly totals: SessionActorMetrics["totals"];
}
