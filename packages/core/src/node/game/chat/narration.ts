import { randomUUID } from "node:crypto";

import { sameDocumentIdentity } from "@jointarp/module/document-path";
import { emptyFlowRun, preludeNarration } from "@jointarp/module/flow";

import { messageSchema, type ChatMessage } from "../../../shared/game";
import { narrationLines, startNarrationBeats } from "../../../shared/narration";
import { readCharacters } from "../../sessions/character-db";
import { readLaunchConfig, readLaunchRoom, saveLaunchRoom } from "../../sessions/launch-db";
import { launchStart } from "../../sessions/launch-store";
import { isSessionActive } from "../../sessions/session-store";
import { chatField } from "../../storage/session-database";
import type { ChatLaunchCards } from "./launch-cards";
import type { ChatContext, RoomState, ScriptLine } from "./types";
type NarrationContext = Pick<ChatContext, "store" | "activity" | "isClosing"> & {
  readonly liveNarration: boolean;
  narrationGap(text: string): number;
  cards: ChatLaunchCards;
};

const streamChunkSize = 8;
const streamChunkIntervalMs = 60;

/** 预写旁白的发送、节奏与恢复。 */
export class ChatNarration {
  constructor(private readonly context: NarrationContext) {}
  private rooms = new WeakMap<
    RoomState,
    { run?: Promise<void>; timer?: ReturnType<typeof setTimeout>; cancelWait?: () => void }
  >();
  private playback(state: RoomState) {
    let playback = this.rooms.get(state);
    if (!playback) this.rooms.set(state, (playback = {}));
    return playback;
  }
  async closeRoom(state: RoomState) {
    const playback = this.playback(state);
    playback.cancelWait?.();
    await playback.run?.catch(() => undefined);
  }

  completeOpening(state: RoomState, roomId: string) {
    const room = readLaunchRoom(state.db);
    if (room.opening === "complete") return;
    const start = launchStart(state.db);
    if (start.opening.mode === "scripted") {
      if (this.context.liveNarration) return;
      for (const line of this.openingLines(state))
        this.postScripted(state, roomId, line.postKey, line.text, line.speakerPath, line.nickname);
      room.opening = "complete";
      room.revision++;
      saveLaunchRoom(state.db, room);
      return;
    }
    room.opening = "complete";
    room.revision++;
    saveLaunchRoom(state.db, room);
  }

  postScripted(
    state: RoomState,
    roomId: string,
    postKey: string,
    text: string,
    speakerPath?: string,
    nickname = "主持人",
    status: "running" | "complete" = "complete",
  ): Extract<ChatMessage, { kind: "scripted" }> {
    const existing = this.scriptedPost(state, postKey);
    if (existing) return existing;
    const message = this.context.store.save(state, {
      id: randomUUID(),
      sequence: 0,
      revision: 0,
      roomId,
      senderId: speakerPath ?? "narrator",
      nickname,
      createdAt: new Date().toISOString(),
      status,
      kind: "scripted",
      text,
      speakerPath,
      postKey,
    });
    if (message.kind !== "scripted") throw new Error("预写消息类型无效");
    return message;
  }

  openingLines(state: RoomState): ScriptLine[] {
    const room = readLaunchRoom(state.db);
    const start = launchStart(state.db);
    if (start.opening.mode !== "scripted") return [];
    const characters = readCharacters(state.db);
    const first = characters.find((c) => c.id === room.characterId);
    const override = first?.sourcePath
      ? Object.entries(start.opening.overrides).find(([path]) =>
          sameDocumentIdentity(path, first.sourcePath!),
        )?.[1]
      : undefined;
    const beats = override ?? start.opening.beats;
    const lines: ScriptLine[] = narrationLines(
      beats.map((beat, index) => ({
        id: `opening:${start.id}:${index}`,
        title: "",
        body: beat.text,
      })),
    ).map((line) => ({ ...line, postKey: line.id }));
    return lines;
  }

  private introLines(state: RoomState): ScriptLine[] {
    const config = readLaunchConfig(state.db);
    if (!config) return [];
    const lines: ScriptLine[] = [];
    if (config.preludeFlow?.steps.length)
      for (const line of narrationLines(preludeNarration(config.preludeFlow, emptyFlowRun())))
        lines.push({ ...line, postKey: `prelude:${line.id}` });
    if (config.gameStarts.length > 1)
      for (const line of narrationLines(startNarrationBeats(config.gameStarts)))
        lines.push({ ...line, postKey: `start:${line.id}` });
    return lines;
  }

  private scriptedPost(state: RoomState, postKey: string) {
    const row = state.db.get(
      state.db.query
        .selectFrom("chat_messages")
        .select("data")
        .where(chatField("postKey"), "=", postKey),
    );
    if (!row) return;
    const message = messageSchema.parse(JSON.parse(row.data));
    if (message.kind !== "scripted") throw new Error("预写消息类型无效");
    return message;
  }

  /** 使用同一条消息的正常版本更新输出正文，完成后才允许推进下一步。 */
  private async streamScripted(state: RoomState, roomId: string, line: ScriptLine) {
    const characters = Array.from(line.text);
    let message = this.scriptedPost(state, line.postKey);
    if (!message) {
      const text = characters.slice(0, streamChunkSize).join("");
      message = this.context.store.transaction(state, () =>
        this.postScripted(
          state,
          roomId,
          line.postKey,
          text,
          line.speakerPath,
          line.nickname,
          text === line.text ? "complete" : "running",
        ),
      );
    }
    if (message.status === "complete") return true;
    if (!line.text.startsWith(message.text)) throw new Error("预写消息与冻结开场内容不一致");
    let length = Array.from(message.text).length;
    while (length < characters.length) {
      await this.wait(state, streamChunkIntervalMs);
      if (state.closed || this.context.isClosing()) return false;
      length = Math.min(characters.length, length + streamChunkSize);
      const next: Extract<ChatMessage, { kind: "scripted" }> = {
        ...message,
        text: characters.slice(0, length).join(""),
        status: length === characters.length ? "complete" : "running",
      };
      const saved = this.context.store.transaction(state, () =>
        this.context.store.save(state, next),
      );
      if (saved.kind !== "scripted") throw new Error("预写消息类型无效");
      message = saved;
    }
    return true;
  }

  private wait(state: RoomState, ms: number) {
    return new Promise<void>((resolve) => {
      if (state.closed || this.context.isClosing() || ms <= 0) {
        resolve();
        return;
      }
      const playback = this.playback(state);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (playback.timer) clearTimeout(playback.timer);
        playback.timer = undefined;
        playback.cancelWait = undefined;
        resolve();
      };
      playback.cancelWait = finish;
      playback.timer = setTimeout(finish, ms);
    });
  }

  private playIntroSync(state: RoomState, roomId: string) {
    this.context.store.transaction(state, () => {
      const room = readLaunchRoom(state.db);
      if (room.intro !== "telling") return;
      const lines = this.introLines(state);
      for (const line of lines.slice(room.introIndex ?? 0))
        this.postScripted(state, roomId, line.postKey, line.text, line.speakerPath, line.nickname);
      this.context.cards.finishIntro(state, roomId);
      const done = readLaunchRoom(state.db);
      done.intro = "told";
      done.introIndex = lines.length;
      done.revision++;
      saveLaunchRoom(state.db, done);
    });
  }

  private async playIntroLive(state: RoomState, roomId: string) {
    const lines = this.introLines(state);
    for (;;) {
      if (state.closed || this.context.isClosing()) return;
      const room = readLaunchRoom(state.db);
      if (room.intro !== "telling") return;
      const index = room.introIndex ?? 0;
      if (index >= lines.length) break;
      if (index > 0) {
        await this.wait(state, this.context.narrationGap(lines[index - 1].text));
        if (state.closed || this.context.isClosing()) return;
      }
      if (!(await this.streamScripted(state, roomId, lines[index]))) return;
      let advanced = false;
      this.context.store.transaction(state, () => {
        const current = readLaunchRoom(state.db);
        if (current.intro !== "telling" || (current.introIndex ?? 0) !== index) return;
        current.introIndex = index + 1;
        current.revision++;
        saveLaunchRoom(state.db, current);
        advanced = true;
      });
      if (!advanced) return;
    }
    if (state.closed || this.context.isClosing()) return;
    const last = lines.at(-1);
    if (last) {
      await this.wait(state, this.context.narrationGap(last.text));
      if (state.closed || this.context.isClosing()) return;
    }
    this.context.store.transaction(state, () => {
      if (readLaunchRoom(state.db).intro !== "telling") return;
      this.context.cards.finishIntro(state, roomId);
      const done = readLaunchRoom(state.db);
      done.intro = "told";
      done.introIndex = lines.length;
      done.revision++;
      saveLaunchRoom(state.db, done);
    });
  }

  private playIntro(state: RoomState, roomId: string) {
    if (!this.context.liveNarration) {
      this.playIntroSync(state, roomId);
      return;
    }
    const run = this.playIntroLive(state, roomId);
    this.trackNarration(state, run);
  }

  private async playOpening(state: RoomState, roomId: string) {
    const pending = this.openingLines(state).filter(
      (line) => this.scriptedPost(state, line.postKey)?.status !== "complete",
    );
    if (!pending.length) {
      this.context.store.transaction(state, () => this.markOpeningComplete(state));
      return;
    }
    for (let index = 0; index < pending.length; index++) {
      const pause = index === 0 ? 900 : this.context.narrationGap(pending[index - 1].text);
      await this.wait(state, pause);
      if (state.closed || this.context.isClosing()) return;
      if (!(await this.streamScripted(state, roomId, pending[index]))) return;
    }
    await this.wait(state, this.context.narrationGap(pending.at(-1)!.text));
    if (state.closed || this.context.isClosing()) return;
    this.context.store.transaction(state, () => this.markOpeningComplete(state));
  }

  private markOpeningComplete(state: RoomState) {
    const room = readLaunchRoom(state.db);
    if (room.opening === "complete") return;
    room.opening = "complete";
    room.revision++;
    saveLaunchRoom(state.db, room);
  }

  private shouldPlayOpening(state: RoomState) {
    if (!this.context.liveNarration || this.context.activity.running(state)) return false;
    const room = readLaunchRoom(state.db);
    if (room.opening !== "running") return false;
    if (launchStart(state.db).opening.mode !== "scripted") return false;
    if (!room.openingMessageId) return true;
    const row = state.db.get(
      state.db.query
        .selectFrom("chat_messages")
        .select("data")
        .where("id", "=", room.openingMessageId),
    );
    if (!row) return false;
    return messageSchema.parse(JSON.parse(row.data)).status === "complete";
  }

  kickNarration(state: RoomState, roomId: string) {
    if (
      this.playback(state).run ||
      state.closed ||
      this.context.isClosing() ||
      !isSessionActive(state.db) ||
      !readLaunchConfig(state.db)
    )
      return;
    if (readLaunchRoom(state.db).intro === "telling") {
      this.playIntro(state, roomId);
      return;
    }
    if (!this.shouldPlayOpening(state)) return;
    this.trackNarration(state, this.playOpening(state, roomId));
  }

  private trackNarration(state: RoomState, run: Promise<void>) {
    const playback = this.playback(state);
    playback.run = run;
    void run.then(
      () => {
        if (playback.run === run) playback.run = undefined;
      },
      (error: unknown) => {
        if (playback.run === run) playback.run = undefined;
        if (!state.closed && !this.context.isClosing()) console.error(error);
      },
    );
  }
}
