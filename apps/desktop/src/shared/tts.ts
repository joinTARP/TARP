import type { TtsVoiceOverride } from "@jointarp/core/shared/voice";
import { z } from "zod";
export { roomTtsSettingsSchema, ttsVoiceOverrideSchema } from "@jointarp/core/shared/voice";
export type { TtsVoiceOverride } from "@jointarp/core/shared/voice";

/** 播放端只依赖通用音频与配置；服务商协议留在主进程。 */
export { ttsConfigSchema } from "@jointarp/core/shared/voice";
export type { TtsConfig } from "@jointarp/core/shared/voice";
import { ttsConfigSchema, type TtsConfig } from "@jointarp/core/shared/voice";
export interface TtsProviderInfo {
  id: string;
  name: string;
  models: { id: string; name: string; kind?: "preset" | "design"; lowLatencyStream?: boolean }[];
  voices: { id: string; name: string }[];
  defaultConfig: TtsConfig;
}
export interface TtsSettings {
  automatic: boolean;
  config: TtsConfig;
  hasKey: boolean;
}
export interface TtsAudio {
  data: string;
  mimeType: "audio/wav" | "audio/mpeg" | "audio/ogg";
}
const ttsPcmChunkSchema = z.object({
  type: z.literal("pcm"),
  data: z.string(),
  sampleRate: z.number().int().min(8000).max(96000),
  channels: z.union([z.literal(1), z.literal(2)]),
});
export type TtsPcmChunk = z.infer<typeof ttsPcmChunkSchema>;
export const ttsChunkSchema = z.discriminatedUnion("type", [
  ttsPcmChunkSchema,
  z.object({
    type: z.literal("audio"),
    audio: z.object({
      data: z.string(),
      mimeType: z.enum(["audio/wav", "audio/mpeg", "audio/ogg"]),
    }),
  }),
]);
export type TtsChunk = z.infer<typeof ttsChunkSchema>;
const ttsSpeakerSchema = z.object({
  roomId: z.string().uuid(),
  kind: z.enum(["host", "companion", "npc"]),
  id: z.string().max(2048),
});
export type TtsSpeaker = z.infer<typeof ttsSpeakerSchema>;
export const ttsTextLimit = 1000;
export const ttsSynthesizeSchema = z.object({
  text: z.string().trim().min(1).max(ttsTextLimit),
  speaker: ttsSpeakerSchema.optional(),
  /** 仅用于试听当前草稿，不写入应用或房间设置。 */
  preview: z
    .object({
      config: ttsConfigSchema,
      apiKey: z.string().trim().min(1).max(4096).optional(),
    })
    .strict()
    .optional(),
});
export type TtsPreview = NonNullable<z.infer<typeof ttsSynthesizeSchema>["preview"]>;
export const ttsSaveSchema = z.object({
  config: ttsConfigSchema,
  automatic: z.boolean(),
  apiKey: z.string().trim().max(4096).optional(),
});

export function ttsConfigWithVoice(base: TtsConfig, voice: TtsVoiceOverride): TtsConfig {
  return {
    ...base,
    instructions: voice.instructions,
    ...(voice.mode === "design"
      ? {
          model: "mimo-v2.5-tts-voicedesign",
          voice: "custom",
          voiceDescription: voice.description,
        }
      : { model: "mimo-v2.5-tts", voice: voice.voice, voiceDescription: undefined }),
  };
}

/** 房间声音编辑器需要同时知道最终配置与是否存在房间覆盖。 */
export interface TtsResolvedVoice {
  config: TtsConfig;
  overridden: boolean;
}
