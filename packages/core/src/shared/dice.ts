import { z } from "zod";

import { identityIdSchema } from "./identity";

/** 第一版支持 NdS±M，限制骰子数量和面数，避免无界运算。 */
export function parseDice(expression: string) {
  const match = /^(\d{1,2})?d(\d{1,4})([+-]\d{1,4})?$/i.exec(expression.replace(/\s/g, ""));
  if (!match) throw new Error("使用 1d20、2d6+3 这样的格式");
  const count = Number(match[1] || 1),
    sides = Number(match[2]),
    modifier = Number(match[3] || 0);
  if (count < 1 || count > 20 || sides < 2 || sides > 1000 || Math.abs(modifier) > 1000)
    throw new Error("支持 1–20 颗骰子、2–1000 面和 ±1000 内的修正值");
  return {
    count,
    sides,
    modifier,
    expression: `${count}d${sides}${modifier ? `${modifier > 0 ? "+" : ""}${modifier}` : ""}`,
  };
}
export const diceOptionsSchema = z.object({
  expression: z
    .string()
    .max(40)
    .refine((value) => {
      try {
        parseDice(value);
        return true;
      } catch {
        return false;
      }
    }, "使用有效的骰子表达式，例如 1d20 或 2d6+3"),
  reason: z.string().trim().max(120).default(""),
  targetPlayerId: identityIdSchema.optional(),
});
export type DiceOptions = z.infer<typeof diceOptionsSchema>;
export const diceDataSchema = diceOptionsSchema.extend({
  sourceMessageId: z.string().uuid().optional(),
  sourceAttemptId: z.string().uuid().optional(),
  afterMessageIndex: z.number().int().min(-1).optional(),
  targetNickname: z.string().optional(),
  deadline: z.number(),
  rolls: z.array(z.number().int()).optional(),
  total: z.number().int().optional(),
  resolvedAt: z.number().optional(),
  resolvedBy: z.enum(["click", "timeout", "immediate"]).optional(),
});
