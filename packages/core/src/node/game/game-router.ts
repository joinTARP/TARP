import { implement } from "@orpc/server";

import { gameContract, type Player } from "../../shared/game";
import type { ChatService } from "./chat-service";
import { assertHost } from "./chat/steering";

export interface GameContext {
  player: Player;
  chat: ChatService;
  /** 由宿主认证适配层赋予，缺省视为普通玩家。 */
  isHost?: boolean;
}
const game = implement(gameContract).$context<GameContext>();
// 远端接入时只公开此 router，并在适配层验证身份和房间访问权限。
export const gameRouter = game.router({
  room: {
    acknowledge: game.room.acknowledge.handler(({ context, input }) =>
      context.chat.acknowledgeRoom(input, context.player),
    ),
    subscribe: game.room.subscribe.handler(({ context, input, signal }) =>
      context.chat.subscribeRoom(input, context.player, signal),
    ),
  },
  launch: {
    get: game.launch.get.handler(({ context, input }) =>
      context.chat.launchState(input.roomId, context.player),
    ),
    advance: game.launch.advance.handler(({ context, input }) =>
      context.chat.advanceLaunch(input, context.player),
    ),
    confirmReady: game.launch.confirmReady.handler(async ({ context, input }) => {
      await context.chat.confirmReady(input.roomId, context.player, input.messageId);
    }),
    chooseStart: game.launch.chooseStart.handler(async ({ context, input }) => {
      await context.chat.chooseStart(input.roomId, context.player, input.messageId, input.startId);
    }),
    open: game.launch.open.handler(({ context, input }) =>
      context.chat.openLaunch(input.roomId, context.player),
    ),
  },
  dice: {
    roll: game.dice.roll.handler(({ context, input }) =>
      context.chat.rollDice(input, context.player),
    ),
  },
  chat: {
    mentionTargets: game.chat.mentionTargets.handler(({ context, input }) =>
      context.chat.mentionTargets(input.roomId, context.player),
    ),
    setMentionReplyLimit: game.chat.setMentionReplyLimit.handler(({ context, input }) => {
      assertHost(context.isHost === true);
      return context.chat.setMentionReplyLimit(input.roomId, input.limit);
    }),
    get: game.chat.get.handler(({ context, input }) => context.chat.get(input)),
    send: game.chat.send.handler(({ context, input }) => context.chat.send(input, context.player)),
    convertToChat: game.chat.convertToChat.handler(({ context, input }) =>
      context.chat.convertToChat(input, context.player),
    ),
    setSubmissionMode: game.chat.setSubmissionMode.handler(({ context, input }) => {
      assertHost(context.isHost === true);
      return context.chat.setSubmissionMode(input.roomId, input.mode);
    }),
    continue: game.chat.continue.handler(({ context, input }) => {
      assertHost(context.isHost === true);
      return context.chat.continue(input, context.player);
    }),
    resolveInput: game.chat.resolveInput.handler(({ context, input }) => {
      assertHost(context.isHost === true);
      return context.chat.resolveInput(input, context.player);
    }),
    history: game.chat.history.handler(({ context, input }) =>
      context.chat.history(input, context.player, context.isHost === true),
    ),
  },
  steering: {
    get: game.steering.get.handler(async ({ context, input }) => ({
      snapshot: await context.chat.steering.get(input.roomId),
      isHost: context.isHost === true,
    })),
    enqueue: game.steering.enqueue.handler(({ context, input }) =>
      context.chat.steering.enqueue(input, context.player),
    ),
    remove: game.steering.remove.handler(({ context, input }) =>
      context.chat.steering.remove(
        input.roomId,
        input.entryId,
        context.player,
        context.isHost === true,
      ),
    ),
    setEnabled: game.steering.setEnabled.handler(({ context, input }) =>
      context.chat.steering.setEnabled(input.roomId, input.enabled, context.isHost === true),
    ),
    submit: game.steering.submit.handler(({ context, input }) =>
      context.chat.steering.submit(input, context.player, context.isHost === true),
    ),
  },
  agent: {
    cancel: game.agent.cancel.handler(({ context, input }) => {
      assertHost(context.isHost === true);
      return context.chat.cancel(input.roomId, input.messageId);
    }),
  },
});
