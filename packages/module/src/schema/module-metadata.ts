import { z } from "zod";

import { documentIdentity } from "./document-path";
import { preludeFlowSchema, gameStartSchema } from "./flow";

/** 模组根目录 module.json / module.toml 的固定结构。 */
export const moduleVoiceSchema = z
  .object({
    description: z.string().trim().min(1).max(1000).optional(),
    instructions: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((voice) => Boolean(voice.description || voice.instructions), {
    message: "请提供音色描述或讲述要求",
  });

export const moduleMetadataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    cover: z.string().trim().min(1).optional(),
    system: z.string().trim().min(1).optional(),
    author: z.string().trim().min(1).optional(),
    version: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    /** 给玩家阅读的 Markdown，不进入文档类型，也不参与开局。 */
    pages: z.array(z.string().trim().min(1)).max(30).optional(),
    /** 追加给 AI 主持人的模组提示。不能覆盖平台权限。 */
    hostPrompt: z.string().max(10000).optional(),
    /** 模组作者定义的角色声音；按角色文档路径匹配。 */
    tts: z
      .object({
        host: moduleVoiceSchema.optional(),
        characters: z
          .record(z.string(), moduleVoiceSchema)
          .superRefine((voices, context) => {
            const seen = new Set<string>();
            for (const path of Object.keys(voices)) {
              const identity = documentIdentity(path);
              if (seen.has(identity))
                context.addIssue({
                  code: "custom",
                  path: [path],
                  message: `同一角色不能配置多个音色：${identity}`,
                });
              seen.add(identity);
            }
          })
          .transform((voices) =>
            Object.fromEntries(
              Object.entries(voices).map(([path, voice]) => [documentIdentity(path), voice]),
            ),
          )
          .optional(),
      })
      .strict()
      .optional(),
    /** 可选的模组主持人展示资料；头像支持模组内图片路径或 HTTP(S) 地址。 */
    host: z
      .object({
        name: z.string().trim().min(1).max(32).optional(),
        avatar: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    preludeFlow: preludeFlowSchema.optional(),
    gameStarts: z.array(gameStartSchema).min(1).max(30).optional(),
  })
  .strict();

export type ModuleMetadataFile = z.infer<typeof moduleMetadataSchema>;
