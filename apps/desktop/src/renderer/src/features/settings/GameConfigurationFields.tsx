import { companionInitiativeOptions } from "@jointarp/core/shared/companion-initiative";
import {
  companionRoleplayInstructions,
  maxCompanionRoleplayLength,
  resolveCompanionRoleplay,
} from "@jointarp/core/shared/companion-roleplay";
import type { GameDefaults } from "@jointarp/core/shared/game-defaults";
import {
  defaultHostSystemPrompt,
  maxHostSystemPromptLength,
  resolveHostSystemPrompt,
} from "@jointarp/core/shared/host-system-prompt";
import { mentionReplyLimitSchema } from "@jointarp/core/shared/mentions";
import type { TtsVoiceOverride } from "@jointarp/core/shared/voice";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { errorMessage } from "../sessions/game-client";
import { AutosaveField } from "./AutosaveField";
import { ConfigurationTextSetting } from "./ConfigurationTextSetting";
import { ModelPicker } from "./ModelPicker";
import { SettingsSection as Section, useSettingsCardLayout } from "./SettingsSection";
import type { GameConfiguration } from "./use-game-configuration";

type ConfigurationProps = { configuration: GameConfiguration };

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? (
          <p className="text-muted-foreground mt-1 text-xs leading-5">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="bg-input aria-checked:bg-primary focus-visible:outline-ring inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        <span
          className={`bg-background size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${checked ? "translate-x-4" : "translate-x-0"}`}
        />
      </button>
    </div>
  );
}
function ConfigurationChoice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; name: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const items = options.some((item) => item.id === value)
    ? options
    : [{ id: value, name: `${value}（不可用）` }, ...options];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <p className="text-sm font-medium">{label}</p>
      <Select
        value={value}
        disabled={disabled}
        items={items.map((item) => ({ value: item.id, label: item.name }))}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label} className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ConfigurationModel({
  configuration,
  label,
  kind,
}: ConfigurationProps & { label: string; kind: "host" | "companion" }) {
  const { current, models, disabled, setDialog, choose } = configuration;
  const selection = kind === "host" ? current.ai : current.companion.model;
  const unavailable =
    selection &&
    models.data &&
    !models.data.some(
      (model) => model.provider === selection.provider && model.model === selection.model,
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground mt-1 text-xs break-words">
          {selection
            ? `${selection.providerName} · ${selection.name}`
            : kind === "companion"
              ? "跟随当前冒险主持模型"
              : "尚未选择"}
        </p>
        {unavailable ? (
          <p role="status" className="text-destructive mt-1 text-xs">
            连接不可用，请重新连接或选择模型。
          </p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setDialog(kind)}>
        选择模型
      </Button>
      {selection ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            void choose(kind === "host" ? { ai: null } : { companion: { model: null } })
          }
        >
          {kind === "host" ? "清除" : "跟随主持"}
        </Button>
      ) : null}
    </div>
  );
}
export function HostPromptConfiguration({
  configuration,
  description,
  editorDescription,
  resetValue,
}: ConfigurationProps & {
  description: string;
  editorDescription: string;
  resetValue: string | null;
}) {
  const { current, disabled, onSave, choose } = configuration;
  const [promptGeneration, setPromptGeneration] = useState(0);
  return (
    <Section title="主持系统提示词" description={description}>
      <ConfigurationTextSetting
        generation={promptGeneration}
        disabled={disabled}
        summary={
          current.hostSystemPrompt === null || current.hostSystemPrompt === defaultHostSystemPrompt
            ? "使用内置指令"
            : "已自定义"
        }
        description={editorDescription}
        label="通用主持指令"
        multiline
        value={resolveHostSystemPrompt(current.hostSystemPrompt)}
        maxLength={maxHostSystemPromptLength}
        validate={(value) => (value.trim() ? undefined : "主持指令不能为空。")}
        hint="模组提示继续追加；完成输入或按 ⌘ / Ctrl + Enter 保存。"
        onSave={(value) => onSave({ hostSystemPrompt: value })}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void choose({
              hostSystemPrompt: resetValue,
            }).then((saved) => {
              if (saved) setPromptGeneration((value) => value + 1);
            });
          }}
        >
          恢复内置主持指令
        </Button>
      </ConfigurationTextSetting>
    </Section>
  );
}
export function CompanionRoleplayConfiguration({
  configuration,
  description,
  resetValue,
}: ConfigurationProps & { description: string; resetValue: string | null }) {
  const { current, disabled, onSave, choose } = configuration;
  const [generation, setGeneration] = useState(0);
  return (
    <Section title="队友扮演指导" description={description}>
      <ConfigurationTextSetting
        generation={generation}
        disabled={disabled}
        summary={
          current.companionRoleplayPrompt === null ||
          current.companionRoleplayPrompt === companionRoleplayInstructions
            ? "使用内置指导"
            : "已自定义"
        }
        description="所有 AI 队友共用，调整扮演和表达方式；模组角色设定继续生效，身份、权限与工具规则保留。"
        label="通用扮演指导"
        multiline
        value={resolveCompanionRoleplay(current.companionRoleplayPrompt)}
        maxLength={maxCompanionRoleplayLength}
        validate={(value) => (value.trim() ? undefined : "扮演指导不能为空。")}
        hint="完成输入或按 ⌘ / Ctrl + Enter 保存。"
        onSave={(value) => onSave({ companionRoleplayPrompt: value })}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void choose({ companionRoleplayPrompt: resetValue }).then((saved) => {
              if (saved) setGeneration((value) => value + 1);
            });
          }}
        >
          恢复内置扮演指导
        </Button>
      </ConfigurationTextSetting>
    </Section>
  );
}
export function GeneralConfiguration({ configuration }: ConfigurationProps) {
  const { current, disabled, choose, onSave } = configuration;
  return (
    <>
      <Section title="主持" description="选择新冒险使用的主持模型。">
        <ConfigurationModel configuration={configuration} label="默认主持模型" kind="host" />
      </Section>
      <Section title="聊天">
        <ConfigurationChoice
          label="行动提交方式"
          value={current.chat.submissionMode}
          options={[
            { id: "auto", name: "自动提交" },
            { id: "manual", name: "手动提交" },
          ]}
          disabled={disabled}
          onChange={(value) =>
            void choose({ chat: { submissionMode: value as "auto" | "manual" } })
          }
        />
        <Toggle
          label="主持插话"
          description="允许玩家在主持生成时补充行动或问题。"
          checked={current.chat.steeringEnabled}
          disabled={disabled}
          onChange={(value) => void choose({ chat: { steeringEnabled: value } })}
        />
        <AutosaveField
          label="连续响应上限"
          value={String(current.chat.mentionReplyLimit)}
          maxLength={2}
          hint="每条点名对话链最多自动生成的回复数，包含主持场外回应和队友回复，范围 1–32。"
          validate={(value) =>
            mentionReplyLimitSchema.safeParse(Number(value)).success
              ? undefined
              : "请输入 1–32 之间的整数。"
          }
          onSave={(value) => onSave({ chat: { mentionReplyLimit: Number(value) } })}
        />
      </Section>
      <Section title="显示" description="以下选项可能展示隐藏线索或幕后信息。">
        <Toggle
          label="显示推理细节"
          checked={current.display.showReasoning}
          disabled={disabled}
          onChange={(value) => void choose({ display: { showReasoning: value } })}
        />
        <Toggle
          label="查看全部模组内容"
          checked={current.display.showAllDocuments}
          disabled={disabled}
          onChange={(value) => void choose({ display: { showAllDocuments: value } })}
        />
      </Section>
    </>
  );
}
export function VoiceConfiguration({
  configuration,
  title,
  automaticDescription,
}: ConfigurationProps & { title: string; automaticDescription: string }) {
  const {
    current,
    disabled,
    choose,
    chooseAfterFlush,
    onSave,
    catalog,
    connections,
    preview,
    previewing,
    previewError,
  } = configuration;
  const provider = catalog.data?.find((item) => item.id === current.tts.config.provider);
  const designed =
    provider?.models.find((item) => item.id === current.tts.config.model)?.kind === "design";
  const connected = connections.data?.some(
    (item) => item.provider === current.tts.config.provider && item.hasKey,
  );
  return (
    <Section
      title={title}
      description="声音优先采用个人覆盖，其次模组预设，最后使用这段冒险的默认声音。"
    >
      <Toggle
        label="允许语音"
        checked={current.tts.enabled}
        disabled={disabled}
        onChange={(value) => void chooseAfterFlush({ tts: { enabled: value } })}
      />
      {current.tts.enabled ? (
        <>
          <Toggle
            label="自动朗读新消息"
            description={automaticDescription}
            checked={current.tts.automatic}
            disabled={disabled}
            onChange={(value) => void choose({ tts: { automatic: value } })}
          />
          <div className="[&>div+div]:border-border/40 space-y-5 [&>div+div]:border-t [&>div+div]:pt-5">
            <ConfigurationChoice
              label="语音供应商"
              value={current.tts.config.provider}
              options={catalog.data?.map((item) => ({ id: item.id, name: item.name })) ?? []}
              disabled={disabled}
              onChange={(value) => {
                const next = catalog.data?.find((item) => item.id === value);
                if (next) void chooseAfterFlush({ tts: { config: next.defaultConfig } });
              }}
            />
            <ConfigurationChoice
              label="语音模型"
              value={current.tts.config.model}
              options={provider?.models ?? []}
              disabled={disabled}
              onChange={(value) => {
                const model = provider?.models.find((item) => item.id === value);
                void chooseAfterFlush({
                  tts: {
                    config: {
                      model: value,
                      voice: model?.kind === "design" ? "custom" : (provider?.voices[0]?.id ?? ""),
                      voiceDescription:
                        model?.kind === "design"
                          ? current.tts.config.voiceDescription || "一位温和清晰的中文故事讲述者。"
                          : "",
                    },
                  },
                });
              }}
            />
          </div>
          {!connected ? (
            <p role="status" className="text-muted-foreground text-xs">
              此供应商未连接。配置会保留，连接后才能朗读。
            </p>
          ) : null}
          {designed ? (
            <ConfigurationTextSetting
              label="默认音色描述"
              disabled={disabled}
              summary={current.tts.config.voiceDescription?.trim() || "尚未设置音色描述"}
              description="描述默认声音的年龄感、音色和表达特点。"
              multiline
              maxLength={1000}
              value={current.tts.config.voiceDescription ?? ""}
              validate={(value) => (value.trim() ? undefined : "定制音色需要描述。")}
              onSave={(value) => onSave({ tts: { config: { voiceDescription: value } } })}
            />
          ) : (
            <ConfigurationChoice
              label="默认音色"
              value={current.tts.config.voice}
              options={provider?.voices ?? []}
              disabled={disabled}
              onChange={(value) => void choose({ tts: { config: { voice: value } } })}
            />
          )}
          <ConfigurationTextSetting
            label="讲述风格"
            disabled={disabled}
            summary={current.tts.config.instructions.trim() || "使用默认讲述风格"}
            description="设定默认声音的语气和讲述节奏。"
            multiline
            maxLength={1000}
            value={current.tts.config.instructions}
            onSave={(value) => onSave({ tts: { config: { instructions: value } } })}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !connected}
            onClick={() => void preview()}
          >
            {previewing ? "停止试听" : "试听默认声音"}
          </Button>
          {previewError ? (
            <p role="alert" className="text-destructive text-xs">
              {previewError}
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
export function CompanionConfiguration({
  configuration,
  description,
}: ConfigurationProps & { description: string }) {
  const { current, disabled, choose, chooseAfterFlush, onSave, catalog } = configuration;
  const voice = current.companion.voice;
  const voiceMode = voice?.mode ?? "inherit";
  function saveVoice(patch: Partial<TtsVoiceOverride>) {
    return onSave({ companion: { voice: { ...voice, ...patch } as TtsVoiceOverride } });
  }
  return (
    <Section title="新增队友默认模板" description={description}>
      <ConfigurationModel configuration={configuration} label="队友默认模型" kind="companion" />
      <Toggle
        label="允许队友查阅文档"
        description="队友可按需查阅玩家可见的资料，可能增加等待时间和 Token 消耗。"
        checked={current.companion.documentAccess}
        disabled={disabled}
        onChange={(documentAccess) => void choose({ companion: { documentAccess } })}
      />
      <ConfigurationChoice
        label="互动主动性"
        value={current.companion.initiative.level}
        options={companionInitiativeOptions.map((item) => ({
          id: item.id,
          name: item.label,
        }))}
        disabled={disabled}
        onChange={(value) =>
          void choose({
            companion: {
              initiative: {
                level: value as GameDefaults["companion"]["initiative"]["level"],
              },
            },
          })
        }
      />
      {current.companion.initiative.level === "custom" ? (
        <ConfigurationTextSetting
          label="自定义互动指令"
          disabled={disabled}
          summary={current.companion.initiative.prompt.trim() || "未填写，使用自然互动规则"}
          description="设定新加入的队友何时发言、如何参与讨论。"
          multiline
          maxLength={2000}
          hint="只在自定义主动性档位生效；切换档位会保留文本。"
          value={current.companion.initiative.prompt}
          onSave={(value) => onSave({ companion: { initiative: { prompt: value } } })}
        />
      ) : null}
      {current.tts.enabled ? (
        <>
          <ConfigurationChoice
            label="队友默认声音"
            value={voiceMode}
            options={[
              { id: "inherit", name: "使用冒险默认声音" },
              { id: "preset", name: "预置音色" },
              { id: "design", name: "定制音色" },
            ]}
            disabled={disabled || current.tts.config.provider !== "mimo"}
            onChange={(value) =>
              void chooseAfterFlush({
                companion: {
                  voice:
                    value === "inherit"
                      ? null
                      : value === "design"
                        ? {
                            mode: "design",
                            description: "一位自然清晰的中文冒险同伴。",
                            instructions: voice?.instructions ?? "",
                          }
                        : {
                            mode: "preset",
                            voice: "冰糖",
                            instructions: voice?.instructions ?? "",
                          },
                },
              })
            }
          />
          {voice?.mode === "design" ? (
            <ConfigurationTextSetting
              label="队友音色描述"
              disabled={disabled}
              summary={voice.description.trim() || "尚未设置音色描述"}
              description="描述新加入的队友使用的默认音色。"
              multiline
              maxLength={1000}
              value={voice.description}
              validate={(value) => (value.trim() ? undefined : "请填写音色描述。")}
              onSave={(value) => saveVoice({ description: value })}
            />
          ) : voice?.mode === "preset" ? (
            <ConfigurationChoice
              label="队友预置音色"
              value={voice.voice}
              options={catalog.data?.find((item) => item.id === "mimo")?.voices ?? []}
              disabled={disabled}
              onChange={(value) =>
                void choose({
                  companion: { voice: { ...voice, voice: value as typeof voice.voice } },
                })
              }
            />
          ) : null}
          {voice ? (
            <ConfigurationTextSetting
              label="队友讲述风格"
              disabled={disabled}
              summary={voice.instructions.trim() || "使用默认讲述风格"}
              description="设定新加入的队友的默认语气和讲述节奏。"
              multiline
              maxLength={1000}
              value={voice.instructions}
              onSave={(value) => saveVoice({ instructions: value })}
            />
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
export function CompactionConfiguration({ configuration }: ConfigurationProps) {
  const { current, onSave } = configuration;
  return (
    <Section
      title="自动压缩"
      description="留空表示按当前模型窗口自动计算，填写 Token 数指定触发阈值。"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {(["host", "companion"] as const).map((role) => (
          <AutosaveField
            key={role}
            label={role === "host" ? "主持压缩阈值" : "队友压缩阈值"}
            value={current.compaction[role].thresholdTokens?.toString() ?? ""}
            validate={(value) =>
              !value.trim() ||
              (/^\d+$/.test(value.trim()) && Number(value) >= 1024 && Number(value) <= 2000000)
                ? undefined
                : "请输入 1024–2000000 的整数，或留空。"
            }
            onSave={(value) =>
              onSave({
                compaction: {
                  [role]: { thresholdTokens: value.trim() ? Number(value) : null },
                },
              })
            }
          />
        ))}
      </div>
    </Section>
  );
}
export function ContextSubscriptionsConfiguration({ configuration }: ConfigurationProps) {
  const { current, disabled, choose } = configuration;
  return (
    <Section title="上下文订阅">
      <Toggle
        label="允许 AI 订阅文档字段"
        description="开启后，AI 可主动选择需要持续关注的字段，每轮自动获得最新值。自动附带字段会增加 Token 消耗，但可能减少工具读取次数、提升响应速度。AI 队友还需开启文档查阅。"
        checked={current.contextSubscriptionsEnabled}
        disabled={disabled}
        onChange={(contextSubscriptionsEnabled) => void choose({ contextSubscriptionsEnabled })}
      />
    </Section>
  );
}
export function ConfigurationFrame({
  configuration,
  modelDescription,
  children,
}: ConfigurationProps & { modelDescription: string; children: ReactNode }) {
  const cards = useSettingsCardLayout();
  const {
    current,
    error,
    busy,
    disabled,
    retry,
    models,
    catalog,
    connections,
    dialog,
    setDialog,
    choose,
  } = configuration;
  const modelSelection = dialog === "host" ? current.ai : current.companion.model;
  return (
    <div className={cards ? "space-y-7" : undefined}>
      {error ? (
        <div role="alert" className="text-destructive bg-destructive/5 mb-6 rounded-lg p-4 text-sm">
          {error}
          <Button variant="ghost" size="sm" onClick={() => void retry()}>
            重试保存
          </Button>
        </div>
      ) : null}
      {models.error || catalog.error || connections.error ? (
        <div role="alert" className="text-destructive mb-6 text-sm">
          {errorMessage(models.error ?? catalog.error ?? connections.error)}
          <Button
            variant="ghost"
            onClick={() => {
              void models.refetch();
              void catalog.refetch();
              void connections.refetch();
            }}
          >
            重试读取服务
          </Button>
        </div>
      ) : null}
      {children}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent overlayClassName="z-[110]" className="z-[120] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{dialog === "host" ? "默认主持模型" : "队友默认模型"}</DialogTitle>
            <DialogDescription>{modelDescription}</DialogDescription>
          </DialogHeader>
          <ModelPicker
            models={models.data ?? []}
            selection={modelSelection}
            busy={disabled}
            loading={models.isPending}
            onSelect={(model) => {
              void choose(dialog === "host" ? { ai: model } : { companion: { model } }).then(
                (saved) => {
                  if (saved) setDialog(null);
                },
              );
            }}
          />
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
              <Button variant="ghost" onClick={() => void retry()}>
                重试保存
              </Button>
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
