import { z } from "zod";

import type { DocumentField } from "./document-type";
import { equipmentSlotsSchema, validateEquipmentSlots } from "./equipment-slots";
import { fieldTableSchema, validateFieldTable } from "./field-table";
import { referenceCollectionSchema, validateReferenceCollection } from "./reference-collection";

export const documentFieldViewSchema = z.discriminatedUnion("type", [
  referenceCollectionSchema,
  fieldTableSchema,
  equipmentSlotsSchema,
]);
export type DocumentFieldViewLayout = z.infer<typeof documentFieldViewSchema>;

export function validateDocumentFieldView(
  field: DocumentField,
  config: DocumentFieldViewLayout,
): void {
  if (config.type === "EquipmentSlots") validateEquipmentSlots(field, config);
  else if (config.type === "FieldTable") validateFieldTable(field, config);
  else validateReferenceCollection(field, config);
}
