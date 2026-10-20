import type { LaunchConfig } from "@jointarp/module/flow";
import { emptyFlowRun } from "@jointarp/module/flow";

import type { LaunchProgress, LaunchRoom } from "../../shared/launch";
import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState, updateAdventureState } from "./adventure-state";
import { frozenModule } from "./frozen-module";

export function initializeLaunch(db: SessionDatabase, config?: LaunchConfig) {
  if (config)
    updateAdventureState(db, (selection) => {
      selection.launch.state = { revision: 0, locked: false, opening: "pending", intro: "ready" };
    });
}
export function readLaunchConfig(db: SessionDatabase): LaunchConfig | undefined {
  return frozenModule(db).launch;
}
export function readLaunchRoom(db: SessionDatabase): LaunchRoom {
  const room = readAdventureState(db).launch.state;
  if (!room) throw new Error("冒险开局状态无效");
  return structuredClone(room);
}
export function saveLaunchRoom(db: SessionDatabase, room: LaunchRoom) {
  updateAdventureState(db, (selection) => {
    selection.launch.state = structuredClone(room);
  });
}
export function allLaunchProgress(db: SessionDatabase): [string, LaunchProgress][] {
  return Object.entries(readAdventureState(db).launch.players).map(([id, progress]) => [
    id,
    structuredClone(progress),
  ]);
}
export function hasLaunchProgress(db: SessionDatabase, playerId: string): boolean {
  return Object.hasOwn(readAdventureState(db).launch.players, playerId);
}
export function readLaunchProgress(db: SessionDatabase, playerId: string): LaunchProgress {
  const progress = readAdventureState(db).launch.players[playerId];
  return progress
    ? structuredClone(progress)
    : {
        revision: 0,
        stage: readLaunchConfig(db)?.preludeFlow?.steps.length
          ? "prelude"
          : readLaunchRoom(db).locked
            ? "character"
            : "start",
        prelude: emptyFlowRun(),
        confirmed: false,
      };
}
export function saveLaunchProgress(
  db: SessionDatabase,
  playerId: string,
  progress: LaunchProgress,
) {
  updateAdventureState(db, (selection) => {
    selection.launch.players[playerId] = structuredClone(progress);
  });
}
