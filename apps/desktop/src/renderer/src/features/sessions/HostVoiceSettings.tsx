import { ttsConfigWithVoice, ttsVoiceOverrideSchema, type TtsVoiceOverride } from "@shared/tts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { SettingsSection } from "../settings/SettingsSection";
import { speechPlayer, useSpeechSnapshot } from "../tts/use-speech";
import { errorMessage } from "./game-client";

type Draft = {
  mode: "preset" | "design";
  voice: string;
  description: string;
  instructions: string;
};

const presetModel = "mimo-v2.5-tts";
const designModel = "mimo-v2.5-tts-voicedesign";

export function HostVoiceSettings({
  roomId,
  enabled = true,
}: {
  roomId: string;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = desktopOrpc.tts.hostVoiceSettings.queryOptions({ input: { roomId } });
  const resolved = useQuery({ ...options, staleTime: 0 });
  const config = resolved.data?.config;
  const summary = !enabled
    ? "语音已关闭；当前声音配置会继续保留。"
    : config
      ? `${config.model === designModel ? "定制音色" : voiceName(config.voice)} · ${resolved.data?.overridden ? "当前冒险覆盖" : "继承模组或冒险默认"}`
      : resolved.isPending
        ? "正在读取主持人声音…"
        : "无法读取主持人声音";

  return (
    <SettingsSection title="主持人声音">
      <Dialog open={enabled && open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <h3 id="host-voice-heading" className="text-sm font-medium">
              主持音色
            </h3>
            <p className="text-muted-foreground mt-1 text-xs leading-5 break-words">{summary}</p>
          </div>
          <DialogTrigger
            render={<Button variant="outline" size="sm" className="shrink-0" disabled={!enabled} />}
          >
            {resolved.data?.overridden ? "修改声音" : "设置声音"}
          </DialogTrigger>
        </div>
        {resolved.error ? (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {errorMessage(resolved.error)}
            <Button variant="ghost" size="sm" onClick={() => void resolved.refetch()}>
              重试
            </Button>
          </p>
        ) : null}
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>主持人声音</DialogTitle>
            <DialogDescription>
              只影响当前冒险。保存后覆盖模组预设，恢复则重新继承模组或冒险默认。
            </DialogDescription>
          </DialogHeader>
          <ScrollAreaPane className="min-h-0 flex-1">
            {open ? <HostVoiceForm roomId={roomId} onSaved={() => setOpen(false)} /> : null}
          </ScrollAreaPane>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function HostVoiceForm({ roomId, onSaved }: { roomId: string; onSaved: () => void }) {
  const id = useId();
  const client = useQueryClient();
  const options = desktopOrpc.tts.hostVoiceSettings.queryOptions({ input: { roomId } });
  const resolved = useQuery({ ...options, staleTime: 0 });
  const catalog = useQuery(desktopOrpc.tts.catalog.queryOptions());
  const settings = useQuery(desktopOrpc.tts.roomSettings.queryOptions({ input: { roomId } }));
  const config = resolved.data?.config;
  const provider = catalog.data?.find((item) => item.id === config?.provider);
  const initial: Draft | undefined = config
    ? {
        mode: config.model === designModel ? "design" : "preset",
        voice: config.voice === "custom" ? (provider?.voices[0]?.id ?? "冰糖") : config.voice,
        description: config.voiceDescription ?? "",
        instructions: config.instructions,
      }
    : undefined;
  const [draft, setDraft] = useState<Draft>();
  const current = draft ?? initial;
  const owner = `host-voice-preview:${roomId}`;
  const playback = useSpeechSnapshot();
  const previewing = playback.owner === owner && ["loading", "playing"].includes(playback.status);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      speechPlayer.stop(owner);
    };
  }, [owner]);
  const parsed = current
    ? ttsVoiceOverrideSchema.safeParse(
        current.mode === "design"
          ? {
              mode: "design",
              description: current.description,
              instructions: current.instructions,
            }
          : { mode: "preset", voice: current.voice, instructions: current.instructions },
      )
    : undefined;
  const save = useMutation({
    mutationFn: (voice: TtsVoiceOverride | null) => desktopRpc.tts.saveHostVoice({ roomId, voice }),
    onSuccess(value) {
      client.setQueryData(options.queryKey, value);
      setDraft(undefined);
    },
  });
  const busy = save.isPending;
  async function persist() {
    if (!parsed?.success || busy) return;
    speechPlayer.stop(owner);
    try {
      await save.mutateAsync(parsed.data);
      if (mounted.current) onSaved();
    } catch {
      /* mutation 统一展示错误。 */
    }
  }
  function preview() {
    if (!parsed?.success || !config) return;
    speechPlayer.replace({
      owner,
      key: owner,
      text: "夜色渐深，酒馆的门缓缓打开。你的冒险，即将开始。",
      speaker: { roomId, kind: "host", id: "" },
      preview: { config: ttsConfigWithVoice(config, parsed.data) },
    });
  }
  async function restore() {
    speechPlayer.stop(owner);
    try {
      await save.mutateAsync(null);
      if (mounted.current) onSaved();
    } catch {
      /* mutation 统一展示错误。 */
    }
  }

  if (!current)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        正在读取声音设置…
      </p>
    );

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void persist();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`${id}-model`}>语音模型</Label>
        <Select
          value={current.mode === "design" ? designModel : presetModel}
          items={provider?.models.map((item) => ({ value: item.id, label: item.name }))}
          disabled={busy}
          onValueChange={(value) => {
            if (value === presetModel) setDraft({ ...current, mode: "preset" });
            if (value === designModel) setDraft({ ...current, mode: "design" });
            save.reset();
          }}
        >
          <SelectTrigger id={`${id}-model`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {provider?.models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {current.mode === "preset" ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-voice`}>预置音色</Label>
          <Select
            value={current.voice}
            items={provider?.voices.map((item) => ({ value: item.id, label: item.name }))}
            disabled={busy}
            onValueChange={(voice) => {
              if (voice) setDraft({ ...current, voice });
              save.reset();
            }}
          >
            <SelectTrigger id={`${id}-voice`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider?.voices.map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  {voice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${id}-description`}>音色描述</Label>
          <Textarea
            id={`${id}-description`}
            rows={3}
            maxLength={1000}
            disabled={busy}
            value={current.description}
            onChange={(event) => {
              setDraft({ ...current, description: event.target.value });
              save.reset();
            }}
            placeholder="例如：一位阅历丰富的说书人，声音低沉、温暖，普通话清晰。"
          />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${id}-instructions`}>讲述方式</Label>
        <Textarea
          id={`${id}-instructions`}
          rows={3}
          maxLength={1000}
          disabled={busy}
          value={current.instructions}
          onChange={(event) => {
            setDraft({ ...current, instructions: event.target.value });
            save.reset();
          }}
          placeholder="例如：语速舒缓；危险场景略微压低声音。"
        />
      </div>
      {parsed && !parsed.success ? (
        <p role="alert" className="text-destructive text-xs">
          {current.mode === "design" ? "VoiceDesign 需要填写音色描述。" : "请选择预置音色。"}
        </p>
      ) : null}
      {!settings.data?.hasKey && !settings.isPending ? (
        <p className="text-muted-foreground text-xs">
          可先保存声音；试听前请在应用设置 → 语音供应商中连接供应商。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !parsed?.success}>
          {busy ? "保存中…" : "保存覆盖"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || (!previewing && (!parsed?.success || !settings.data?.hasKey))}
          onClick={() => (previewing ? speechPlayer.stop(owner) : preview())}
        >
          {previewing ? "停止试听" : "试听"}
        </Button>
        {resolved.data?.overridden ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void restore()}>
            恢复模组预设
          </Button>
        ) : null}
      </div>
      {previewing ? (
        <p role="status" className="text-muted-foreground text-xs">
          {playback.status === "loading" ? "正在合成试听…" : "正在试听…"}
        </p>
      ) : null}
      {save.error || resolved.error || catalog.error || settings.error ? (
        <p role="alert" className="text-destructive text-xs">
          {errorMessage(save.error ?? resolved.error ?? catalog.error ?? settings.error)}
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

function voiceName(voice: string) {
  return voice === "mimo_default" ? "默认音色" : voice;
}
