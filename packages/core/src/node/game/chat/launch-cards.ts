import { randomUUID } from "node:crypto";

import { finishIntroductionRun } from "@jointarp/module/flow";

import { messageSchema } from "../../../shared/game";
import type { Player } from "../../../shared/game";
import { markStateChanged } from "../../sessions/adventure-state";
import { readCharacters } from "../../sessions/character-db";
import { hasAvailableCompanion } from "../../sessions/companion-selection";
import {
  readLaunchConfig,
  allLaunchProgress,
  hasLaunchProgress,
  readLaunchProgress,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "../../sessions/launch-db";
import { launchDocuments } from "../../sessions/launch-store";
import { chatField } from "../../storage/session-database";
import { readCompanions } from "../companion";
import type { ChatContext, RoomState } from "./types";
/** 开局进度在聊天中的卡片投影；调用方负责事务边界。 */
export class ChatLaunchCards {
  constructor(private readonly context: Pick<ChatContext, "store">) {}

  private runningCards(state: RoomState) {
    return state.db
      .all(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField("kind"), "=", "card")
          .where(chatField("status"), "=", "running"),
      )
      .map((row) => messageSchema.parse(JSON.parse(String(row.data))))
      .filter((message) => message.kind === "card");
  }
  insertCharacterCard(state: RoomState, roomId: string, playerId: string) {
    if (
      this.runningCards(state).some(
        (message) => message.card.type === "character" && message.card.playerId === playerId,
      )
    )
      return;
    this.context.store.save(state, {
      id: randomUUID(),
      sequence: 0,
      revision: 0,
      roomId,
      senderId: "narrator",
      nickname: "主持人",
      createdAt: new Date().toISOString(),
      status: "running",
      kind: "card",
      card: {
        type: "character",
        playerId,
      },
    });
  }
  private settleCharacterCard(state: RoomState, playerId: string) {
    const card = this.runningCards(state).find(
      (message) => message.card.type === "character" && message.card.playerId === playerId,
    );
    if (!card || card.card.type !== "character") return;
    const character = readCharacters(state.db).find((item) => item.playerId === playerId);
    this.context.store.save(state, {
      ...card,
      status: "complete",
      card: {
        ...card.card,
        selectedId: character?.id,
        selectedLabel: character?.name,
      },
    });
  }
  materializeCompanionSetup(state: RoomState, roomId: string) {
    const room = readLaunchRoom(state.db);
    const setup = room.companionSetup;
    if (!setup || room.intro !== "told") return;
    const existing = this.runningCards(state).find((message) => message.card.type === "companions");
    if (setup.stage === "prompt" && !hasAvailableCompanion(state.db)) {
      setup.stage = "complete";
      room.revision++;
      saveLaunchRoom(state.db, room);
      markStateChanged(state.db);
    }
    if (setup.stage === "complete") {
      if (existing && existing.card.type === "companions") {
        const characters = readCharacters(state.db);
        this.context.store.save(state, {
          ...existing,
          status: "complete",
          card: {
            ...existing.card,
            stage: "complete",
            selected: readCompanions(state.db).map((companion) => ({
              id: companion.characterId,
              name:
                characters.find((character) => character.id === companion.characterId)?.name ??
                "队友",
            })),
          },
        });
      }
      return;
    }
    if (existing) {
      if (existing.card.type === "companions" && existing.card.stage !== setup.stage)
        this.context.store.save(state, {
          ...existing,
          card: { ...existing.card, stage: setup.stage },
        });
      return;
    }
    this.context.store.save(state, {
      id: randomUUID(),
      sequence: 0,
      revision: 0,
      roomId,
      senderId: "narrator",
      nickname: "主持人",
      createdAt: new Date().toISOString(),
      status: "running",
      kind: "card",
      card: { type: "companions", playerId: setup.playerId, stage: setup.stage },
    });
  }
  private launchPhase(state: RoomState): "ready" | "telling" | "told" {
    return readLaunchRoom(state.db).intro;
  }
  ensurePlayerRow(state: RoomState, playerId: string) {
    if (hasLaunchProgress(state.db, playerId)) return;
    const progress = readLaunchProgress(state.db, playerId);
    progress.revision++;
    saveLaunchProgress(state.db, playerId, progress);
  }
  private readyMessage(state: RoomState) {
    const row = state.db.get(
      state.db.query
        .selectFrom("chat_messages")
        .select("data")
        .where(chatField("kind"), "=", "card")
        .where(chatField("card.type"), "=", "ready")
        .orderBy("sequence", "asc")
        .limit(1),
    );
    if (!row) return;
    const message = messageSchema.parse(JSON.parse(row.data));
    if (message.kind !== "card") return;
    const card = message.card;
    if (card.type !== "ready") return;
    return { ...message, card };
  }
  private ensureReady(state: RoomState, roomId: string, player: Player) {
    this.ensurePlayerRow(state, player.id);
    const room = readLaunchRoom(state.db);
    const existing = this.readyMessage(state);
    if (!existing) {
      this.context.store.save(state, {
        id: randomUUID(),
        sequence: 0,
        revision: 0,
        roomId,
        senderId: "narrator",
        nickname: "主持人",
        createdAt: new Date().toISOString(),
        status: "running",
        kind: "card",
        card: {
          type: "ready",
          players: [{ id: player.id, nickname: player.nickname, confirmed: false }],
        },
      });
      room.intro = "ready";
      room.revision++;
      saveLaunchRoom(state.db, room);
      return;
    }
    if (existing.status !== "running") return;
    const known = existing.card.players.find((item) => item.id === player.id);
    if (known?.nickname === player.nickname) return;
    const players = known
      ? existing.card.players.map((item) =>
          item.id === player.id ? { ...item, nickname: player.nickname } : item,
        )
      : [...existing.card.players, { id: player.id, nickname: player.nickname, confirmed: false }];
    this.context.store.save(state, { ...existing, card: { ...existing.card, players } });
  }
  private ensureStartCard(state: RoomState, roomId: string) {
    const config = readLaunchConfig(state.db);
    if (!config) return;
    if (this.runningCards(state).some((message) => message.card.type === "start")) return;
    if (
      state.db.get(
        state.db.query
          .selectFrom("chat_messages")
          .select("id")
          .where(chatField("kind"), "=", "card")
          .where(chatField("card.type"), "=", "start"),
      )
    )
      return;
    this.context.store.save(state, {
      id: randomUUID(),
      sequence: 0,
      revision: 0,
      roomId,
      senderId: "narrator",
      nickname: "主持人",
      createdAt: new Date().toISOString(),
      status: "running",
      kind: "card",
      card: {
        type: "start",
        options: config.gameStarts.map((start) => ({
          id: start.id,
          label: start.name,
          detail: start.description,
        })),
      },
    });
  }
  finishIntro(state: RoomState, roomId: string) {
    const config = readLaunchConfig(state.db);
    if (!config) return;
    const documents = launchDocuments(state.db);
    let room = readLaunchRoom(state.db);
    if (!room.startId && config.gameStarts.length === 1) {
      room.startId = config.gameStarts[0].id;
      room.revision++;
      saveLaunchRoom(state.db, room);
      room = readLaunchRoom(state.db);
    }
    for (const [playerId, progress] of allLaunchProgress(state.db)) {
      let stage = progress.stage;
      if (stage === "prelude" || (stage === "start" && (room.startId || room.locked))) {
        if (config.preludeFlow?.steps.length) {
          progress.prelude = finishIntroductionRun(config.preludeFlow, progress.prelude, documents);
          progress.prelude = { ...progress.prelude, done: true };
        }
        stage = room.startId || room.locked ? "character" : "start";
        progress.stage = stage;
        progress.revision++;
        saveLaunchProgress(state.db, playerId, progress);
      }
      if (
        !progress.confirmed &&
        (stage === "character" || stage === "creation" || stage === "review")
      )
        this.insertCharacterCard(state, roomId, playerId);
    }
    if (!readLaunchRoom(state.db).startId && config.gameStarts.length > 1)
      this.ensureStartCard(state, roomId);
  }
  private materializeAfterIntro(state: RoomState, roomId: string, playerId: string) {
    const config = readLaunchConfig(state.db);
    if (!config) return;
    const room = readLaunchRoom(state.db);
    const documents = launchDocuments(state.db);
    let progress = readLaunchProgress(state.db, playerId);
    let changed = false;
    if (progress.stage === "prelude") {
      if (config.preludeFlow?.steps.length) {
        progress.prelude = finishIntroductionRun(config.preludeFlow, progress.prelude, documents);
        progress.prelude = { ...progress.prelude, done: true };
      }
      progress.stage = room.startId || room.locked ? "character" : "start";
      changed = true;
    }
    if ((room.startId || room.locked) && progress.stage === "start") {
      progress.stage = "character";
      changed = true;
    }
    if (changed) {
      progress.revision++;
      saveLaunchProgress(state.db, playerId, progress);
      progress = readLaunchProgress(state.db, playerId);
    }
    if (progress.confirmed) this.settleCharacterCard(state, playerId);
    else if (
      progress.stage === "character" ||
      progress.stage === "creation" ||
      progress.stage === "review"
    )
      this.insertCharacterCard(state, roomId, playerId);
  }
  materializeLaunch(state: RoomState, roomId: string, player: Player) {
    const config = readLaunchConfig(state.db);
    if (!config) return;
    const phase = this.launchPhase(state);
    if (phase === "ready") {
      this.ensureReady(state, roomId, player);
      return;
    }
    if (phase === "telling") {
      this.ensurePlayerRow(state, player.id);
      return;
    }
    if (phase === "told") {
      this.materializeAfterIntro(state, roomId, player.id);
      return;
    }
  }
}
