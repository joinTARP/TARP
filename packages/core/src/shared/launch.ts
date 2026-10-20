import { characterDraftSchema, type Character } from "@jointarp/module/character";
import {
  creationAnswerSchema,
  creationProgressSchema,
  type WorkbenchView,
} from "@jointarp/module/creation-workbench";
import type { DocumentType } from "@jointarp/module/document-type";
import { flowAnswerSchema, flowRunSchema, type LaunchConfig } from "@jointarp/module/flow";
import type { ModuleDocument } from "@jointarp/module/module-document";
import { z } from "zod";

import type { ChatMessage } from "./game";
import { identityIdSchema } from "./identity";

export const launchProgressSchema = z.strictObject({
  workbench: creationProgressSchema.optional(),
  revision: z.number().int().nonnegative(),
  stage: z.enum(["prelude", "start", "character", "creation", "review", "opening"]),
  prelude: flowRunSchema,
  typeId: z.string().min(1).optional(),
  characterId: z.string().min(1).optional(),
  draft: characterDraftSchema.optional(),
  confirmed: z.boolean(),
});
export type LaunchProgress = z.infer<typeof launchProgressSchema>;
export const launchRoomSchema = z.strictObject({
  characterId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  startId: z.string().min(1).optional(),
  locked: z.boolean(),
  opening: z.enum(["pending", "running", "complete"]),
  openingMessageId: z.string().min(1).optional(),
  companionSetup: z
    .strictObject({
      playerId: z.string().min(1),
      stage: z.enum(["prompt", "select", "complete"]),
    })
    .optional(),
  intro: z.enum(["ready", "telling", "told"]),
  introIndex: z.number().int().nonnegative().optional(),
});
export type LaunchRoom = z.infer<typeof launchRoomSchema>;
export interface LaunchState {
  workbench?: WorkbenchView;
  draftView?: Character;
  openingMessage?: ChatMessage;
  config: LaunchConfig;
  room: LaunchRoom;
  progress: LaunchProgress;
  types: DocumentType[];
  creationTypeIds: string[];
  characters: Character[];
  references: ModuleDocument[];
}
export const launchActionSchema = z
  .object({
    roomId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    roomRevision: z.number().int().nonnegative(),
    action: z.enum([
      "next",
      "back",
      "start",
      "select",
      "create",
      "confirm",
      "chooseCompanions",
      "beginAdventure",
      "workbench",
    ]),
    answer: flowAnswerSchema.optional(),
    startId: z.string().optional(),
    characterId: identityIdSchema.optional(),
    typeId: z.string().optional(),
    operation: z
      .enum(["save", "generate", "navigate", "review", "swap", "randomReference"])
      .optional(),
    requestId: z.string().uuid().optional(),
    stageIndex: z.number().int().min(0).optional(),
    answers: z.record(z.string().max(500), creationAnswerSchema).optional(),
    swap: z.tuple([z.string(), z.string()]).nullable().optional(),
  })
  .strict();
export type LaunchAction = z.infer<typeof launchActionSchema>;
