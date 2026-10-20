import type { SessionDatabase } from "../storage/session-database";
import { readAdventure, updateAdventure, type StoredAdventure } from "./room-storage";
import { roomDirectoryForDatabase } from "./session-paths";
import { bumpStateRevision } from "./state-version";

/** 一次业务操作中共同提交的开局与队伍状态，不包含资料、笔记或设置。 */
type AdventureState = Pick<StoredAdventure, "launch" | "party">;
const drafts = new WeakMap<
  SessionDatabase,
  { state?: AdventureState; dirty: boolean; changed: boolean }
>();

function writeAdventureStateFile(directory: string, state: AdventureState): void {
  updateAdventure(directory, (current) => ({
    ...current,
    launch: state.launch,
    party: state.party,
  }));
}

export function readAdventureState(db: SessionDatabase): AdventureState {
  const draft = drafts.get(db);
  if (draft?.state) return draft.state;
  const { launch, party } = readAdventure(roomDirectoryForDatabase(db));
  const state = { launch, party };
  if (draft) draft.state = state;
  return state;
}

export function updateAdventureState(db: SessionDatabase, change: (state: AdventureState) => void) {
  const state = readAdventureState(db);
  change(state);
  const draft = drafts.get(db);
  if (draft) {
    draft.dirty = true;
    return;
  }
  writeAdventureStateFile(roomDirectoryForDatabase(db), state);
  bumpStateRevision(db);
}

/** 延迟提交开局与队伍状态；与 SQLite 不构成跨文件事务。 */
export function beginAdventureEdit(db: SessionDatabase) {
  if (drafts.has(db)) throw new Error("冒险状态已有待提交修改");
  drafts.set(db, { dirty: false, changed: false });
}

export function commitAdventureEdit(db: SessionDatabase) {
  const draft = drafts.get(db);
  if (!draft) return;
  if (draft.dirty) writeAdventureStateFile(roomDirectoryForDatabase(db), draft.state!);
  if (draft.dirty || draft.changed) bumpStateRevision(db);
  drafts.delete(db);
}

export function discardAdventureEdit(db: SessionDatabase) {
  drafts.delete(db);
}

export function markStateChanged(db: SessionDatabase): void {
  const draft = drafts.get(db);
  if (draft) draft.changed = true;
  else bumpStateRevision(db);
}
