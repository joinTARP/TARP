import { z } from "zod";

import type { DocumentField } from "./document-type";

export const equipmentSlotsSchema = z
  .object({
    type: z.literal("EquipmentSlots"),
    slots: z
      .array(
        z
          .object({
            field: z.string().trim().min(1).max(100),
            label: z.string().trim().min(1).max(100),
            icon: z
              .enum(["head", "body", "feet", "hand", "shield", "accessory"])
              .default("accessory"),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();

export type EquipmentSlotsLayout = z.infer<typeof equipmentSlotsSchema>;

export function validateEquipmentSlots(field: DocumentField, config: EquipmentSlotsLayout): void {
  if (field.type !== "object") throw new Error("装备区必须绑定 object 字段");
  const keys = config.slots.map((slot) => slot.field);
  if (new Set(keys).size !== keys.length) throw new Error("装备部位字段不能重复");
  for (const key of keys) {
    const child = field.fields?.find((candidate) => candidate.key === key);
    if (!child || child.type !== "reference" || child.visibility !== "public")
      throw new Error(`装备部位 ${key} 必须指向公开的 reference 子字段`);
  }
}
