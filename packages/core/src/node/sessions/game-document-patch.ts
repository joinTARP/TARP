import type { DocumentType } from "@jointarp/module/document-type";
import { instancePointerType, type InstanceResolver } from "@jointarp/module/instance-state";
import jsonPatch from "fast-json-patch";
import { z } from "zod";

import { assertMutablePointer, pointerParts } from "./game-pointers";

const { getValueByPointer, applyPatch } = jsonPatch;

const pointer = z.string().min(1).max(1000);
const value = z.json();
export const gameDocumentPatchSchema = z
  .array(
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("add"), path: pointer, value }),
      z.object({ op: z.literal("replace"), path: pointer, value }),
      z.object({ op: z.literal("remove"), path: pointer }),
      z.object({ op: z.literal("test"), path: pointer, value }),
    ]),
  )
  .min(1)
  .max(100);

export type GameDocumentPatch = z.infer<typeof gameDocumentPatchSchema>;

/** 在独立候选上执行受限 RFC 6902；列表插入和删除必须具有容器写权限。 */
export function applyGameDocumentPatch(
  type: DocumentType,
  content: Record<string, unknown>,
  patch: GameDocumentPatch,
  resolveInstance: InstanceResolver = () => null,
): Record<string, unknown> {
  let candidate = structuredClone(content);
  for (const operation of gameDocumentPatchSchema.parse(patch)) {
    pointerParts(operation.path);
    if (operation.op !== "test") {
      const parent = operation.path.slice(0, operation.path.lastIndexOf("/"));
      const structural =
        (operation.op === "add" || operation.op === "remove") &&
        parent !== "" &&
        Array.isArray(getValueByPointer(candidate, parent));
      assertMutablePointer(
        instancePointerType(type, candidate, operation.path, resolveInstance),
        structural ? parent : operation.path,
        false,
        operation.op === "remove" ? "remove" : "set",
      );
    }
    candidate = applyPatch(candidate, structuredClone([operation]), true, true, true).newDocument;
  }
  return candidate;
}
