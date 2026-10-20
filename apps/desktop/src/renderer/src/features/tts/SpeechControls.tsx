import { speechText } from "@shared/speech-text";
import type { TtsSpeaker } from "@shared/tts";
import { LoaderCircle, Square, Volume2, VolumeX } from "lucide-react";

import { Button } from "../../components/ui/button";
import { errorMessage } from "../sessions/game-client";
import { speechPlayer, useSpeechSnapshot } from "./use-speech";

export function ReadAloudButton({
  owner,
  id,
  text,
  speaker,
  enabled = true,
}: {
  owner: string;
  id: string;
  text: string;
  speaker?: TtsSpeaker;
  enabled?: boolean;
}) {
  const state = useSpeechSnapshot();
  const spoken = speechText(text);
  if (!spoken || !enabled) return null;
  const active = state.key === id && (state.status === "loading" || state.status === "playing");
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="text-muted-foreground size-6 shrink-0 opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 focus:opacity-100 aria-pressed:opacity-100"
      aria-pressed={active}
      aria-label={active ? "停止朗读" : "朗读此段"}
      tooltip={active ? "停止朗读" : "朗读此段"}
      onClick={() =>
        active
          ? speechPlayer.stop(owner)
          : speechPlayer.replace({ owner, key: id, text: spoken, speaker })
      }
    >
      {active ? <Square className="size-3 fill-current" /> : <Volume2 className="size-3.5" />}
    </Button>
  );
}

export function SpeechControls({
  owner,
  enabled,
  pending,
  onToggle,
  error,
}: {
  owner: string;
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
  error?: unknown;
}) {
  const state = useSpeechSnapshot();
  const active =
    state.owner === owner && (state.status === "loading" || state.status === "playing");
  const message = error ? errorMessage(error) : state.owner === owner ? state.error : undefined;
  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={`text-muted-foreground size-8 rounded-md ${message ? "text-destructive" : ""}`}
        aria-pressed={enabled}
        aria-label={enabled ? "关闭自动朗读" : "开启自动朗读"}
        disabled={pending}
        onClick={onToggle}
        tooltip={enabled ? "关闭自动朗读" : "自动朗读新消息"}
      >
        {pending || (active && state.status === "loading") ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : enabled ? (
          <Volume2 className="size-4" />
        ) : (
          <VolumeX className="size-4" />
        )}
      </Button>
      {active ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-8 rounded-md"
          aria-label="停止朗读"
          tooltip={state.queued ? `停止朗读（待播 ${state.queued} 条）` : "停止朗读"}
          onClick={() => speechPlayer.stop(owner)}
        >
          <Square className="size-3 fill-current" />
        </Button>
      ) : null}
      {message ? (
        <span
          role="alert"
          className="text-destructive max-w-72 text-xs leading-4 break-words select-text"
        >
          {message}
        </span>
      ) : null}
      {active ? (
        <span role="status" className="sr-only">
          {state.status === "loading" ? "正在合成语音" : "正在朗读"}
        </span>
      ) : null}
    </div>
  );
}
