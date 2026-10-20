// 房间或玩家切换、组件重挂载时，仍按顺序完成同一份笔记的请求。
const noteQueues = new Map<string, Promise<unknown>>();
const unsavedDrafts = new Map<string, string>();

export const roomNotesKey = (roomId: string, playerId: string) => `${roomId}:${playerId}`;
const draftStorageKey = (notesKey: string) => `tarp:room-notes-draft:v2:${notesKey}`;

export function readNotesDraft(notesKey: string): string | undefined {
  const memoryDraft = unsavedDrafts.get(notesKey);
  if (memoryDraft !== undefined) return memoryDraft;
  try {
    return window.localStorage.getItem(draftStorageKey(notesKey)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeNotesDraft(notesKey: string, value: string) {
  unsavedDrafts.set(notesKey, value);
  try {
    window.localStorage.setItem(draftStorageKey(notesKey), value);
  } catch {
    // 本地存储不可用时仍保留进程内草稿。
  }
}

export function clearNotesDraft(notesKey: string, value: string) {
  if (unsavedDrafts.get(notesKey) === value) unsavedDrafts.delete(notesKey);
  try {
    if (window.localStorage.getItem(draftStorageKey(notesKey)) === value)
      window.localStorage.removeItem(draftStorageKey(notesKey));
  } catch {
    // 文件已保存；无法清理浏览器草稿时，重载后会再次保存同一内容。
  }
}

export function hasPendingNotes(notesKey: string): boolean {
  return noteQueues.has(notesKey);
}

export function enqueueNotes<T>(notesKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = noteQueues.get(notesKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  noteQueues.set(notesKey, next);
  void next
    .finally(() => {
      if (noteQueues.get(notesKey) === next) noteQueues.delete(notesKey);
    })
    .catch(() => undefined);
  return next;
}
