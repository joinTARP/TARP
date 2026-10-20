import { z } from "zod";

import { roomDisplaySettingsSchema } from "./agent-details";
import { compactionSettingsSchema } from "./compaction-settings";
import { companionInitiativeSchema } from "./companion-initiative";
import {
  companionRoleplayInstructions,
  maxCompanionRoleplayLength,
  resolveCompanionRoleplay,
} from "./companion-roleplay";
import { availableAiModelSchema, submissionModeSchema } from "./game";
import { maxHostSystemPromptLength, resolveHostSystemPrompt } from "./host-system-prompt";
import { mentionReplyLimitSchema } from "./mentions";
import { defaultTtsConfig, ttsConfigSchema, ttsVoiceOverrideSchema } from "./voice";

const roleSchema = z.strictObject({
  thresholdTokens: compactionSettingsSchema.shape.thresholdTokens.default(null),
});
export const companionDefaultsSchema = z.strictObject({
  /** null 表示跟随当前冒险主持模型。 */
  model: availableAiModelSchema.nullable().default(null),
  initiative: companionInitiativeSchema.strict().prefault({}),
  documentAccess: z.boolean().default(false),
  /** 新增队友的声音兜底，不覆盖模组声音或个人覆盖。 */
  voice: ttsVoiceOverrideSchema.nullable().default(null),
});
export const gameDefaultsSchema = z.strictObject({
  contextSubscriptionsEnabled: z.boolean().default(false),
  companionRoleplayPrompt: z
    .string()
    .trim()
    .min(1)
    .max(maxCompanionRoleplayLength)
    .nullable()
    .default(null),
  ai: availableAiModelSchema.nullable().default(null),
  hostSystemPrompt: z
    .string()
    .trim()
    .min(1)
    .max(maxHostSystemPromptLength)
    .nullable()
    .default(null),
  chat: z
    .strictObject({
      submissionMode: submissionModeSchema.default("auto"),
      steeringEnabled: z.boolean().default(false),
      mentionReplyLimit: mentionReplyLimitSchema.default(8),
    })
    .prefault({}),
  compaction: z
    .strictObject({
      host: roleSchema.prefault({}),
      companion: roleSchema.prefault({}),
    })
    .prefault({}),
  display: roomDisplaySettingsSchema.strict().prefault({}),
  tts: z
    .strictObject({
      enabled: z.boolean().default(true),
      automatic: z.boolean().default(false),
      config: ttsConfigSchema.default(defaultTtsConfig),
    })
    .prefault({}),
  companion: companionDefaultsSchema.prefault({}),
});
export type GameDefaults = z.infer<typeof gameDefaultsSchema>;

/** 按分区中的字段更新，禁止整页旧值覆盖另一个窗口的修改。 */
export const gameDefaultsPatchSchema = z.strictObject({
  companionRoleplayPrompt: z
    .string()
    .trim()
    .min(1)
    .max(maxCompanionRoleplayLength)
    .nullable()
    .optional(),
  contextSubscriptionsEnabled: z.boolean().optional(),
  ai: availableAiModelSchema.nullable().optional(),
  hostSystemPrompt: z.string().trim().min(1).max(maxHostSystemPromptLength).nullable().optional(),
  chat: z
    .strictObject({
      submissionMode: submissionModeSchema.optional(),
      steeringEnabled: z.boolean().optional(),
      mentionReplyLimit: mentionReplyLimitSchema.optional(),
    })
    .optional(),
  display: z
    .strictObject({
      showReasoning: z.boolean().optional(),
      showAllDocuments: z.boolean().optional(),
    })
    .optional(),
  compaction: z
    .strictObject({
      host: compactionSettingsSchema.strict().optional(),
      companion: compactionSettingsSchema.strict().optional(),
    })
    .optional(),
  tts: z
    .strictObject({
      enabled: z.boolean().optional(),
      automatic: z.boolean().optional(),
      config: ttsConfigSchema.partial().optional(),
    })
    .optional(),
  companion: z
    .strictObject({
      model: availableAiModelSchema.nullable().optional(),
      documentAccess: z.boolean().optional(),
      initiative: z
        .strictObject({
          level: companionInitiativeSchema.shape.level.unwrap().optional(),
          prompt: companionInitiativeSchema.shape.prompt.unwrap().optional(),
        })
        .optional(),
      voice: ttsVoiceOverrideSchema.nullable().optional(),
    })
    .optional(),
});
export type GameDefaultsPatch = z.infer<typeof gameDefaultsPatchSchema>;
/** 聊天和模型由各自的业务入口更新，以保持运行状态与通知一致。 */
export const roomConfigurationPatchSchema = gameDefaultsPatchSchema.pick({
  companionRoleplayPrompt: true,
  contextSubscriptionsEnabled: true,
  hostSystemPrompt: true,
  tts: true,
  companion: true,
});
export function patchGameDefaults(current: GameDefaults, patch: GameDefaultsPatch): GameDefaults {
  const parsed = gameDefaultsPatchSchema.parse(patch);
  return gameDefaultsSchema.parse({
    ...current,
    ...parsed,
    chat: { ...current.chat, ...parsed.chat },
    display: { ...current.display, ...parsed.display },
    compaction: { ...current.compaction, ...parsed.compaction },
    tts: {
      ...current.tts,
      ...parsed.tts,
      config: { ...current.tts.config, ...parsed.tts?.config },
    },
    companion: {
      ...current.companion,
      ...parsed.companion,
      initiative: { ...current.companion.initiative, ...parsed.companion?.initiative },
    },
  });
}

export const roomSettingsSchema = gameDefaultsSchema.extend({
  companionRoleplayPrompt: z
    .string()
    .trim()
    .min(1)
    .max(maxCompanionRoleplayLength)
    .default(companionRoleplayInstructions),
  hostSystemPrompt: z.string().trim().min(1).max(maxHostSystemPromptLength),
  chat: gameDefaultsSchema.shape.chat.unwrap().extend({
    submissionModeRevision: z.number().int().nonnegative().safe(),
  }),
  tts: gameDefaultsSchema.shape.tts
    .unwrap()
    .extend({
      host: ttsVoiceOverrideSchema.nullable().default(null),
    })
    .prefault({}),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;
/** 提取房间中的公共配置；不携带提交版本和主持声音覆盖。 */
export function roomConfiguration(settings: RoomSettings): GameDefaults {
  const { submissionModeRevision: _revision, ...chat } = settings.chat;
  const { host: _host, ...tts } = settings.tts;
  return gameDefaultsSchema.parse({ ...settings, chat, tts });
}

export function snapshotGameDefaults(input: z.input<typeof gameDefaultsSchema> = {}): RoomSettings {
  const defaults = gameDefaultsSchema.parse(input);
  return roomSettingsSchema.parse({
    ...defaults,
    chat: { ...defaults.chat, submissionModeRevision: 0 },
    hostSystemPrompt: resolveHostSystemPrompt(defaults.hostSystemPrompt),
    companionRoleplayPrompt: resolveCompanionRoleplay(defaults.companionRoleplayPrompt),
  });
}
