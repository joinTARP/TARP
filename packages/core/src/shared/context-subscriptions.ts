import { z } from "zod";

export const contextFieldSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) => value.startsWith("/") && !/~(?![01])/u.test(value),
    "字段必须使用有效的 JSON Pointer",
  );
export const contextSubscriptionSchema = z.strictObject({
  document: z.string().min(1).max(1000),
  fields: z.array(contextFieldSchema).min(1).max(100),
});
export const contextSubscriptionListSchema = z
  .array(contextSubscriptionSchema)
  .max(16)
  .refine(
    (items) => items.reduce((count, item) => count + item.fields.length, 0) <= 100,
    "每个角色最多订阅 100 个字段",
  );
export type ContextSubscription = z.infer<typeof contextSubscriptionSchema>;
