import { z } from "zod";

import { messageSchema, piMessageReferenceSchema, steeringEntrySchema } from "../../shared/game";

export const steeringCustomType = "tarp:host-steering";
export const steeringBatchSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  previousMessageId: z.string().uuid().nullable(),
  entries: z.array(steeringEntrySchema).min(1).max(5),
  nextMessage: messageSchema,
  prompt: z.string(),
});
export type SteeringBatch = z.infer<typeof steeringBatchSchema>;
export const receivedSteeringSchema = z.object({
  batch: steeringBatchSchema,
  reference: piMessageReferenceSchema,
});
export type ReceivedSteering = z.infer<typeof receivedSteeringSchema>;
