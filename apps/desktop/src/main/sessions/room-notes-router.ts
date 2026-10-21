import { loadRoomNotes, saveRoomNotes } from "@jointarp/core/node/sessions/session-store";
import { playerSchema, type Player } from "@jointarp/core/shared/game";
import { os, ORPCError } from "@orpc/server";
import { z } from "zod";

interface RoomNotesContext {
  readonly sessionsRoot: string;
  readonly player: Player;
}

const procedure = os.$context<RoomNotesContext>();
const notesInput = z.object({ roomId: z.string().uuid(), playerId: playerSchema.shape.id });

function notesPlayer(context: RoomNotesContext, expectedPlayerId: string): string {
  // playerId 仅校验界面所属玩家，实际读写身份由主进程提供。
  if (context.player.id !== expectedPlayerId)
    throw new ORPCError("FORBIDDEN", { message: "玩家身份已变化，请重新打开笔记。" });
  return context.player.id;
}

export const roomNotesRouter = {
  get: procedure
    .input(notesInput)
    .handler(({ context, input }) =>
      loadRoomNotes(context.sessionsRoot, input.roomId, notesPlayer(context, input.playerId)),
    ),
  save: procedure
    .input(notesInput.extend({ content: z.string().max(200_000) }))
    .handler(({ context, input }) =>
      saveRoomNotes(
        context.sessionsRoot,
        input.roomId,
        notesPlayer(context, input.playerId),
        input.content,
      ),
    ),
};
