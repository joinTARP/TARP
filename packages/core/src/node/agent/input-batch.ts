import { z } from "zod";

import { hostInputBatchSchema, piMessageReferenceSchema } from "../../shared/game";

export const inputBatchCustomType = "tarp:host-input";
export const inputReceiptSchema = z.object({
  batchId: z.string().uuid(),
  messageId: z.string().uuid(),
});
export const receivedInputSchema = inputReceiptSchema.extend({
  reference: piMessageReferenceSchema,
});
export type ReceivedInput = z.infer<typeof receivedInputSchema>;
export type HostInputBatch = z.infer<typeof hostInputBatchSchema>;
