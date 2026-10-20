import { z } from "zod";

export const roomTtsSettingsSchema = z.object({ enabled: z.boolean().default(true) });

/** 房间内单名队友的声音覆盖，不包含凭据。缺省时继承模组。 */
export const ttsVoiceOverrideSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("preset"),
      voice: z.enum([
        "mimo_default",
        "冰糖",
        "茉莉",
        "苏打",
        "白桦",
        "Mia",
        "Chloe",
        "Milo",
        "Dean",
      ]),
      instructions: z.string().trim().max(1000).default(""),
    })
    .strict(),
  z
    .object({
      mode: z.literal("design"),
      description: z.string().trim().min(1, "请填写音色描述").max(1000),
      instructions: z.string().trim().max(1000).default(""),
    })
    .strict(),
]);
export type TtsVoiceOverride = z.infer<typeof ttsVoiceOverrideSchema>;

/** 可写入冒险快照的语音配置；供应商凭据只由应用管理。 */
export const ttsConfigSchema = z.strictObject({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  voice: z.string().min(1).max(120),
  instructions: z.string().trim().max(1000),
  voiceDescription: z.string().trim().max(1000).optional(),
});
export type TtsConfig = z.infer<typeof ttsConfigSchema>;
export const defaultTtsConfig: TtsConfig = {
  provider: "mimo",
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  instructions: "用自然清晰的普通话讲述故事，语速适中，根据内容表达情绪。",
};
