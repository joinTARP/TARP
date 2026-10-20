import type { AgentDetail } from "../../../shared/agent-details";
import type { ChatMessage } from "../../../shared/game";
import { PiHistory } from "../../agent/pi-history";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { RoomMetrics } from "../room-metrics";
import { RunDetails } from "../run-details";
import type { RoomState } from "./types";

export interface RunResources {
  readonly metrics: RoomMetrics;
  readonly liveDetails: RunDetails;
  readonly piHistory: PiHistory;
}

/** 运行指标与幕后详情的房间级缓存。 */
export class ChatRunDiagnostics {
  private rooms = new WeakMap<RoomState, RunResources>();
  constructor(private readonly history = new PiHistory()) {}
  resources(state: RoomState): RunResources {
    let resources = this.rooms.get(state);
    if (!resources) {
      const piHistory = this.history;
      resources = {
        piHistory,
        liveDetails: new RunDetails(),
        metrics: new RoomMetrics(state.db, roomDirectoryForDatabase(state.db), piHistory),
      };
      this.rooms.set(state, resources);
    }
    return resources;
  }
  async details(state: RoomState, message: ChatMessage): Promise<AgentDetail[]> {
    if (message.kind !== "assistant") return [];
    const resources = this.resources(state);
    const live = resources.liveDetails.get(message.id);
    if (message.status === "running") return [...(live?.values() ?? [])];
    const saved = await resources.piHistory.details(roomDirectoryForDatabase(state.db), message);
    if (!live) return saved;
    const merged = new Map(saved.map((detail) => [detail.id, detail]));
    for (const detail of live.values()) merged.set(detail.id, detail);
    return [...merged.values()];
  }
  recover(state: RoomState, message: Extract<ChatMessage, { kind: "assistant" }>) {
    return this.history.recover(roomDirectoryForDatabase(state.db), message);
  }
  metrics(state: RoomState) {
    return this.resources(state).metrics.read();
  }
  async close(state: RoomState) {
    const resources = this.rooms.get(state);
    await resources?.metrics.settled();
    resources?.metrics.close();
    await this.history.closeRoom(roomDirectoryForDatabase(state.db));
    this.rooms.delete(state);
  }
}
