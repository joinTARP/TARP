import type { Player } from "../../../shared/game";
import type { RoomState } from "./types";

export interface RunningChat {
  messageId: string;
  readonly runId: string;
  readonly abort: AbortController;
  done: Promise<void>;
}
interface Activity {
  running?: RunningChat;
  configuring?: Promise<void>;
  handoff?: Promise<void>;
  players: Map<string, { player: Player; count: number }>;
}

/** 房间在线玩家、操作互斥与关闭等待；统一管理瞬态协作状态。 */
export class ChatActivity {
  private rooms = new WeakMap<RoomState, Activity>();
  private get(state: RoomState) {
    let activity = this.rooms.get(state);
    if (!activity) this.rooms.set(state, (activity = { players: new Map() }));
    return activity;
  }
  running(state: RoomState): Readonly<RunningChat> | undefined {
    return this.get(state).running;
  }
  isConfiguring(state: RoomState) {
    return Boolean(this.get(state).configuring || this.get(state).handoff);
  }
  startRun(state: RoomState, run: RunningChat) {
    this.get(state).running = run;
  }
  finishRun(state: RoomState, run: RunningChat) {
    const activity = this.get(state);
    if (activity.running === run) activity.running = undefined;
  }
  beginConfiguration(state: RoomState) {
    const activity = this.get(state);
    if (activity.running || activity.configuring || activity.handoff)
      throw new Error("请先停止 AI 生成，再配置队友");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    activity.configuring = pending;
    return () => {
      if (activity.configuring === pending) activity.configuring = undefined;
      finish();
    };
  }
  beginHandoff(state: RoomState) {
    const activity = this.get(state);
    if (activity.handoff || activity.configuring) throw new Error("房间正在处理提交");
    let resolve!: () => void;
    activity.handoff = new Promise<void>((done) => {
      resolve = done;
    });
    return () => {
      activity.handoff = undefined;
      resolve();
    };
  }
  async settled(state: RoomState) {
    await this.get(state).configuring;
    await this.get(state).handoff;
  }

  players(state: RoomState): Player[] {
    return [...this.get(state).players.values()].map((viewer) => viewer.player);
  }
  updatePlayer(state: RoomState, player: Player) {
    const viewer = this.get(state).players.get(player.id);
    if (viewer) viewer.player = player;
  }

  /** 释放函数仅在该玩家最后一条订阅结束时返回 true。 */
  retainPlayer(state: RoomState, player: Player) {
    const players = this.get(state).players;
    const viewer = players.get(player.id) ?? { player, count: 0 };
    viewer.player = player;
    viewer.count++;
    players.set(player.id, viewer);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      if (--viewer.count) return false;
      players.delete(player.id);
      return true;
    };
  }
}
