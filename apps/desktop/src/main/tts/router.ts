import { eventIterator } from "@orpc/contract";
import { ORPCError } from "@orpc/server";
import { ttsVoiceOverrideSchema, ttsChunkSchema, ttsSynthesizeSchema } from "@shared/tts";
import { identityIdSchema } from "@tarp/core/shared/identity";
import { z } from "zod";

import { AppConfigError } from "../config/app-config";
import { desktopProcedure as procedure } from "../desktop-rpc-context";
import { TtsError } from "./provider";

async function ttsOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppConfigError) throw error;
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: error instanceof TtsError ? error.message : "语音操作没有完成，请稍后重试。",
    });
  }
}

export const ttsRouter = {
  roomSettings: procedure
    .input(z.object({ roomId: z.string().uuid() }))
    .handler(({ context, input }) => ttsOperation(() => context.tts.roomSettings(input.roomId))),
  saveRoomSettings: procedure
    .input(z.object({ roomId: z.string().uuid(), enabled: z.boolean() }))
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.saveRoomSettings(input.roomId, input.enabled)),
    ),
  voiceSettings: procedure
    .input(z.object({ roomId: z.string().uuid(), companionId: identityIdSchema }))
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.voiceSettings(input.roomId, input.companionId)),
    ),
  hostVoiceSettings: procedure
    .input(z.object({ roomId: z.string().uuid() }))
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.hostVoiceSettings(input.roomId)),
    ),
  saveHostVoice: procedure
    .input(
      z.object({
        roomId: z.string().uuid(),
        voice: ttsVoiceOverrideSchema.nullable(),
      }),
    )
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.saveHostVoice(input.roomId, input.voice)),
    ),
  catalog: procedure.handler(({ context }) => context.tts.catalog()),
  automatic: procedure
    .input(z.object({ roomId: z.string().uuid(), enabled: z.boolean() }))
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.setRoomAutomatic(input.roomId, input.enabled)),
    ),
  connections: procedure.handler(({ context }) => ttsOperation(() => context.tts.connections())),
  connect: procedure
    .input(z.object({ provider: z.string().min(1), apiKey: z.string().trim().min(1).max(4096) }))
    .handler(({ context, input }) =>
      ttsOperation(() => context.tts.connect(input.provider, input.apiKey)),
    ),
  disconnect: procedure
    .input(z.object({ provider: z.string().min(1) }))
    .handler(({ context, input }) => ttsOperation(() => context.tts.disconnect(input.provider))),
  stream: procedure
    .input(ttsSynthesizeSchema)
    .output(eventIterator(ttsChunkSchema))
    .handler(async function* ({ context, input, signal }) {
      try {
        yield* context.tts.stream(input.text, input.speaker, signal, input.preview);
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: error instanceof TtsError ? error.message : "语音流已中断，请重试。",
        });
      }
    }),
  synthesize: procedure
    .input(ttsSynthesizeSchema)
    .handler(({ context, input, signal }) =>
      ttsOperation(() => context.tts.synthesize(input.text, input.speaker, signal, input.preview)),
    ),
};
