import { ttsConfigWithVoice, ttsVoiceOverrideSchema, type TtsVoiceOverride } from "@shared/tts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { speechPlayer, useSpeechSnapshot } from "../tts/use-speech";
import { errorMessage } from "./game-client";

export function CompanionVoiceSettings({
  roomId,
  companionId,
  name,
}: {
  roomId: string;
  companionId: string;
  name: string;
}) {
  const id = useId();
  const client = useQueryClient();
  const options = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const party = useQuery(options);
  const voiceOptions = desktopOrpc.tts.voiceSettings.queryOptions({
    input: { roomId, companionId },
  });
  const resolved = useQuery({ ...voiceOptions, staleTime: 0 });
  const settings = useQuery(desktopOrpc.tts.roomSettings.queryOptions({ input: { roomId } }));
  const companion = party.data?.seats.find((seat) => seat.id === companionId)?.companion;
  const config = resolved.data;
  const initial = {
    description: config?.voiceDescription ?? "",
    instructions: config?.instructions ?? "",
  };
  const [draft, setDraft] = useState<typeof initial | undefined>(undefined);
  const current = draft ?? initial;
  const changed =
    current.description !== initial.description || current.instructions !== initial.instructions;
  const value = current.description.trim()
    ? { mode: "design", description: current.description, instructions: current.instructions }
    : { mode: "preset", voice: config?.voice, instructions: current.instructions };
  const parsed = ttsVoiceOverrideSchema.safeParse(value);
  const owner = `companion-voice-preview:${roomId}:${companionId}`;
  const playback = useSpeechSnapshot();
  const previewing = playback.owner === owner && ["loading", "playing"].includes(playback.status);
  useEffect(() => () => speechPlayer.stop(owner), [owner]);
  const save = useMutation({
    mutationFn: (voice: TtsVoiceOverride | null) =>
      desktopRpc.sessions.companion.setVoice({ roomId, id: companionId, voice }),
    async onSuccess(value) {
      client.setQueryData(options.queryKey, value);
      await client.invalidateQueries({ queryKey: voiceOptions.queryKey });
      setDraft(undefined);
    },
  });
  const busy = save.isPending;
  const invalid = !parsed.success;
  const error = party.error ?? resolved.error ?? settings.error ?? save.error;
  function edit(next: typeof initial) {
    setDraft(next);
    save.reset();
  }
  async function persist() {
    if (busy || !companion || !config || !parsed.success) return;
    speechPlayer.stop(owner);
    try {
      await save.mutateAsync(parsed.data);
    } catch {
      /* mutation 展示错误。 */
    }
  }
  function preview() {
    if (!companion || !config || !parsed.success) return;
    speechPlayer.replace({
      owner,
      key: owner,
      text: `我是${name}。前面的路交给我，我们一起走。`,
      speaker: { roomId, kind: "companion", id: companionId },
      preview: { config: ttsConfigWithVoice(config, parsed.data) },
    });
  }
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void persist();
      }}
    >
      <div>
        <h3 className="text-sm font-medium">声音</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-5">
          已填入{name}当前的声音设定，修改后只在本次冒险中生效。
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-description`}>音色描述</Label>
        <Textarea
          id={`${id}-description`}
          rows={3}
          maxLength={1000}
          disabled={busy || !config}
          value={current.description}
          onChange={(event) => edit({ ...current, description: event.target.value })}
          placeholder={
            resolved.isPending
              ? "正在读取角色声音…"
              : "例如：年轻女性，声线清亮，带一点慵懒的鼻音。"
          }
        />
        {config && !initial.description ? (
          <p className="text-muted-foreground text-xs">
            当前使用{config.voice}音色。填写描述即可定制声音。
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-instructions`}>讲述要求（可选）</Label>
        <Textarea
          id={`${id}-instructions`}
          rows={2}
          maxLength={1000}
          disabled={busy || !config}
          value={current.instructions}
          onChange={(event) => edit({ ...current, instructions: event.target.value })}
          placeholder="语速、情绪和说话习惯。留空不附加要求。"
        />
      </div>
      {config && invalid ? (
        <p role="alert" className="text-destructive text-xs">
          请填写音色描述，或恢复模组设定。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !companion || !config || !changed || invalid}
        >
          {busy ? "保存中…" : "保存声音"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            busy || (!previewing && (!companion || !config || invalid || !settings.data?.hasKey))
          }
          onClick={() => (previewing ? speechPlayer.stop(owner) : preview())}
        >
          {previewing ? "停止试听" : "试听"}
        </Button>
        {companion?.voice || draft ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              speechPlayer.stop(owner);
              save.mutate(null);
            }}
          >
            恢复模组设定
          </Button>
        ) : null}
      </div>
      {!settings.data?.hasKey && !settings.isPending ? (
        <p className="text-muted-foreground text-xs">
          可先保存声音；试听前请在应用设置 → 语音供应商中连接服务。
        </p>
      ) : null}
      {save.isSuccess && draft === undefined ? (
        <p role="status" className="text-muted-foreground text-xs">
          已保存，下次朗读时生效。
        </p>
      ) : null}
      {previewing ? (
        <p role="status" className="text-muted-foreground text-xs">
          {playback.status === "loading" ? "正在合成试听…" : "正在试听…"}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {errorMessage(error)}
        </p>
      ) : null}
      {playback.owner === owner && playback.error ? (
        <p role="alert" className="text-destructive text-xs">
          {playback.error}
        </p>
      ) : null}
    </form>
  );
}
