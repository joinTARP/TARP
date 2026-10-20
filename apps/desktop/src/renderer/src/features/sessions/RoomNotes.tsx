import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { desktopRpc } from "../../desktop-rpc";
import { errorMessage } from "./game-client";
import {
  clearNotesDraft,
  enqueueNotes,
  hasPendingNotes,
  readNotesDraft,
  roomNotesKey,
  writeNotesDraft,
} from "./room-notes-state";

type NoteState = "loading" | "saving" | "saved" | "error";

export function RoomNotes({ roomId, playerId }: { roomId: string; playerId: string }) {
  const notesKey = roomNotesKey(roomId, playerId);
  const [content, setContent] = useState("");
  const [loadedNotesKey, setLoadedNotesKey] = useState("");
  const [state, setState] = useState<NoteState>("loading");
  const [error, setError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const revisionRef = useRef(0);
  const currentRef = useRef({ notesKey, content: "", revision: 0 });
  const persistedRef = useRef({ notesKey, content: "" });
  const mountedNotesRef = useRef(notesKey);
  const readyNotesRef = useRef("");

  mountedNotesRef.current = notesKey;

  const persist = useCallback(
    (value: string, revision: number) => {
      writeNotesDraft(notesKey, value);
      if (mountedNotesRef.current === notesKey) {
        setState("saving");
        setError("");
      }
      return enqueueNotes(notesKey, () =>
        desktopRpc.sessions.notes.save({ roomId, playerId, content: value }),
      )
        .then(() => {
          if (currentRef.current.revision === revision && !hasPendingNotes(notesKey))
            clearNotesDraft(notesKey, value);
          if (persistedRef.current.notesKey === notesKey)
            persistedRef.current = { notesKey, content: value };
          if (mountedNotesRef.current === notesKey && currentRef.current.revision === revision)
            setState("saved");
        })
        .catch((reason: unknown) => {
          if (mountedNotesRef.current === notesKey && currentRef.current.revision === revision) {
            setError(errorMessage(reason));
            setState("error");
          }
        });
    },
    [notesKey, roomId, playerId],
  );

  useEffect(() => {
    let active = true;
    setLoadedNotesKey("");
    setContent("");
    setError("");
    setState("loading");
    readyNotesRef.current = "";
    void enqueueNotes(notesKey, () => desktopRpc.sessions.notes.get({ roomId, playerId }))
      .then((saved) => {
        if (!active) return;
        const draft = readNotesDraft(notesKey);
        const value = draft ?? saved;
        const revision = ++revisionRef.current;
        currentRef.current = { notesKey, content: value, revision };
        persistedRef.current = { notesKey, content: saved };
        readyNotesRef.current = notesKey;
        setContent(value);
        setLoadedNotesKey(notesKey);
        if (draft !== undefined && draft !== saved) {
          setState("saving");
          void persist(draft, revision);
        } else {
          setState("saved");
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [notesKey, roomId, playerId, retryToken, persist]);

  useEffect(() => {
    if (loadedNotesKey !== notesKey) return;
    const value = content;
    const revision = currentRef.current.revision;
    if (
      persistedRef.current.notesKey === notesKey &&
      persistedRef.current.content === value &&
      !hasPendingNotes(notesKey)
    ) {
      clearNotesDraft(notesKey, value);
      setState("saved");
      return;
    }
    const timer = window.setTimeout(() => void persist(value, revision), 650);
    return () => window.clearTimeout(timer);
  }, [content, loadedNotesKey, persist, notesKey]);

  useEffect(() => {
    return () => {
      const latest = currentRef.current;
      if (latest.notesKey !== notesKey || readyNotesRef.current !== notesKey) return;
      if (
        persistedRef.current.notesKey !== notesKey ||
        persistedRef.current.content !== latest.content ||
        hasPendingNotes(notesKey)
      ) {
        // 卸载、切换房间或玩家时立即尝试保存；失败后保留草稿供下次进入恢复。
        void persist(latest.content, latest.revision);
      }
    };
  }, [persist, notesKey]);

  function changeContent(value: string) {
    const revision = ++revisionRef.current;
    currentRef.current = { notesKey, content: value, revision };
    writeNotesDraft(notesKey, value);
    setContent(value);
    setState("saving");
    setError("");
  }

  if (loadedNotesKey !== notesKey) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm">
        {state === "error" ? (
          <div role="alert" className="text-center">
            <p className="text-destructive mb-2">笔记读取失败：{error}</p>
            <Button variant="outline" size="sm" onClick={() => setRetryToken((value) => value + 1)}>
              重试
            </Button>
          </div>
        ) : (
          "正在读取笔记…"
        )}
      </div>
    );
  }

  return (
    <section
      aria-label="我的冒险笔记"
      className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3 px-6 py-5"
    >
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">我的笔记</h2>
        <span
          aria-live="polite"
          className={
            state === "error" ? "text-destructive text-xs" : "text-muted-foreground text-xs"
          }
        >
          {state === "saving"
            ? "正在保存…"
            : state === "saved"
              ? "已保存"
              : state === "error"
                ? "保存失败"
                : "正在读取…"}
        </span>
      </div>
      <Textarea
        aria-label="我的冒险笔记内容"
        maxLength={200_000}
        className="field-sizing-fixed min-h-0 flex-1 resize-none leading-6"
        placeholder="记录线索、人物和待办事项…"
        value={content}
        onChange={(event) => changeContent(event.target.value)}
      />
      {state === "error" ? (
        <div
          role="alert"
          className="text-destructive flex items-center justify-between gap-3 text-sm"
        >
          <span className="min-w-0 truncate">{error || "保存失败，请重试。"}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void persist(currentRef.current.content, currentRef.current.revision)}
          >
            重试保存
          </Button>
        </div>
      ) : null}
    </section>
  );
}
