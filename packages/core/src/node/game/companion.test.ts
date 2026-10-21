import { test, onTestFinished, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import {
  advanceTimersByTime,
  advanceTimersByTimeAsync,
  useFakeTimers,
  useRealTimers,
  waitFor,
} from "@jointarp/module/testing/async";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createWorldStateDefinition } from "@jointarp/module/testing/world-state";

import { chatText, companionDisplayText } from "../../shared/agent-message";
import { companionRulingFromToolCall } from "../../shared/companion";
import { companionRoleplayInstructions } from "../../shared/companion-roleplay";
import type { ChatMessage } from "../../shared/game";
import type { MentionTarget } from "../../shared/mentions";
import { HOST_MENTION_ID } from "../../shared/mentions";
import { ContextSubscriptions } from "../agent/context-subscriptions";
import { createIdentityId } from "../identity";
import { updateAdventureState } from "../sessions/adventure-state";
import { readCharacters } from "../sessions/character-db";
import { readStateDocument, updateGameDocument } from "../sessions/game-state";
import {
  readLaunchProgress,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "../sessions/launch-db";
import { advanceLaunch, launchState } from "../sessions/launch-store";
import { patchRoomSettings } from "../sessions/room-settings";
import { createSession, openSessionDatabase } from "../sessions/session-store";
import { SessionDatabase } from "../storage/session-database";
import { ChatService, type Runtime } from "./chat-service";
import { ChatRuns } from "./chat/runs";
import { saveCompactionSettingsFile } from "./compaction-settings";
import { companionContext } from "./companion";

const player = { id: createIdentityId(), nickname: "玩家" };
const credentials = async (_roomId: string, selection?: { model: string } | null) => ({
  config: { provider: "test", model: selection?.model ?? "test" },
});
type Args = Parameters<Runtime["run"]>[0];
/** 测试中的 @标记代表候选选择；发送正文包含完整身份链接。 */
function selectedMessage(text: string, targets: readonly MentionTarget[], names = false) {
  const byToken = new Map<string, MentionTarget>();
  for (const target of targets) {
    byToken.set(target.id, target);
    if (names && target.characterName) byToken.set(target.characterName, target);
  }
  if (!byToken.size) return { text };
  const tokens = [...byToken.keys()]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return {
    text: text.replace(new RegExp(`@(${tokens.join("|")})`, "gu"), (_match, token: string) => {
      const target = byToken.get(token)!;
      return `[@${target.label}](#mention/${target.id})`;
    }),
  };
}
function emit(args: Args, text: string, chatFirst?: string, messageIndex = 0) {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  if (args.companion) {
    const metadata = { ...message, content: [] };
    args.onAgentEvent({ type: "message_start", messageIndex, message: metadata });
    if (text === "SILENT") {
      args.onAgentEvent({
        type: "message_end",
        messageIndex,
        message: { ...message, content: [], stopReason: "stop" },
      });
      return;
    }
    const submitting = text.startsWith("TURN\n");
    const selected = selectedMessage(text.slice(submitting ? 5 : 4), args.mentionTargets ?? []);
    const calls: ToolCall[] = [
      ...(chatFirst
        ? [
            {
              type: "toolCall" as const,
              id: randomUUID(),
              name: "companion_perform",
              arguments: selectedMessage(chatFirst, args.mentionTargets ?? []),
            },
          ]
        : []),
      submitting
        ? {
            type: "toolCall",
            id: randomUUID(),
            name: "companion_request_ruling",
            arguments: {
              intent: selected.text,
            },
          }
        : {
            type: "toolCall",
            id: randomUUID(),
            name: "companion_perform",
            arguments: selected,
          },
    ];
    calls.forEach((completed, contentIndex) => {
      const initial: ToolCall = {
        ...completed,
        arguments: completed.name === "companion_request_ruling" ? { intent: "" } : { text: "" },
      };
      args.onAgentEvent({
        type: "toolcall_start",
        messageIndex,
        contentIndex,
        toolCall: initial,
      });
      args.onAgentEvent({
        type: "toolcall_delta",
        messageIndex,
        contentIndex,
        toolCall: completed,
      });
      args.onAgentEvent({
        type: "toolcall_end",
        messageIndex,
        contentIndex,
        toolCall: completed,
      });
    });
    args.onAgentEvent({
      type: "message_end",
      messageIndex,
      message: { ...message, content: calls, stopReason: "toolUse" },
    });
    return;
  }
  args.onAgentEvent({
    type: "message_start",
    messageIndex,
    message,
  });
}
function emitFailed(args: Args, text: string) {
  emit(
    {
      ...args,
      onAgentEvent: (event) =>
        args.onAgentEvent(
          event.type === "message_end"
            ? { ...event, message: { ...event.message, stopReason: "error" } }
            : event,
        ),
    },
    text,
  );
}
async function fixture(
  run: Runtime["run"],
  withScenes = false,
  multiple = false,
  auth = credentials,
) {
  const root = await mkdtemp(join(tmpdir(), "tarp-companion-"));
  const module = join(root, "module");
  const sessions = join(root, "sessions");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(
    join(module, ".types", "人物.fields.json"),
    JSON.stringify({
      designation: "character",

      fields: {
        name: {
          type: "text",
          compute: "$self.source_name === '隐藏身份' ? '阿洛' : $self.source_name",
        },
        source_name: { type: "text", visibility: "gm" },
        hp: { type: "number", mutable: true },
        secret: { type: "text", visibility: "gm" },
        details: {
          type: "object",
          fields: { clue: { type: "text" }, hidden: { type: "text", visibility: "gm" } },
        },
      },
    }),
  );
  await writeFile(join(module, "人物/守卫.json"), JSON.stringify({ source_name: "守卫", hp: 12 }));
  if (multiple)
    await writeFile(
      join(module, "人物/艾琳.json"),
      JSON.stringify({ source_name: "艾琳", hp: 10 }),
    );
  await writeFile(
    join(module, "人物/阿洛.json"),
    JSON.stringify({
      source_name: "隐藏身份",
      hp: 8,
      secret: "幕后密谋",
      details: { clue: "公开线索", hidden: "隐藏机关" },
    }),
  );
  if (withScenes) {
    await writeFile(
      join(module, "人物/玩家.json"),
      JSON.stringify({ source_name: "玩家角色", hp: 10 }),
    );
    const world = createWorldStateDefinition("人物");
    await writeFile(join(module, ".types", "世界状态.fields.json"), JSON.stringify(world));
    await writeFile(join(module, ".types", "地点.fields.json"), "{}");
    await writeFile(join(module, "地点/门口.json"), JSON.stringify({ name: "门口" }));
    await writeFile(join(module, "地点/密室.json"), JSON.stringify({ name: "另一队才知道的密室" }));
    await writeFile(
      join(module, "世界状态/世界.json"),
      JSON.stringify({
        world_time: "傍晚",
        scenes: [
          {
            id: "door",
            location: "地点/门口",
            activity: "探索",
            members: ["人物/阿洛", "人物/玩家"],
            round: 0,
          },
          { id: "secret", location: "地点/密室", activity: "探索", members: [], round: 0 },
        ],
      }),
    );
  }
  if (!withScenes) {
    await writeFile(join(module, ".types", "地点.fields.json"), "{}");
    await writeFile(join(module, "地点/门口.json"), JSON.stringify({ name: "门口" }));
  }
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({
      name: "队友测试",
      description: "共享选角",
      gameStarts: [
        {
          id: "door",
          name: "门口",
          characterTypeIds: ["人物"],
          playablePaths: [
            "人物/阿洛",
            ...(multiple ? ["人物/艾琳"] : []),
            ...(withScenes ? ["人物/玩家"] : []),
          ],
          aiCompanions: {
            "人物/阿洛": "谨慎，主动提醒同伴",
            ...(multiple ? { "人物/艾琳": "大胆，留意队伍后方" } : {}),
          },
          allowCreate: false,
          opening: { mode: "scripted", beats: [{ text: "你们在门口。" }] },
        },
      ],
    }),
  );
  const room = await createSession(sessions, module, "队友测试");
  {
    const db = await openSessionDatabase(sessions, room.id);
    try {
      saveLaunchRoom(db, {
        ...readLaunchRoom(db),
        startId: "door",
        locked: true,
        opening: "complete",
      });
      saveLaunchProgress(db, player.id, {
        ...readLaunchProgress(db, player.id),
        confirmed: true,
        stage: "opening",
      });
    } finally {
      db.close();
    }
  }
  if (withScenes) {
    const db = await openSessionDatabase(sessions, room.id);
    try {
      updateAdventureState(db, (selection) => {
        selection.party.characters.find((item) => item.sourcePath === "人物/玩家.json")!.playerId =
          player.id;
      });
    } finally {
      db.close();
    }
  }
  const service = new ChatService(
    sessions,
    {
      run: async (args) => {
        if (args.inputBatch)
          args.onInputReceived?.({
            batchId: args.inputBatch.id,
            messageId: args.messageId,
            reference: { sessionId: randomUUID(), beforeEntryId: null, afterEntryId: "mock-input" },
          });
        return run(args);
      },
    },
    auth,
  );
  const settings = await service.companionSettings(room.id);
  const characterId = settings.characters.find((item) => item.name === "阿洛")!.id;
  let seatId: string | undefined;
  const send = async (text: string, chatOnly = false, clientMessageId = randomUUID()) => {
    const targets = (await service.mentionTargets(room.id, player)).filter(
      (target) => target.kind === "companion",
    );
    return service.send(
      { roomId: room.id, clientMessageId, ...selectedMessage(text, targets, true), chatOnly },
      player,
    );
  };
  const history = () => service.history({ roomId: room.id, limit: 100 });
  const idle = async () => {
    for (let i = 0; i < 500; i++) {
      const result = await history();
      if (!result.messages.some((message) => ["running", "queued"].includes(message.status))) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const settled = await history();
        if (!settled.messages.some((message) => ["running", "queued"].includes(message.status)))
          return settled.messages;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("队友调度未停止");
  };
  return {
    root,
    sessions,
    roomId: room.id,
    service,
    characterId,
    send,
    history,
    idle,
    enable: async () => {
      if (!seatId) {
        seatId = (await service.selectCompanion(room.id, characterId)).seats.at(-1)!.id;
      }
      const result = await service.saveCompanion(room.id, seatId, { characterId }, player);
      return { ...result, companion: result.seats.find((seat) => seat.id === seatId)!.companion };
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["auto", "manual"] as const)(
  "%s 模式点名主持只进行场外聊天，保留待提交行动且请求重试不重复回应",
  async (mode) => {
    const calls: Args[] = [];
    let companionId = "";
    const f = await fixture(async (args) => {
      calls.push(args);
      emit(args, `规则是这样的。点名格式示例：\`[@阿洛](#mention/${companionId})\``);
    });
    try {
      companionId = (await f.enable()).companion!.id;
      await f.service.setSubmissionMode(f.roomId, mode);
      const pending = mode === "manual" ? await f.send("我去开门") : undefined;
      const targets = await f.service.mentionTargets(f.roomId, player);
      assert.equal(targets.find((target) => target.id === HOST_MENTION_ID)?.kind, "host");
      const input = {
        roomId: f.roomId,
        clientMessageId: randomUUID(),
        text: `[@主持人](#mention/${HOST_MENTION_ID}) 开门前需要检定吗？`,
        chatOnly: false,
      };
      const sent = await f.service.send(input, player);
      assert(sent.kind === "player" && sent.chatOnly);
      assert.equal(sent.pendingAgent, undefined);
      const messages = await f.idle();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].hostChat, true);
      assert.equal(calls[0].companion, undefined);
      assert.equal(calls[0].inputBatch, undefined);
      assert.equal(calls[0].rollDice, undefined);
      assert.equal(calls[0].takeSteering, undefined);
      assert.match(calls[0].text, /开门前需要检定吗/);
      assert.doesNotMatch(calls[0].text, /我去开门/);
      const reply = messages.find((message) => message.replyToMessageId === sent.id);
      assert(reply?.kind === "assistant" && reply.chatOnly && !reply.companionId);
      assert.equal(reply.status, "complete");
      assert.deepEqual((await f.history()).pendingMessageIds, pending ? [pending.id] : []);
      assert.equal((await f.service.send(input, player)).id, sent.id);
      await f.idle();
      assert.equal(calls.length, 1);
    } finally {
      await f.close();
    }
  },
);

test.each(["auto", "manual"] as const)(
  "%s 模式主持场外回复的有效点名唤起队友并沿用连续响应上限",
  async (mode) => {
    const calls: Args[] = [];
    let companionId = "";
    const f = await fixture(async (args) => {
      calls.push(args);
      assert(calls.length <= 4, "主持场外聊天不能重置连续响应计数");
      emit(
        args,
        args.companion
          ? `SAY\n@${HOST_MENTION_ID} 还有什么需要澄清？`
          : `<message narrator>\n[@阿洛](#mention/${companionId})，请说明刚才的意思。\n</message>`,
      );
    });
    try {
      companionId = (await f.enable()).companion!.id;
      await f.service.setCompanionInitiative(f.roomId, companionId, {
        level: "reserved",
        prompt: "",
      });
      await f.service.setSubmissionMode(f.roomId, mode);
      await f.service.setMentionReplyLimit(f.roomId, 3);
      const pending = mode === "manual" ? await f.send("我去开门") : undefined;
      const input = {
        roomId: f.roomId,
        clientMessageId: randomUUID(),
        text: `[@主持人](#mention/${HOST_MENTION_ID}) 请重新点名阿洛澄清`,
        chatOnly: true,
      };
      const sent = await f.service.send(input, player);
      const messages = await f.idle();
      assert.deepEqual(
        calls.map((args) => [args.hostChat === true, args.companion?.id]),
        [
          [true, undefined],
          [false, companionId],
          [true, undefined],
        ],
      );
      assert.equal(calls[1]!.requireResponse, true);
      const prefix = "本轮玩家与控制角色（playerId 为点名身份）：";
      const roster = JSON.parse(
        calls[0]!.text
          .split("\n")
          .find((line) => line.startsWith(prefix))!
          .slice(prefix.length),
      ) as Record<string, unknown>[];
      assert.deepEqual(
        roster.map((entry) => entry.playerId).sort(),
        [player.id, companionId].sort(),
      );
      assert(roster.every((entry) => !("kind" in entry) && !("aiConfigured" in entry)));
      const replies = messages.filter((message) => message.kind === "assistant");
      assert.deepEqual(
        replies.map((reply) => reply.replyToMessageId),
        [sent.id, replies[0]!.id, replies[1]!.id, replies[2]!.id],
      );
      assert.deepEqual(replies[0]!.mentions, [{ id: companionId, label: "阿洛" }]);
      assert(replies[3]!.status === "cancelled" && replies[3]!.error?.includes("上限"));
      assert(replies.slice(0, 3).every((reply) => reply.kind === "assistant" && reply.chatOnly));
      assert.deepEqual((await f.history()).pendingMessageIds, pending ? [pending.id] : []);
      assert.equal((await f.service.send(input, player)).id, sent.id);
      await f.idle();
      assert.equal(calls.length, 3, "重试不重放已完成的点名链");
    } finally {
      await f.close();
    }
  },
);

test("主持聊天期间新的点名排队，停止后取消全部回应且旧请求不重新生成", async () => {
  const calls: Args[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const f = await fixture(async (args) => {
    calls.push(args);
    started();
    await new Promise<void>((resolve) =>
      args.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  try {
    const input = {
      roomId: f.roomId,
      clientMessageId: randomUUID(),
      text: `[@主持人](#mention/${HOST_MENTION_ID}) 解释一下规则`,
      chatOnly: true,
    };
    await f.service.send(input, player);
    await ready;
    const queued = {
      ...input,
      clientMessageId: randomUUID(),
      text: `${input.text}，再补充一个问题`,
    };
    const source = await f.service.send(queued, player);
    const activity = (await f.service.roomProjection(f.roomId, player)).sections.chatActivity;
    assert.equal(activity.running?.chatOnly, true);
    assert.equal(activity.queued?.chatOnly, true);
    assert.equal(calls.length, 1);
    await f.service.cancel(f.roomId, activity.queued!.messageId);
    const messages = await f.idle();
    assert(
      messages
        .filter((message) => message.kind === "assistant")
        .every((message) => message.status === "cancelled"),
    );
    assert.equal((await f.service.send(queued, player)).id, source.id);
    await f.idle();
    assert.equal(calls.length, 1);
  } finally {
    await f.close();
  }
});

test("结构化点名只聊天，模型明确玩家身份，历史标签不随改名变化", async () => {
  const calls: Args[] = [];
  const f = await fixture(
    async (args) => {
      calls.push(args);
      emit(args, `TURN\n@${player.id} 先别急，我们讨论一下。`);
    },
    true,
    false,
  );
  try {
    const { companion } = await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    const targets = await f.service.mentionTargets(f.roomId, player);
    assert(targets.every((target) => target.id !== player.id));
    const other = { id: randomUUID(), nickname: player.nickname };
    await f.service.send(
      { roomId: f.roomId, clientMessageId: randomUUID(), text: "我也在场", chatOnly: true },
      other,
    );
    const otherTargets = await f.service.mentionTargets(f.roomId, other);
    assert(otherTargets.every((target) => target.id !== other.id));
    const own = otherTargets.find((target) => target.id === player.id)!;
    assert.equal(own.kind, "player");
    assert(
      (await f.service.mentionTargets(f.roomId, player)).some((target) => target.id === other.id),
    );
    assert.equal(own.characterName, "玩家角色");
    assert(targets.every((target) => target.characterName !== "守卫"));
    assert.equal(targets.find((target) => target.kind === "companion")?.id, companion!.id);
    const db = await openSessionDatabase(f.sessions, f.roomId);
    try {
      const id = randomUUID();
      const result = db.sqlite
        .prepare("INSERT INTO chat_messages(id,data) VALUES(?,?)")
        .run(id, "{}");
      db.sqlite.prepare("UPDATE chat_messages SET data=? WHERE id=?").run(
        JSON.stringify({
          id,
          sequence: Number(result.lastInsertRowid),
          revision: 0,
          roomId: f.roomId,
          senderId: "agent",
          nickname: "守卫",
          createdAt: new Date().toISOString(),
          kind: "scripted",
          text: "我在门边守着。",
          speakerPath: "人物/守卫",
          status: "complete",
        }),
        id,
      );
    } finally {
      db.close();
    }
    const sent = await f.send("@阿洛 帮我开门", true);
    assert(sent.kind === "player" && sent.chatOnly);
    assert.equal(sent.pendingAgent, undefined);
    const messages = await f.idle();
    const reply = messages.find((message) => message.kind === "assistant")!;
    assert(reply.kind === "assistant" && reply.chatOnly);
    assert.equal(reply.pendingAgent, undefined);
    assert.equal(calls.length, 1);
    const input = JSON.parse(calls[0]!.text.split("\n")[0]!);
    assert.equal(
      input.participants.find((participant: { id: string }) => participant.id === player.id).kind,
      "player",
    );
    assert.equal(input.trigger.id, sent.id);
    assert.equal(input.trigger.text, sent.text);
    assert.deepEqual(input.trigger.mentions, sent.mentions);
    assert.equal(input.character.playerId, companion!.id);
    assert.equal(
      input.events.find((event: { speaker: string }) => event.speaker === "守卫").author.kind,
      "npc",
    );
    assert(
      input.participants.every(
        (participant: Record<string, unknown>) =>
          !participant.path && !participant.image && !participant.avatar,
      ),
    );
    assert(!calls[0]!.text.includes("幕后密谋"));
    const original = chatText(reply);
    assert(original.includes("@玩家角色（玩家）"));
    await f.service.mentionTargets(f.roomId, { ...player, nickname: "新昵称" });
    assert.equal(
      chatText((await f.history()).messages.find((message) => message.id === reply.id)!),
      original,
    );
    for (const text of [
      "@阿洛 手打名字",
      `@${companion!.id} 手打 ID`,
      `@${randomUUID()} 失效引用`,
    ]) {
      const ordinary = await f.service.send(
        { roomId: f.roomId, clientMessageId: randomUUID(), text: text, chatOnly: false },
        player,
      );
      assert.equal(ordinary.pendingAgent, true);
      assert(ordinary.kind === "player" && !ordinary.chatOnly);
    }
    const selfMention = await f.service.send(
      {
        roomId: f.roomId,
        clientMessageId: randomUUID(),
        text: `[@我](#mention/${player.id}) 我先检查门口`,
        chatOnly: false,
      },
      player,
    );
    assert(selfMention.kind === "player" && !selfMention.chatOnly);
    assert.equal(selfMention.pendingAgent, true);
    assert.equal(selfMention.mentions, undefined);
    const humanMention = await f.service.send(
      {
        roomId: f.roomId,
        clientMessageId: randomUUID(),
        text: `[@我](#mention/${player.id}) [@同名](#mention/${other.id}) 我们讨论一下`,
        chatOnly: false,
      },
      player,
    );
    assert(humanMention.kind === "player" && humanMention.chatOnly);
    assert.equal(humanMention.pendingAgent, undefined);
    assert.deepEqual(humanMention.mentions, [{ id: other.id, label: other.nickname }]);
    const invalidId = randomUUID();
    const fallback = await f.service.send(
      {
        roomId: f.roomId,
        clientMessageId: randomUUID(),
        text: `[@旧昵称](#mention/${invalidId}) 老朋友`,
        chatOnly: false,
      },
      player,
    );
    assert(
      fallback.kind === "player" &&
        !fallback.chatOnly &&
        chatText(fallback) === `[@旧昵称](#mention/${invalidId}) 老朋友`,
    );
    await assert.rejects(
      f.service.steering.enqueue(
        {
          roomId: f.roomId,
          clientRequestId: randomUUID(),
          text: `[@阿洛](#mention/${companion!.id}) 讨论`,
        },
        player,
      ),
      /属于聊天/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await f.close();
  }
});

test.each(["narrator", "npc"] as const)(
  "%s 身份链接优先唤起克制队友，其他队友照常判断且不重复唤起点名者",
  async (speaker) => {
    const calls: Args[] = [];
    let firstId = "",
      secondId = "";
    const f = await fixture(
      async (args) => {
        calls.push(args);
        if (!args.companion) {
          emit(
            args,
            `<message ${speaker === "npc" ? 'npc path="人物/守卫" name="守卫"' : "narrator"}>\n[@阿洛](#mention/${firstId})，你怎么看？[@阿洛](#mention/${firstId})，说说你的发现。\n</message>`,
          );
        } else emit(args, "SAY\n门外有脚印。");
      },
      false,
      true,
    );
    try {
      firstId = (await f.enable()).companion!.id;
      await f.service.setCompanionInitiative(f.roomId, firstId, { level: "reserved", prompt: "" });
      const elin = (await f.service.companionSettings(f.roomId)).characters.find(
        (c) => c.name === "艾琳",
      )!;
      secondId = (await f.service.selectCompanion(f.roomId, elin.id)).seats.at(-1)!.id;
      await f.service.saveCompanion(f.roomId, secondId, { characterId: elin.id }, player);
      await f.service.setMentionReplyLimit(f.roomId, 1);
      await f.send("检查门口");
      const messages = await f.idle();
      assert.deepEqual(
        calls.map((args) => args.companion?.id),
        [undefined, firstId, secondId],
      );
      assert.equal(calls[1].requireResponse, true);
      assert.equal(calls[2].requireResponse, false);
      const host = messages.find((m) => m.kind === "assistant" && !m.companionId)!;
      assert.deepEqual(host.mentions, [{ id: firstId, label: "阿洛" }]);
      const trigger = JSON.parse(calls[1].text.split("\n")[0]).trigger;
      assert.equal(trigger.id, host.id);
      assert.equal(trigger.authorKind, "host");
      assert.equal(trigger.text.includes("守卫："), speaker === "npc");
      const reply = messages.find((m) => m.kind === "assistant" && m.companionId === firstId)!;
      assert.equal(reply.replyToMessageId, host.id);
    } finally {
      await f.close();
    }
  },
);

test("主持多目标点名保存失败整批回滚，新一轮才重新发起回应", async () => {
  const calls: Args[] = [];
  let firstId = "",
    secondId = "";
  const f = await fixture(
    async (args) => {
      calls.push(args);
      emit(
        args,
        args.companion
          ? "SAY\n我在听。"
          : `<message narrator>\n[@阿洛](#mention/${firstId}) [@艾琳](#mention/${secondId})，你们怎么看？\n</message>`,
      );
    },
    false,
    true,
  );
  try {
    firstId = (await f.enable()).companion!.id;
    const elin = (await f.service.companionSettings(f.roomId)).characters.find(
      (c) => c.name === "艾琳",
    )!;
    secondId = (await f.service.selectCompanion(f.roomId, elin.id)).seats.at(-1)!.id;
    await f.service.saveCompanion(f.roomId, secondId, { characterId: elin.id }, player);
    const db = new SessionDatabase(join(f.sessions, f.roomId, "session.sqlite"));
    try {
      db.sqlite.exec(`CREATE TRIGGER fail_host_mention BEFORE UPDATE ON chat_messages
        WHEN json_extract(new.data, '$.status') = 'queued'
          AND json_extract(new.data, '$.companionId') = '${secondId}'
        BEGIN SELECT RAISE(FAIL, 'host mention failure'); END;`);
      const requestId = randomUUID();
      await f.send("先问问队友", false, requestId);
      const failed = await f.idle();
      assert.equal(calls.length, 1);
      assert.ok(!failed.some((m) => m.kind === "assistant" && m.companionId));
      const host = failed.find((m) => m.kind === "assistant")!;
      assert.equal(host.status, "failed");
      assert.equal(host.mentions, undefined);
      db.sqlite.exec("DROP TRIGGER fail_host_mention");
      await f.send("先问问队友", false, requestId);
      await f.idle();
      assert.equal(calls.length, 1);
      await f.send("再问一次");
      const completed = await f.idle();
      assert.deepEqual(
        calls.map((args) => args.companion?.id),
        [undefined, undefined, firstId, secondId],
      );
      const replies = completed.filter((m) => m.kind === "assistant" && m.companionId);
      assert.equal(replies.length, 2);
      assert.equal(replies[0].replyToMessageId, replies[1].replyToMessageId);
      assert.notEqual(replies[0].replyToMessageId, host.id);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("主持插话切换后点名仍关联原发言，不将目标串到后续消息", async () => {
  let id = "";
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture(async (args) => {
    if (args.companion) {
      emit(args, "SAY\n我来检查。");
      return;
    }
    emit(args, `<message npc path="人物/守卫">\n[@阿洛](#mention/${id})，检查门外。\n</message>`);
    enter();
    await barrier;
    const batch = args.takeSteering!()!;
    assert.ok(batch);
    args.onSteering!({
      batch,
      reference: { sessionId: randomUUID(), beforeEntryId: null, afterEntryId: "mock-steering" },
    });
    emit(args, "<message narrator>\n你仍留在门边。\n</message>");
  });
  try {
    id = (await f.enable()).companion!.id;
    await f.service.steering.setEnabled(f.roomId, true, true);
    await f.send("检查门口");
    await entered;
    await f.service.steering.enqueue(
      { roomId: f.roomId, clientRequestId: randomUUID(), text: "我先不出去" },
      player,
    );
    release();
    const messages = await f.idle();
    const hosts = messages.filter((m) => m.kind === "assistant" && !m.companionId);
    assert.equal(hosts.length, 2);
    assert.deepEqual(hosts[0].mentions, [{ id, label: "阿洛" }]);
    assert.equal(hosts[1].mentions, undefined);
    const replies = messages.filter((m) => m.kind === "assistant" && m.companionId);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].replyToMessageId, hosts[0].id);
  } finally {
    release();
    await f.close();
  }
});

test("主持与队友跨裁定继续点名共用上限，不因主持生成新消息重新计数", async () => {
  let id = "";
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(
      args,
      args.companion
        ? "TURN\n我检查门外。"
        : `<message narrator>\n[@阿洛](#mention/${id})，请继续调查。\n</message>`,
    );
  });
  try {
    id = (await f.enable()).companion!.id;
    await f.service.setMentionReplyLimit(f.roomId, 2);
    await f.send("看看周围");
    const messages = await f.idle();
    assert.deepEqual(
      calls.map((args) => args.companion?.id),
      [undefined, id, undefined, id, undefined],
    );
    assert.ok(messages.some((m) => m.status === "cancelled" && m.error?.includes("上限")));
  } finally {
    await f.close();
  }
});

test.each(["failed", "cancelled"] as const)("主持点名正文流出后 %s 不唤起队友", async (outcome) => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const calls: Args[] = [];
  let id = "";
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(args, `<message npc path="人物/守卫">\n[@阿洛](#mention/${id})，你怎么看？\n</message>`);
    entered();
    if (outcome === "failed") throw new Error("主持生成失败");
    await new Promise<void>((resolve) =>
      args.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  try {
    id = (await f.enable()).companion!.id;
    const source = await f.send("看看门口");
    await ready;
    if (outcome === "cancelled") {
      const running = (await f.history()).messages.find((m) => m.status === "running")!;
      await f.service.cancel(f.roomId, running.id);
    }
    const messages = await f.idle();
    assert.equal(calls.length, 1);
    assert.ok(
      messages.some(
        (m) => m.kind === "assistant" && m.status === outcome && chatText(m).includes("你怎么看"),
      ),
    );
    assert.ok(!messages.some((m) => m.status === "queued" || m.replyToMessageId === source.id));
  } finally {
    await f.close();
  }
});

test("AI 互相点名按总上限停止，行动工具里的合法点名仍是聊天且重复点名去重", async () => {
  const calls: Args[] = [];
  let firstId = "",
    secondId = "";
  const f = await fixture(
    async (args) => {
      calls.push(args);
      assert(args.companion);
      emit(args, `TURN\n@${args.companion.id === firstId ? secondId : firstId} 继续讨论。`);
    },
    false,
    true,
  );
  try {
    firstId = (await f.enable()).companion!.id;
    const settings = await f.service.companionSettings(f.roomId);
    const second = settings.characters.find((character) => character.name === "艾琳")!;
    secondId = (await f.service.selectCompanion(f.roomId, second.id)).seats.at(-1)!.id;
    await f.service.saveCompanion(f.roomId, secondId, { characterId: second.id }, player);
    await f.service.setMentionReplyLimit(f.roomId, 3);
    await f.send("@阿洛 @阿洛 开始讨论");
    const messages = await f.idle();
    assert.deepEqual(
      calls.map((args) => args.companion?.id),
      [firstId, secondId, firstId],
    );
    assert.equal(
      messages.filter((message) => message.status === "complete" && message.kind === "assistant")
        .length,
      3,
    );
    assert(
      messages.some((message) => message.status === "cancelled" && message.error?.includes("上限")),
    );
    assert.deepEqual((await f.history()).pendingMessageIds, []);
    await f.send(`@${secondId} 新的一轮`);
    await f.idle();
    assert.equal(calls.length, 6);
    await assert.rejects(f.service.setMentionReplyLimit(f.roomId, 0));
    await assert.rejects(f.service.setMentionReplyLimit(f.roomId, 33));
  } finally {
    await f.close();
  }
});

test("生成期间点名先保存后排队，真人新点名优先于 AI 自动接话", async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const calls: Args[] = [];
  let secondId = "";
  const f = await fixture(
    async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        started();
        await barrier;
        emitFailed(args, `SAY\n@${secondId} 失败草稿`);
        emit(args, `SAY\n@${secondId} 自动提问`, undefined, 1);
      } else emit(args, "SAY\n我来回答。");
    },
    false,
    true,
  );
  try {
    await f.enable();
    const second = (await f.service.companionSettings(f.roomId)).characters.find(
      (character) => character.name === "艾琳",
    )!;
    secondId = (await f.service.selectCompanion(f.roomId, second.id)).seats.at(-1)!.id;
    await f.service.saveCompanion(f.roomId, secondId, { characterId: second.id }, player);
    await f.send("@阿洛 先考虑一下");
    await ready;
    const sent = await f.send(`@${secondId} 真人优先`);
    assert.equal(sent.pendingAgent, undefined);
    assert((await f.history()).messages.some((message) => message.status === "queued"));
    assert.equal(calls.length, 1);
    release();
    await f.idle();
    assert.equal(calls.length, 3);
    assert(JSON.parse(calls[1]!.text.split("\n")[0]!).trigger.text.includes("真人优先"));
    assert.equal(
      JSON.parse(calls[2]!.text.split("\n")[0]!).trigger.text,
      `[@艾琳](#mention/${secondId}) 自动提问`,
    );
  } finally {
    release();
    await f.close();
  }
});

test("分页隐藏运行与排队消息后仍可停止，旧点名重试不恢复取消的回应", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let attempts = 0;
  const f = await fixture(async (args) => {
    attempts++;
    if (attempts === 1) {
      started();
      await new Promise<void>((resolve) =>
        args.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    } else emit(args, `SAY\n@${args.companion!.id} 我已回复，不会唤起自己。`);
  });
  try {
    await f.enable();
    await f.send("@阿洛 第一条");
    await ready;
    const requestId = randomUUID();
    const source = await f.send("@阿洛 第二条", true, requestId);
    const queued = (await f.history()).messages.find((message) => message.status === "queued")!;
    for (let i = 0; i < 55; i++) await f.send(`闲聊 ${i}`, true);
    const page = await f.service.history({ roomId: f.roomId, limit: 50 });
    assert.ok(page.messages.every((message) => message.kind === "player"));
    const activity = (await f.service.roomProjection(f.roomId, player)).sections.chatActivity;
    assert.equal(
      activity.running?.companionId,
      (await f.service.companionSettings(f.roomId)).seats[0]!.id,
    );
    assert.equal(activity.queued?.messageId, queued.id);
    await f.service.cancel(f.roomId, activity.queued!.messageId);
    const messages = await f.idle();
    assert.deepEqual((await f.service.roomProjection(f.roomId, player)).sections.chatActivity, {
      running: null,
      queued: null,
    });
    assert.equal((await f.send("@阿洛 第二条", true, requestId)).id, source.id);
    assert.equal(attempts, 1);
    assert.equal(attempts, 1);
    assert(
      messages
        .filter((message) => message.kind === "assistant")
        .every((message) => message.status === "cancelled"),
    );
    assert.equal(messages.filter((message) => message.kind === "player").length, 57);
    await f.send("@阿洛 新点名");
    await f.idle();
    assert.equal(attempts, 2);
  } finally {
    await f.close();
  }
});

test("队友请求恢复与空回复补问不重复发言，主动沉默不显示正文或索要原因", async () => {
  function toolNames(context: TranscriptContext) {
    const names = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    }
    return [...names];
  }

  const {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
    InMemoryCredentialStore,
    getCurrentSystemPrompt,
  } = await import("@earendil-works/pi-ai");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { createPiRuntime } = await import("../agent/pi-runtime");
  const provider = fauxProvider({
    provider: `companion-retry-${randomUUID()}`,
    api: `companion-retry-${randomUUID()}`,
    models: [{ id: "companion", contextWindow: 100_000, maxTokens: 4096 }],
  });
  let runtime: Runtime | undefined;
  const f = await fixture(async (args) => {
    if (!args.companion) return emit(args, "场景暂时平静。");
    return runtime!.run({
      ...args,
      config: { provider: provider.provider.id, model: "companion" },
    });
  });
  onTestFinished(async () => {
    await f.service.close();
    await runtime?.closeRoom?.(join(f.sessions, f.roomId));
    await f.close();
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(f.root, "models-cache.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  runtime = createPiRuntime({ modelRuntime: async () => modelRuntime });
  patchRoomSettings(join(f.sessions, f.roomId), {
    companionRoleplayPrompt: "用角色台词交流，不写长篇内心独白。",
  });
  provider.setResponses([
    (context) => {
      const system = getCurrentSystemPrompt(context.messages);
      assert.ok(system.includes("用角色台词交流，不写长篇内心独白。"));
      assert.ok(!system.includes(companionRoleplayInstructions));
      assert.deepEqual(toolNames(context), [
        "companion_silent",
        "companion_perform",
        "companion_request_ruling",
        "companion_withdraw_action",
      ]);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fetch failed" });
    },
    fauxAssistantMessage(
      fauxToolCall("companion_request_ruling", {
        intent: `[@玩家角色（玩家）](#mention/${player.id}) 门边有痕迹，先别急。`,
      }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage(""),
  ]);
  await f.enable();
  await f.service.setSubmissionMode(f.roomId, "manual");
  useFakeTimers();
  try {
    await f.send("@阿洛 看看门边");
    await waitFor(async () => {
      const companion = (await f.history()).messages.find(
        (message) => message.kind === "assistant" && message.companionId,
      );
      assert(companion?.kind === "assistant");
      assert.equal(companion.agentMessages.at(-1)?.stopReason, "error");
      assert.equal(companion.status, "running");
    });
    await advanceTimersByTimeAsync(2000);
    await waitFor(async () => {
      assert.equal(
        (await f.history()).messages.find((message) => message.kind === "assistant")?.status,
        "complete",
      );
    });
    const companions = (await f.history()).messages.filter(
      (message) => message.kind === "assistant" && message.companionId,
    );
    assert.equal(provider.state.callCount, 3);
    assert.equal(companions.length, 1);
    const companion = companions[0]!;
    assert(companion.kind === "assistant");
    assert.equal(companion.error, undefined);
    assert.equal(
      companionDisplayText(companion).trim(),
      `[@玩家角色（玩家）](#mention/${player.id}) 门边有痕迹，先别急。`,
    );
    assert.equal(companion.chatOnly, true);
    assert.equal(companion.pendingAgent, undefined);
    assert.deepEqual(
      companion.mentions?.map(({ id }) => id),
      [player.id],
    );
    provider.setResponses([
      fauxAssistantMessage(""),
      fauxAssistantMessage(fauxToolCall("companion_perform", { text: "补问后回应。" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(""),
    ]);
    await f.send("@阿洛 再回应一次");
    await waitFor(async () =>
      assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
    );
    assert.equal(provider.state.callCount, 6);
    assert.equal(chatText((await f.history()).messages.at(-1)!).trim(), "补问后回应。");
    provider.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
    await f.send("@阿洛 不要保持沉默");
    await waitFor(async () => assert.equal((await f.history()).messages.at(-1)?.status, "failed"));
    assert.equal(provider.state.callCount, 8);
    const id = (await f.service.companionSettings(f.roomId)).seats[0].companion!.id;
    await f.service.setCompanionDocumentAccess(f.roomId, id, true);
    provider.setResponses([
      (context) => {
        assert.deepEqual(toolNames(context), [
          "companion_silent",
          "companion_perform",
          "companion_request_ruling",
          "companion_withdraw_action",
          "find",
          "read",
        ]);
        return fauxAssistantMessage(fauxToolCall("find", { query: "阿洛" }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        const result = context.messages.at(-1)!;
        assert.equal(result.role, "toolResult");
        assert(result.role === "toolResult");
        const content = result.content[0]!;
        assert(content.type === "text");
        const found = JSON.parse(content.text).documents;
        assert.equal(found.length, 1);
        return fauxAssistantMessage(fauxToolCall("read", { id: found[0].id }), {
          stopReason: "toolUse",
        });
      },
      (context) => {
        const result = context.messages.at(-1)!;
        assert(result.role === "toolResult");
        const content = result.content[0]!;
        assert(content.type === "text");
        assert.equal(JSON.parse(content.text).title, "阿洛");
        assert.doesNotMatch(content.text, /gmSecret|秘密|\.json/);
        return fauxAssistantMessage(
          fauxToolCall("companion_perform", { text: "查过角色资料，我来探路。" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(""),
    ]);
    await f.send("@阿洛 查一下资料");
    await waitFor(async () =>
      assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
    );
    assert.equal(provider.state.callCount, 12);
    const researched = (await f.history()).messages.at(-1)!;
    assert.equal(chatText(researched).trim(), "查过角色资料，我来探路。");
    assert.doesNotMatch(JSON.stringify(researched), /"name":"find"|"name":"read"|#document/);
    await f.service.setCompanionDocumentAccess(f.roomId, id, false);
    patchRoomSettings(join(f.sessions, f.roomId), { companionRoleplayPrompt: null });
    provider.setResponses([
      (context) => {
        const system = getCurrentSystemPrompt(context.messages);
        assert.ok(system.includes(companionRoleplayInstructions));
        assert.ok(!system.includes("用角色台词交流，不写长篇内心独白。"));
        assert.deepEqual(toolNames(context), [
          "companion_silent",
          "companion_perform",
          "companion_request_ruling",
          "companion_withdraw_action",
        ]);
        return fauxAssistantMessage(fauxToolCall("companion_perform", { text: "继续讨论。" }), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(""),
    ]);
    await f.send("@阿洛 继续讨论");
    await waitFor(async () =>
      assert.equal((await f.history()).messages.at(-1)?.status, "complete"),
    );
    assert.equal(provider.state.callCount, 14);

    // 自动参与必须明确选择沉默；空输出补问一次，正常工具结束不补问。
    await f.service.setSubmissionMode(f.roomId, "auto");
    const silent = () =>
      fauxAssistantMessage(fauxToolCall("companion_silent", {}), { stopReason: "toolUse" });
    provider.setResponses([silent()]);
    await f.send("先等等");
    await waitFor(async () => {
      const last = (await f.history()).messages.at(-1)!;
      assert(last.kind === "assistant" && last.companionId && last.status === "complete");
      assert.equal(last.internal, true);
      assert.equal(chatText(last), "");
      assert.doesNotMatch(JSON.stringify(last), /companion_silent|等待玩家决定/);
      const details = await f.service.details(f.roomId, last.id);
      assert(
        details.some((detail) => detail.text === "companion_silent" && detail.arguments === "{}"),
      );
    });
    assert.equal(provider.state.callCount, 15);

    provider.setResponses([
      fauxAssistantMessage(""),
      fauxAssistantMessage(fauxToolCall("companion_perform", { text: "我帮你照着脚下。" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(""),
    ]);
    await f.send("我准备继续走");
    await waitFor(async () => {
      const last = (await f.history()).messages.at(-1)!;
      assert(last.kind === "assistant" && last.companionId && last.status === "complete");
      assert.equal(chatText(last), "我帮你照着脚下。");
      assert.equal(last.internal, false);
      assert(
        (await f.service.details(f.roomId, last.id)).some(
          (detail) => detail.id === "companion_decision_retry",
        ),
      );
    });
    assert.equal(provider.state.callCount, 18);
    const recovered = (await f.history()).messages.at(-1)!;
    assert(recovered.kind === "assistant");
    assert(
      (await runtime!.history!.details(join(f.sessions, f.roomId), recovered)).some(
        (detail) => detail.id === "companion_decision_retry",
      ),
    );

    provider.setResponses([fauxAssistantMessage(""), silent()]);
    await f.send("再等一会");
    await waitFor(async () => {
      const last = (await f.history()).messages.at(-1)!;
      assert(last.kind === "assistant" && last.companionId && last.status === "complete");
      assert.equal(last.internal, true);
    });
    assert.equal(provider.state.callCount, 20);

    provider.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
    await f.send("继续观察");
    await waitFor(async () => {
      const last = (await f.history()).messages.at(-1)!;
      assert(last.kind === "assistant" && last.companionId && last.status === "complete");
      assert.equal(last.internal, true);
      assert.equal(last.error, undefined);
      assert.equal(chatText(last), "");
    });
    assert.equal(provider.state.callCount, 22);

    // 被点名不能通过沉默工具绕过回应要求。
    provider.setResponses([silent(), fauxAssistantMessage(""), fauxAssistantMessage("")]);
    await f.send("@阿洛 你怎么看？");
    await waitFor(async () => {
      const last = (await f.history()).messages.at(-1)!;
      assert(last.kind === "assistant" && last.companionId && last.status === "failed");
    });
    assert.equal(provider.state.callCount, 25);

    // 同轮先定向聊天再行动：工具不互斥，点名只属于聊天，行动成功即结束。
    await f.service.setSubmissionMode(f.roomId, "manual");
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("companion_perform", {
          text: `[@玩家](#mention/${player.id}) 你帮我照明。`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("companion_request_ruling", {
          intent: "我侧身进入门缝。",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    await f.send("@阿洛 进去看看");
    await waitFor(async () => {
      const messages = (await f.history()).messages;
      const action = messages.at(-1)!;
      assert(action.kind === "assistant" && action.status === "complete");
      assert.equal(action.pendingAction, "我侧身进入门缝。");
      assert.equal(action.chatOnly, false);
      assert.equal(action.mentions, undefined);
      assert.equal(chatText(action), "我侧身进入门缝。");
      const chat = messages.at(-2)!;
      assert(chat.kind === "assistant" && chat.status === "complete");
      assert.equal(chat.chatOnly, true);
      assert.equal(chat.pendingAgent, undefined);
      assert.equal(chatText(chat), `[@玩家](#mention/${player.id}) 你帮我照明。`);
      assert.deepEqual(
        chat.mentions?.map(({ id }) => id),
        [player.id],
      );
      assert.equal(action.runId, chat.runId);
      assert.notEqual(action.id, chat.id);
    });
    assert.equal(provider.state.callCount, 27);
  } finally {
    useRealTimers();
  }
});

test("队友订阅与主持隔离，只读取公开字段，撤销查阅权限后停止注入", async () => {
  const f = await fixture(async () => {});
  onTestFinished(() => f.close());
  const settings = await f.enable();
  const actorId = settings.companion!.id;
  const room = join(f.sessions, f.roomId);
  patchRoomSettings(room, { contextSubscriptionsEnabled: true });
  const companion = new ContextSubscriptions(room, new AbortController().signal, actorId);
  await assert.rejects(
    companion.execute({ action: "set", document: f.characterId, fields: ["/hp"] }),
    /没有文档查阅权限/,
  );
  await f.service.setCompanionDocumentAccess(f.roomId, actorId, true);
  await companion.execute({ action: "set", document: f.characterId, fields: ["/hp", "/details"] });
  assert.match(await companion.prompt(), /公开线索/);
  assert.doesNotMatch(await companion.prompt(), /隐藏机关|幕后密谋|隐藏身份|\.json/);
  const before = await companion.execute({ action: "list" });
  for (const field of ["/secret", "/details/hidden", "/_name", "/source_name"])
    await assert.rejects(
      companion.execute({ action: "set", document: f.characterId, fields: [field] }),
    );
  assert.deepEqual(await companion.execute({ action: "list" }), before);
  const host = new ContextSubscriptions(room, new AbortController().signal);
  assert.equal(await host.prompt(), "");
  await host.execute({ action: "set", document: "人物/阿洛", fields: ["/secret"] });
  assert.match(await host.prompt(), /幕后密谋/);
  const db = await openSessionDatabase(f.sessions, f.roomId);
  try {
    await updateGameDocument(db, join(room, "game"), {
      path: "人物/阿洛",
      changes: [{ op: "set", path: "/hp", value: 3 }],
    });
  } finally {
    db.close();
  }
  const restored = new ContextSubscriptions(room, new AbortController().signal, actorId);
  assert.match(await restored.prompt(), /"\/hp":3/);
  await f.service.setCompanionDocumentAccess(f.roomId, actorId, false);
  assert.equal(await restored.prompt(), "");
  await assert.rejects(restored.execute({ action: "list" }), /没有文档查阅权限/);
  assert.match(await host.prompt(), /幕后密谋/);
});

test("队友接收加入后的未点名聊天，但聊天不唤起 AI；不继承完整文档、主持上下文或加入前历史", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(args, args.companion ? "SAY\n门边有痕迹，先别急。" : "门边有一道新鲜刮痕。");
  });
  try {
    await f.send("加入前的秘密闲聊", true);
    await f.enable();
    await f.send("游戏外讨论", true);
    await f.send("我们先商量一下门口的分工", true);
    await f.idle();
    assert.equal(calls.length, 0);
    await f.send("看看房门");
    for (let i = 0; calls.length < 2 && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const messages = await f.idle();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].companion);
    assert.equal(calls[1].rollDice, undefined);
    assert.ok(!calls[1].text.includes("公开线索"));
    const context = JSON.parse(calls[1].text.split("\n")[0]);
    assert.equal(context.character.id, f.characterId);
    assert.equal(context.character.values, undefined);
    assert.deepEqual(
      context.events
        .filter((event: { chatOnly?: boolean }) => event.chatOnly)
        .map((event: { text: string; pendingAgent: boolean }) => [event.text, event.pendingAgent]),
      [
        ["游戏外讨论", false],
        ["我们先商量一下门口的分工", false],
      ],
    );
    assert.equal(
      context.events.find((event: { text: string }) => event.text === "看看房门").chatOnly,
      false,
    );
    assert.doesNotMatch(calls[0].text, /游戏外讨论|我们先商量一下门口的分工/);
    for (const secret of [
      "幕后密谋",
      "隐藏机关",
      "隐藏身份",
      "加入前的秘密闲聊",
      "当前权威状态",
      "game/",
    ])
      assert.ok(!calls[1].text.includes(secret), secret);
    const companion = messages.find(
      (message) => message.kind === "assistant" && message.companionId,
    );
    assert.equal(companion?.nickname, "阿洛");
    assert.equal(chatText(companion!), "门边有痕迹，先别急。");
    assert.ok(!JSON.stringify(messages).includes('\\"kind\\":\\"say\\"'));
  } finally {
    await f.close();
  }
});

test("队友行动只交给主持裁定一次，不形成 AI 自循环；重复发送不会再次触发", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    if (calls.length === 3) {
      const dice = await args.rollDice!({
        expression: "1d6",
        reason: "队友守门检定",
        targetPlayerId: calls[1].companion!.id,
      });
      assert.ok(dice.kind === "dice" && dice.status === "complete");
      assert.equal(dice.dice.targetPlayerId, undefined);
    }
    emit(args, args.companion ? "TURN\n我举盾守在门口，对同伴说：大家退后。" : "你们听见脚步声。");
  });
  try {
    await f.enable();
    const id = randomUUID();
    const first = await f.send("我们靠近房门", false, id);
    const repeated = await f.send("我们靠近房门", false, id);
    assert.equal(first.id, repeated.id);
    await f.idle();
    assert.equal(calls.length, 3);
    assert.ok(!calls[2].companion);
    assert.ok(calls[2].text.includes('<message character="阿洛"'));
    assert.ok(calls[2].text.includes(`playerId="${calls[1].companion!.id}"`));
    assert.ok(calls[2].text.includes("我举盾守在门口"));
    assert.equal(calls[2].text.match(/大家退后/g)?.length, 1);
    assert.ok(!calls[2].text.includes("和真人玩家提交的行动使用完全相同的规则"));
    assert.ok(!calls[2].text.includes('"recent"'));
  } finally {
    await f.close();
  }
});

test("队友主动撤回自己的指定行动，原文转为聊天并在后续上下文中更新", async () => {
  const calls: Args[] = [];
  let oldId = "";
  const f = await fixture(async (args) => {
    calls.push(args);
    assert.ok(args.companion);
    const context = JSON.parse(args.text.split("\n")[0]);
    if (calls.length === 1) return emit(args, "TURN\n我去推门。");
    if (calls.length === 2) {
      assert.equal(context.pendingAction.id, oldId);
      assert.equal(context.pendingAction.text, "我去推门。");
      await assert.rejects(args.withdrawAction!(context.trigger.id), /只能将自己的/);
      await args.withdrawAction!(oldId);
      return;
    }
    assert.equal(context.pendingAction, undefined);
    const old = context.events.find((event: { id: string }) => event.id === oldId);
    assert.equal(old.chatOnly, true);
    assert.equal(old.pendingAgent, false);
    emit(args, "SAY\n先一起商量。");
  });
  try {
    await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("@阿洛 看看门口");
    oldId = (await f.idle()).find((message) => message.pendingAgent)!.id;
    const source = await f.send("@阿洛 先别行动，我们再商量");
    const messages = await f.idle();
    const old = await f.service.get({ roomId: f.roomId, messageId: oldId });
    assert(old.kind === "assistant" && old.chatOnly && !old.pendingAgent && !old.pendingAction);
    assert.equal(chatText(old), "我去推门。");
    const withdrawal = messages.find((message) => message.replyToMessageId === source.id)!;
    assert(
      withdrawal.kind === "assistant" && withdrawal.internal && withdrawal.status === "complete",
    );
    assert.deepEqual((await f.history()).pendingMessageIds, []);
    await f.send("@阿洛 继续讨论");
    await f.idle();
    assert.equal(calls.length, 3);
  } finally {
    await f.close();
  }
});

test("手动提交只保留同一队友最新行动，纯聊天不替换行动", async () => {
  const calls: Args[] = [];
  let responseIndex = 0;
  const responses = [
    "TURN\n尝试打开第一道门",
    "SAY\n我觉得暂时先别急。",
    "TURN\n我停下手，问守卫：第二道门怎么开？",
  ];
  let hostSeen = false;
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion) {
      if (hostSeen) return emit(args, "SILENT");
      emit(args, responses[responseIndex++]);
    } else {
      hostSeen = true;
      emit(args, "主持完成裁定。");
    }
  });
  try {
    await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("@阿洛 看看第一道门");
    let messages = await f.idle();
    assert.equal(calls.filter((args) => !args.companion).length, 0);
    assert.equal(messages.filter((message) => message.pendingAgent).length, 1);
    await f.send("@阿洛 你怎么看");
    messages = await f.idle();
    const firstAction = messages.find(
      (message) => message.kind === "assistant" && chatText(message) === "尝试打开第一道门",
    )!;
    const chat = messages.find(
      (message) => message.kind === "assistant" && chatText(message) === "我觉得暂时先别急。",
    )!;
    assert.equal(firstAction.pendingAgent, true);
    assert.equal(chat.pendingAgent, undefined);
    assert.equal(chat.kind === "assistant" && chat.pendingAction, undefined);
    assert.equal((await f.history()).pendingMessageIds.length, 1);
    await f.send("@阿洛 改问第二道门");
    messages = await f.idle();
    const actions = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.equal(actions.length, 3);
    assert.equal(actions[0].pendingAgent, undefined);
    assert.equal(actions[0].chatOnly, true);
    assert.equal(actions[0].pendingAction, undefined);
    assert.equal(actions[1].pendingAgent, undefined);
    assert.equal(actions[1].chatOnly, true);
    assert.equal(actions[2].pendingAgent, true);
    assert.equal(actions[2].pendingAction, "我停下手，问守卫：第二道门怎么开？");
    assert.equal((await f.history()).pendingMessageIds.length, 1);
    const request = { roomId: f.roomId, clientRequestId: randomUUID() };
    const host = await f.service.continue(request, player);
    assert.equal((await f.service.continue(request, player)).id, host.id);
    await f.idle();
    const hostCalls = calls.filter((args) => !args.companion);
    assert.equal(hostCalls.length, 1);
    assert.ok(!hostCalls[0].text.includes("看看第一道门"));
    assert.ok(!hostCalls[0].text.includes("改问第二道门"));
    assert.equal(hostCalls[0].text.match(/<message character="阿洛"/g)?.length, 1);
    assert.ok(hostCalls[0].text.includes("我停下手，问守卫：第二道门怎么开？"));
    assert.ok(!hostCalls[0].text.includes("尝试打开第一道门"));
    assert.ok(!hostCalls[0].text.includes("我觉得暂时先别急。"));
    assert.equal((await f.history()).pendingMessageIds.length, 0);
  } finally {
    await f.close();
  }
});

test("一名队友更新待提交行动时不覆盖其他队友", async () => {
  const calls: Args[] = [];
  const counts = new Map<string, number>();
  let firstId = "";
  let hostSeen = false;
  const f = await fixture(
    async (args) => {
      calls.push(args);
      if (!args.companion) {
        hostSeen = true;
        return emit(args, "主持回应。");
      }
      if (hostSeen) return emit(args, "SILENT");
      const id = args.companion.id;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      emit(args, `TURN\n${id === firstId ? "阿洛" : "艾琳"}第${count}条发言`);
    },
    false,
    true,
  );
  try {
    firstId = (await f.enable()).companion!.id;
    const settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1];
    await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("@阿洛 第一次");
    await f.idle();
    await f.send("@艾琳 你的看法");
    await f.idle();
    await f.send("@阿洛 再说一次");
    const messages = await f.idle();
    const pending = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" &&
        Boolean(message.companionId) &&
        message.pendingAgent === true,
    );
    assert.equal(pending.length, 2);
    assert.equal(
      pending.find((message) => message.companionId === firstId)?.pendingAction,
      "阿洛第2条发言",
    );
    assert.equal(
      pending.find((message) => message.companionId === second.id)?.pendingAction,
      "艾琳第1条发言",
    );
    assert.ok(
      messages.some(
        (message) =>
          message.kind === "assistant" &&
          message.companionId === firstId &&
          message.chatOnly === true,
      ),
    );
    assert.equal((await f.history()).pendingMessageIds.length, 2);
    await f.service.continue({ roomId: f.roomId, clientRequestId: randomUUID() }, player);
    await f.idle();
    const hostCalls = calls.filter((args) => !args.companion);
    assert.equal(hostCalls.length, 1);
    assert.ok(!hostCalls[0].text.includes("阿洛第1条发言"));
    assert.ok(
      hostCalls[0].text.indexOf("艾琳第1条发言") < hostCalls[0].text.indexOf("阿洛第2条发言"),
    );
    assert.deepEqual((await f.history()).pendingMessageIds, []);
  } finally {
    await f.close();
  }
});

test("队友先聊天再行动时拆成两条消息，仅新行动替换待提交行动", async () => {
  const calls: Args[] = [];
  let responseIndex = 0;
  let hostSeen = false;
  const f = await fixture(async (args) => {
    calls.push(args);
    if (!args.companion) {
      hostSeen = true;
      return emit(args, "主持回应。");
    }
    if (hostSeen) return emit(args, "SILENT");
    if (responseIndex++ === 0) return emit(args, "TURN\n我检查门锁。");
    emit(args, "TURN\n我推开窗户。", "先休息一会儿吧。");
  });
  try {
    await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("@阿洛 看看门锁");
    await f.idle();
    await f.send("@阿洛 再看看窗户");
    const messages = await f.idle();
    const replies = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.equal(replies.length, 3);
    assert.equal(replies[0].pendingAgent, undefined);
    assert.equal(replies[0].chatOnly, true);
    assert.equal(replies[1].status, "complete");
    assert.equal(replies[1].chatOnly, true);
    assert.equal(companionDisplayText(replies[1]), "先休息一会儿吧。");
    assert.equal(replies[1].pendingAgent, undefined);
    assert.equal(replies[2].status, "complete");
    assert.equal(replies[2].chatOnly, false);
    assert.equal(companionDisplayText(replies[2]), "我推开窗户。");
    assert.equal(replies[2].pendingAction, "我推开窗户。");
    assert.equal(replies[2].pendingAgent, true);
    assert.equal((await f.history()).pendingMessageIds.length, 1);
    await f.service.continue({ roomId: f.roomId, clientRequestId: randomUUID() }, player);
    await f.idle();
    const hostCalls = calls.filter((args) => !args.companion);
    assert.equal(hostCalls.length, 1);
    assert.ok(!hostCalls[0].text.includes("我检查门锁。"));
    assert.ok(hostCalls[0].text.includes("我推开窗户。"));
    assert.ok(!hostCalls[0].text.includes("先休息一会儿吧。"));
  } finally {
    await f.close();
  }
});

test("手动提交按对话顺序把队友向 NPC 说的话交给主持", async () => {
  const calls: Args[] = [];
  let addressed = false;
  const speech = "我放下筷子，问石泽：报道涉及什么、哪里拿不准？如果需要核实线索，我可以帮忙。";
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion) {
      if (addressed) return emit(args, "SILENT");
      addressed = true;
      return emit(args, `TURN\n${speech}`);
    }
    emit(args, "石泽说明了报道中的疑点。");
  });
  try {
    await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("可以啊");
    await f.send("@阿洛 你有什么想法");
    const messages = await f.idle();
    const teammate = messages.find(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.ok(teammate);
    assert.equal(teammate.pendingAction, speech);
    assert.equal(teammate.pendingAgent, true);
    assert.equal(companionDisplayText(teammate), speech);
    assert.equal(chatText(teammate), speech);
    assert.equal((await f.history()).pendingMessageIds.length, 2);
    await f.service.continue({ roomId: f.roomId, clientRequestId: randomUUID() }, player);
    await f.idle();
    const hostCalls = calls.filter((args) => !args.companion);
    assert.equal(hostCalls.length, 1);
    assert.ok(hostCalls[0].text.indexOf("可以啊") < hostCalls[0].text.indexOf(speech));
    assert.ok(!hostCalls[0].text.includes("你有什么想法"));
    assert.equal(hostCalls[0].text.split(speech).length - 1, 1);
    assert.deepEqual((await f.history()).pendingMessageIds, []);
  } finally {
    await f.close();
  }
});

test("自动提交时队友向 NPC 提问会触发主持回应一次", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(args, args.companion ? "TURN\n守卫，门后有什么动静？" : "守卫说门后有脚步声。");
  });
  try {
    await f.enable();
    await f.send("@阿洛 问问守卫");
    await f.idle();
    assert.equal(calls.filter((args) => args.companion).length, 1);
    const hostCalls = calls.filter((args) => !args.companion);
    assert.equal(hostCalls.length, 1);
    assert.ok(hostCalls[0].text.includes("守卫，门后有什么动静？"));
    assert.deepEqual((await f.history()).pendingMessageIds, []);
  } finally {
    await f.close();
  }
});

test("队友重试后沉默不公开失败草稿；被点名后沉默明确失败", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion && !args.requireResponse) {
      emitFailed(args, "SAY\n这段草稿未确认。");
      emit(args, "SILENT", undefined, 1);
    } else emit(args, args.companion ? "SILENT" : "场景暂时平静。");
  });
  try {
    await f.enable();
    await f.send("看看周围");
    const messages = await f.idle();
    const quiet = messages.find((message) => message.kind === "assistant" && message.companionId);
    assert.ok(quiet?.kind === "assistant" && quiet.internal);
    assert.equal(chatText(quiet!), "");
    await f.send("@阿洛 你有什么想法？");
    const mentioned = (await f.idle()).filter(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.equal(calls.length, 3);
    assert.ok(calls[2].companion);
    assert.equal(mentioned.at(-1)?.status, "failed");
    assert.equal(chatText(mentioned.at(-1)!), "");
  } finally {
    await f.close();
  }
});

test("直接点名队友时立即公开思考状态", async () => {
  let notifyEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (args) => {
    if (args.companion) {
      notifyEntered();
      await waiting;
      emit(args, "SAY\n我在听。");
    } else emit(args, "主持回应。");
  });
  try {
    await f.enable();
    await f.send("@阿洛 你怎么看？");
    await entered;
    const thinking = (await f.history()).messages.find(
      (message) =>
        message.kind === "assistant" &&
        message.companionId &&
        ["running", "queued"].includes(message.status),
    );
    assert.ok(thinking?.kind === "assistant");
    assert.equal(thinking.internal, undefined);
    release();
    const messages = await f.idle();
    assert.ok(messages.some((message) => chatText(message) === "我在听。"));
  } finally {
    release();
    await f.close();
  }
});

test("队友工具参数在调用完成前作为正文持续可见", async () => {
  let notifyDraft!: () => void;
  let release!: () => void;
  const drafted = new Promise<void>((resolve) => {
    notifyDraft = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (args) => {
    if (!args.companion) return emit(args, "主持回应。");
    const message = {
      role: "assistant" as const,
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending" as const,
      timestamp: Date.now(),
    };
    const id = randomUUID();
    const toolCall = (text: string): ToolCall => ({
      type: "toolCall",
      id,
      name: "companion_perform",
      arguments: { text: text },
    });
    args.onAgentEvent({ type: "message_start", messageIndex: 0, message });
    args.onAgentEvent({
      type: "toolcall_start",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: toolCall(""),
    });
    args.onAgentEvent({
      type: "toolcall_delta",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: toolCall("我在"),
    });
    notifyDraft();
    await waiting;
    const completed = toolCall("我在，跟紧我。");
    args.onAgentEvent({
      type: "toolcall_delta",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: completed,
    });
    args.onAgentEvent({
      type: "toolcall_end",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: completed,
    });
    args.onAgentEvent({
      type: "message_end",
      messageIndex: 0,
      message: { ...message, content: [completed], stopReason: "toolUse" },
    });
  });
  try {
    await f.enable();
    useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.send("@阿洛 跟上来");
    await drafted;
    advanceTimersByTime(100);
    const running = (await f.history()).messages.find(
      (message) =>
        message.kind === "assistant" &&
        message.companionId &&
        ["running", "queued"].includes(message.status),
    );
    assert.ok(running);
    assert.equal(chatText(running), "我在");
    useRealTimers();
    release();
    const completed = await f.idle();
    assert.ok(completed.some((message) => chatText(message) === "我在，跟紧我。"));
  } finally {
    useRealTimers();
    release();
    await f.close();
  }
});

test("队友可直接提交完整发言，intent 在完成前流式可见", async () => {
  let notifyDraft!: () => void;
  let release!: () => void;
  const drafted = new Promise<void>((resolve) => {
    notifyDraft = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    if (!args.companion) return emit(args, "主持完成裁定。");
    const message = {
      role: "assistant" as const,
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending" as const,
      timestamp: Date.now(),
    };
    const id = randomUUID();
    const toolCall = (intent: string): ToolCall => ({
      type: "toolCall",
      id,
      name: "companion_request_ruling",
      arguments: { intent: intent },
    });
    args.onAgentEvent({ type: "message_start", messageIndex: 0, message });
    args.onAgentEvent({
      type: "toolcall_start",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: toolCall(""),
    });
    args.onAgentEvent({
      type: "toolcall_delta",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: toolCall("推开石门"),
    });
    notifyDraft();
    await waiting;
    const completed = toolCall("用力推开石门");
    args.onAgentEvent({
      type: "toolcall_end",
      messageIndex: 0,
      contentIndex: 0,
      toolCall: completed,
    });
    args.onAgentEvent({
      type: "message_end",
      messageIndex: 0,
      message: { ...message, content: [completed], stopReason: "toolUse" },
    });
  });
  try {
    await f.enable();
    useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.send("试试把门推开");
    await drafted;
    advanceTimersByTime(100);
    const running = (await f.history()).messages.find(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.ok(running);
    assert.equal(running.internal, false);
    assert.equal(companionDisplayText(running), "推开石门");
    useRealTimers();
    release();
    const completed = await f.idle();
    const reply = completed.find(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.equal(companionDisplayText(reply!), "用力推开石门");
    assert.ok(calls.at(-1)?.text.includes("用力推开石门"));
  } finally {
    useRealTimers();
    release();
    await f.close();
  }
});

test("多目标点名保存失败整条回滚，同请求重试后每名队友只回应一次", async () => {
  const calls: Args[] = [];
  const f = await fixture(
    async (args) => {
      calls.push(args);
      emit(args, "SAY\n我听到了。");
    },
    false,
    true,
  );
  try {
    await f.enable();
    const settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1];
    await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
    const before = await f.history();
    const requestId = randomUUID();
    const db = new SessionDatabase(join(f.sessions, f.roomId, "session.sqlite"));
    try {
      db.sqlite.exec(`CREATE TRIGGER fail_second_reply BEFORE UPDATE ON chat_messages
        WHEN json_extract(new.data, '$.status') = 'queued'
          AND json_extract(new.data, '$.companionId') = '${second.id}'
        BEGIN SELECT RAISE(FAIL, 'second reply failure'); END;`);
      await assert.rejects(
        f.send("@阿洛 @艾琳 你们怎么看？", true, requestId),
        /second reply failure/,
      );
      const rolledBack = await f.history();
      assert.deepEqual(rolledBack.messages, before.messages);
      assert.equal(rolledBack.cursor, before.cursor);
      assert.equal(calls.length, 0);
      assert.equal(db.all(db.query.selectFrom("chat_requests").selectAll()).length, 0);
      db.sqlite.exec("DROP TRIGGER fail_second_reply");
    } finally {
      db.close();
    }
    const source = await f.send("@阿洛 @艾琳 你们怎么看？", true, requestId);
    assert.equal((await f.send("@阿洛 @艾琳 你们怎么看？", true, requestId)).id, source.id);
    const messages = await f.idle();
    assert.equal(calls.length, 2);
    assert.ok(calls.every((args) => args.companion));
    assert.ok(calls.every((args) => args.requireResponse));
    const replies = messages.filter(
      (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
        message.kind === "assistant" && Boolean(message.companionId),
    );
    assert.equal(replies.length, 2);
    assert.ok(replies.every((message) => !message.internal));
    assert.ok(replies.every((message) => message.replyToMessageId === source.id));
    assert.deepEqual((await f.history()).pendingMessageIds, []);
  } finally {
    await f.close();
  }
});

test("AI 自动点名保存失败不留下回应，旧请求不重跑，新消息可重新发起", async () => {
  const calls: Args[] = [];
  let secondId = "";
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture(
    async (args) => {
      calls.push(args);
      if (calls.length === 1) await barrier;
      emit(
        args,
        args.companion?.id === secondId ? "SAY\n我听到了。" : `SAY\n@${secondId} 你怎么看？`,
      );
    },
    false,
    true,
  );
  try {
    await f.enable();
    const elin = (await f.service.companionSettings(f.roomId)).characters.find(
      (item) => item.name === "艾琳",
    )!;
    secondId = (await f.service.selectCompanion(f.roomId, elin.id)).seats.at(-1)!.id;
    await f.service.saveCompanion(f.roomId, secondId, { characterId: elin.id }, player);
    const requestId = randomUUID();
    const source = await f.send("@阿洛 开始讨论", true, requestId);
    const db = new SessionDatabase(join(f.sessions, f.roomId, "session.sqlite"));
    try {
      db.sqlite.exec(`CREATE TRIGGER fail_automatic_reply BEFORE UPDATE ON chat_messages
        WHEN json_extract(new.data, '$.status') = 'queued'
          AND json_extract(new.data, '$.companionId') = '${secondId}'
        BEGIN SELECT RAISE(FAIL, 'automatic reply failure'); END;`);
      release();
      const messages = await f.idle();
      const replies = messages.filter((message) => message.kind === "assistant");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.status, "failed");
      assert.equal(calls.length, 1);
      db.sqlite.exec("DROP TRIGGER fail_automatic_reply");
      assert.equal((await f.send("@阿洛 开始讨论", true, requestId)).id, source.id);
      assert.equal(calls.length, 1);
      await f.send("@阿洛 重新讨论", true);
      await f.idle();
      assert.equal(calls.length, 3);
    } finally {
      db.close();
    }
  } finally {
    release();
    await f.close();
  }
});

test("真人发送新消息会中断队友思考，中断后不会自动提交行动", async () => {
  let count = 0;
  let notifyEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve;
  });
  const f = await fixture(async (args) => {
    count++;
    if (args.companion && count === 2) {
      notifyEntered();
      await new Promise<void>((resolve) =>
        args.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      emit(args, "TURN\n不应该执行的行动");
    } else emit(args, args.companion ? "SILENT" : "主持回应。");
  });
  try {
    await f.enable();
    await f.send("向前走");
    await entered;
    const thinking = (await f.history()).messages.find(
      (message) =>
        message.kind === "assistant" &&
        message.companionId &&
        ["running", "queued"].includes(message.status),
    );
    assert.ok(thinking?.kind === "assistant" && thinking.internal);
    await f.send("等一下，我先停步");
    const messages = await f.idle();
    assert.equal(count, 4);
    assert.ok(
      messages.some(
        (message) =>
          message.kind === "assistant" && message.companionId && message.status === "cancelled",
      ),
    );
    assert.ok(!messages.some((message) => chatText(message).includes("不应该执行")));
  } finally {
    await f.close();
  }
});

test.each([
  { initial: "auto", mode: "auto" },
  { initial: "manual", mode: "manual" },
  { initial: "auto", mode: "manual" },
  { initial: "manual", mode: "auto" },
] as const)(
  "真人指令交接期间 $initial → $mode，先提交玩家消息再继续原点名队列",
  async ({ initial, mode }) => {
    let enter!: () => void, onAbort!: () => void, enterHost!: () => void;
    let releaseAbort!: () => void, releaseHost!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const aborted = new Promise<void>((resolve) => (onAbort = resolve));
    const hostEntered = new Promise<void>((resolve) => (enterHost = resolve));
    const abortBarrier = new Promise<void>((resolve) => (releaseAbort = resolve));
    const hostBarrier = new Promise<void>((resolve) => (releaseHost = resolve));
    const calls: Args[] = [];
    const f = await fixture(
      async (args) => {
        calls.push(args);
        if (calls.length === 1) {
          enter();
          await new Promise<void>((resolve) =>
            args.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          onAbort();
          await abortBarrier;
          emit(args, "TURN\n被中断的行动不应提交");
        } else if (!args.companion) {
          enterHost();
          emit(args, "主持处理玩家指令。");
          await hostBarrier;
        } else emit(args, "SAY\n我继续回应原来的点名。");
      },
      false,
      true,
    );
    onTestFinished(async () => {
      releaseAbort();
      releaseHost();
      await f.close();
    });
    const first = (await f.enable()).companion!;
    const settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1]!;
    await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
    await f.service.setSubmissionMode(f.roomId, initial);
    const source = await f.send("@阿洛 @艾琳 先讨论一下", true);
    await entered;
    const queued = (await f.history()).messages.find(
      (message) => message.status === "queued" && message.replyToMessageId === source.id,
    )!;
    assert.equal(queued.kind === "assistant" && queued.companionId, second.id);
    const requestId = randomUUID();
    const sending = f.send("等一下，我先检查门锁", false, requestId);
    await aborted;
    if (initial !== mode) await f.service.setSubmissionMode(f.roomId, mode);
    releaseAbort();
    const command = await sending;
    assert(command.kind === "player");
    assert.equal(command.chatOnly, false);
    assert.equal(command.pendingAgent, mode === "manual" ? true : undefined);
    assert.equal((await f.send("等一下，我先检查门锁", false, requestId)).id, command.id);
    if (mode === "auto") {
      await hostEntered;
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.companion, undefined);
      assert(calls[1]!.text.includes(command.text));
      assert.equal(
        (await f.service.get({ roomId: f.roomId, messageId: queued.id })).status,
        "queued",
      );
      releaseHost();
    }
    const messages = await f.idle();
    const interrupted = messages.find(
      (message) => message.kind === "assistant" && message.companionId === first.id,
    )!;
    assert.equal(interrupted.status, "cancelled");
    assert.equal(messages.find((message) => message.id === queued.id)?.status, "complete");
    assert(!messages.some((message) => chatText(message).includes("被中断的行动")));
    assert.equal(calls.filter((args) => !args.companion).length, mode === "auto" ? 1 : 0);
    assert.equal(calls[mode === "auto" ? 2 : 1]!.companion?.id, second.id);
    assert.equal(
      messages.filter((message) => message.kind === "player" && message.text === command.text)
        .length,
      1,
    );
    assert.deepEqual((await f.history()).pendingMessageIds, mode === "manual" ? [command.id] : []);
  },
);

test("真人接管队友时保存失败会释放交接，原点名继续且同请求仍可重试", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const calls: Args[] = [];
  const f = await fixture(
    async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        enter();
        await new Promise<void>((resolve) =>
          args.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      } else emit(args, args.companion ? "SAY\n我继续回应点名。" : "主持处理玩家指令。");
    },
    false,
    true,
  );
  onTestFinished(() => f.close());
  await f.enable();
  const settings = await f.service.companionSettings(f.roomId);
  const elin = settings.characters.find((item) => item.name === "艾琳")!;
  const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1]!;
  await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
  const source = await f.send("@阿洛 @艾琳 先讨论一下", true);
  await entered;
  const requestId = randomUUID();
  const db = new SessionDatabase(join(f.sessions, f.roomId, "session.sqlite"));
  try {
    db.sqlite.exec(`CREATE TRIGGER fail_player_takeover BEFORE UPDATE ON chat_messages
      WHEN json_extract(new.data, '$.text') = '等一下，我先检查门锁'
      BEGIN SELECT RAISE(FAIL, 'player takeover failure'); END;`);
    await assert.rejects(
      f.send("等一下，我先检查门锁", false, requestId),
      /player takeover failure/,
    );
    const messages = await f.idle();
    assert(
      !messages.some(
        (message) => message.kind === "player" && message.text === "等一下，我先检查门锁",
      ),
    );
    assert.equal(
      messages.find(
        (message) =>
          message.kind === "assistant" &&
          message.companionId === second.id &&
          message.replyToMessageId === source.id,
      )?.status,
      "complete",
    );
    assert.equal(calls.length, 2);
    assert(calls.every((args) => args.companion));
    db.sqlite.exec("DROP TRIGGER fail_player_takeover");
  } finally {
    db.close();
  }
  const saved = await f.send("等一下，我先检查门锁", false, requestId);
  await f.idle();
  assert.equal((await f.send("等一下，我先检查门锁", false, requestId)).id, saved.id);
  assert.equal(calls.filter((args) => !args.companion).length, 1);
});

test("真人接管等待队友停止时关闭冒险会释放交接，不保存新指令", async () => {
  let enter!: () => void, onAbort!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const aborted = new Promise<void>((resolve) => (onAbort = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture(
    async (args) => {
      enter();
      await new Promise<void>((resolve) =>
        args.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      onAbort();
      await barrier;
    },
    false,
    true,
  );
  onTestFinished(async () => {
    release();
    await f.close();
  });
  await f.enable();
  const settings = await f.service.companionSettings(f.roomId);
  const elin = settings.characters.find((item) => item.name === "艾琳")!;
  const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1]!;
  await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
  const source = await f.send("@阿洛 @艾琳 先讨论一下", true);
  await entered;
  const rejected = assert.rejects(f.send("等一下，我先检查门锁"), /冒险正在关闭/);
  await aborted;
  const closing = f.service.closeRoom(f.roomId);
  await assert.rejects(f.service.roomProjection(f.roomId, player), /冒险正在关闭/);
  release();
  await Promise.all([rejected, closing]);
  const messages = (await f.history()).messages;
  assert.deepEqual(
    messages.filter((message) => message.kind === "player").map((message) => message.id),
    [source.id],
  );
  assert(
    messages
      .filter((message) => message.kind === "assistant")
      .every((message) => message.status === "cancelled"),
  );
});

test("队友启动准备失败留下明确终态，房间重开后的旧请求不自动重跑", async () => {
  let modelReady = false;
  let calls = 0;
  const f = await fixture(
    async (args) => {
      calls++;
      emit(args, "SAY\n我在听。");
    },
    false,
    false,
    async (...args) => {
      if (!modelReady) throw new Error("private credential failure");
      return credentials(...args);
    },
  );
  try {
    await f.enable();
    const requestId = randomUUID();
    const source = await f.send("@阿洛 在吗", true, requestId);
    const failed = (await f.idle()).find((message) => message.kind === "assistant")!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error?.includes("无法启动队友响应"));
    assert.ok(!failed.error?.includes("private"));
    assert.equal(calls, 0);
    modelReady = true;
    await f.service.closeRoom(f.roomId);
    assert.equal((await f.send("@阿洛 在吗", true, requestId)).id, source.id);
    assert.equal(
      (await f.service.get({ roomId: f.roomId, messageId: failed.id })).status,
      "failed",
    );
    assert.equal(calls, 0);
    await f.send("@阿洛 重新回应", true);
    await f.idle();
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("队友失败不公开内部内容，下一条消息启动独立新回合", async () => {
  const calls: Args[] = [];
  let valid = false;
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion && !valid) {
      throw new Error("模型输出不合法");
    }
    emit(args, args.companion ? "SAY\n我在听。" : "主持回应。");
  });
  try {
    const settings = await f.enable();
    await f.send("@阿洛 在吗");
    let messages = await f.idle();
    const failed = messages.find((message) => message.kind === "assistant")!;
    assert.equal(failed.status, "failed");
    assert.equal(chatText(failed), "");
    valid = true;
    await f.send("@阿洛 再说说");
    messages = await f.idle();
    assert.equal(calls[1].companion?.id, settings.companion?.id);
    assert.equal(calls[1].companion?.personality, "谨慎，主动提醒同伴");
    assert.equal(chatText(messages.find((message) => message.id === failed.id)!), "");
    assert.ok(
      messages.some(
        (message) =>
          message.kind === "assistant" &&
          message.id !== failed.id &&
          chatText(message) === "我在听。",
      ),
    );
    await f.service.saveCompanion(f.roomId, settings.companion!.id, null, player);
    assert.equal((await f.service.companionSettings(f.roomId)).characters.length, 1);
  } finally {
    await f.close();
  }
});

test("保存的队友身份跨重开保持；不能接管真人角色", async () => {
  const f = await fixture(async () => {});
  let reopened: ChatService | undefined;
  try {
    const settings = await f.enable();
    await f.service.close();
    reopened = new ChatService(f.sessions, { run: async () => {} }, credentials);
    assert.deepEqual(
      (await reopened.companionSettings(f.roomId)).seats[0].companion,
      settings.companion,
    );
    await reopened.saveCompanion(f.roomId, settings.companion!.id, null, player);
    const db = await openSessionDatabase(f.sessions, f.roomId);
    try {
      updateAdventureState(db, (selection) => {
        selection.party.characters.find((item) => item.id === f.characterId)!.playerId = player.id;
      });
    } finally {
      db.close();
    }
    await assert.rejects(reopened.selectCompanion(f.roomId, f.characterId), /占用/);
    assert.equal((await reopened.companionSettings(f.roomId)).seats.length, 0);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("只把主持提交工具转换为完整角色发言", () => {
  assert.deepEqual(
    companionRulingFromToolCall({
      name: "companion_request_ruling",
      arguments: { intent: "拉起陆川" },
    }),
    { intent: "拉起陆川" },
  );
  assert.throws(() =>
    companionRulingFromToolCall({
      name: "companion_request_ruling",
      arguments: { intent: "" },
    }),
  );
  assert.equal(
    companionRulingFromToolCall({ name: "companion_perform", arguments: { text: "你好" } }),
    undefined,
  );
});

test("队友上下文不注入平台推断的场景，也不附带幕后状态", async () => {
  const f = await fixture(async () => {}, true);
  try {
    const settings = await f.enable();
    const db = await openSessionDatabase(f.sessions, f.roomId);
    try {
      const context = await companionContext(db, settings.companion!);
      assert.equal(JSON.parse(context).scene, undefined);
      assert.ok(!context.includes("另一队才知道"));
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test.each(["player", "host", "automatic"] as const)(
  "%s 模组分队不阻止公开交流，平台不标注发言场景",
  async (source) => {
    const calls: Args[] = [];
    let id = "";
    const f = await fixture(async (args) => {
      calls.push(args);
      emit(
        args,
        args.companion
          ? "SAY\n我在门口，只能先和你讨论。"
          : source === "automatic"
            ? "你检查了眼前的房门。"
            : `<message narrator>\n[@阿洛](#mention/${id})，门口情况如何？\n</message>`,
      );
    }, true);
    try {
      id = (await f.enable()).companion!.id;
      const db = await openSessionDatabase(f.sessions, f.roomId);
      try {
        const root = join(f.sessions, f.roomId, "game");
        const world = await readStateDocument(db, root, "世界状态/世界.json");
        const scenes = world.content.scenes as Array<{ id: string; members: string[] }>;
        scenes[0].members = ["人物/阿洛"];
        scenes[1].members = ["人物/玩家"];
        await updateGameDocument(db, root, {
          path: world.path,
          changes: [{ op: "set", path: "/scenes", value: scenes }],
        });
      } finally {
        db.close();
      }
      const discussion = await f.send("我们先商量一下怎么配合", true);
      await f.idle();
      assert.equal(calls.length, 0, "未点名的聊天不额外启动模型");
      await f.send(source === "player" ? "@阿洛 跟上来" : "询问门口的队友");
      const messages = await f.idle();
      const reply = messages.find(
        (message): message is Extract<ChatMessage, { kind: "assistant" }> =>
          message.kind === "assistant" && Boolean(message.companionId),
      );
      assert.equal(calls.length, source === "player" ? 1 : 2);
      const args = calls.find((args) => args.companion)!;
      const input = JSON.parse(args.text.split("\n")[0]!);
      assert.equal(input.scene, undefined);
      assert.ok(input.events.some((event: { id: string }) => event.id === discussion.id));
      assert.match(input.knowledgeGuidance, /玩家读到的其他场景描述不自动成为角色亲历/);
      assert.ok(!args.text.includes("另一队才知道的密室"));
      assert.equal(reply?.status, "complete");
      assert.equal(reply?.internal, false);
    } finally {
      await f.close();
    }
  },
);

test("主持修改模组位置后队友依据公开叙事响应，不注入固定场景", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    if (!args.companion) {
      const db = await openSessionDatabase(f.sessions, f.roomId);
      try {
        const root = join(args.roomDirectory, "game");
        const world = await readStateDocument(db, root, "世界状态/世界.json");
        const scenes = world.content.scenes as Array<{ id: string; members: string[] }>;
        scenes[1].members = scenes[0].members;
        scenes[0].members = [];
        await updateGameDocument(db, root, {
          path: world.path,
          changes: [{ op: "set", path: "/scenes", value: scenes }],
        });
      } finally {
        db.close();
      }
    }
    emit(args, args.companion ? "SAY\n这里的空气不太对劲。" : "你们走进了密室。");
  }, true);
  try {
    await f.enable();
    await f.send("我们一起进密室");
    const messages = await f.idle();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].companion);
    assert.ok(calls[1].text.includes("你们走进了密室"));
    assert.equal(JSON.parse(calls[1].text.split("\n")[0]!).scene, undefined);
    assert.ok(messages.some((message) => chatText(message).includes("这里的空气不太对劲")));
  } finally {
    await f.close();
  }
});

async function humanAction(
  f: Awaited<ReturnType<typeof fixture>>,
  playerId: string,
  action: "select" | "back" | "confirm",
  characterId?: string,
) {
  const state = (await launchState(f.sessions, f.roomId, playerId))!;
  return advanceLaunch(
    f.sessions,
    {
      roomId: f.roomId,
      revision: state.progress.revision,
      roomRevision: state.room.revision,
      action,
      characterId,
    },
    playerId,
  );
}

test("真人选中即占用，重开仍保留；取消后 AI 才能选，双方不能重复确认", async () => {
  const f = await fixture(async () => {});
  const human = randomUUID();
  try {
    await humanAction(f, human, "select", f.characterId);
    const settings = await f.service.companionSettings(f.roomId);
    assert.equal(settings.characters.find((item) => item.id === f.characterId)?.reservedBy, human);
    assert.equal(
      (await launchState(f.sessions, f.roomId, human))?.progress.characterId,
      f.characterId,
    );
    assert.ok(
      !(await launchState(f.sessions, f.roomId, randomUUID()))?.characters.some(
        (item) => item.id === f.characterId,
      ),
    );
    await assert.rejects(f.service.selectCompanion(f.roomId, f.characterId), /占用/);
    await humanAction(f, human, "back");
    const seat = (await f.service.selectCompanion(f.roomId, f.characterId)).seats[0];
    await assert.rejects(humanAction(f, human, "select", f.characterId), /不可选/);
    await f.service.saveCompanion(f.roomId, seat.id, { characterId: f.characterId }, player);
    await assert.rejects(humanAction(f, human, "select", f.characterId), /不可选/);
    await f.service.saveCompanion(f.roomId, seat.id, null, player);
    await humanAction(f, human, "select", f.characterId);
    await humanAction(f, human, "confirm");
    await assert.rejects(f.service.selectCompanion(f.roomId, f.characterId), /占用/);
  } finally {
    await f.close();
  }
});

test("AI 换选失败保留旧选择，取消添加释放且不能确认已取消的选择", async () => {
  const f = await fixture(async () => {}, false, true);
  try {
    const settings = await f.service.selectCompanion(f.roomId, f.characterId);
    const a = settings.seats[0];
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const human = randomUUID();
    await humanAction(f, human, "select", elin.id);
    await assert.rejects(f.service.selectCompanion(f.roomId, elin.id, a.id), /占用/);
    assert.equal(
      (await f.service.companionSettings(f.roomId)).seats[0].reservedCharacterId,
      f.characterId,
    );
    const db = await openSessionDatabase(f.sessions, f.roomId);
    const npc = readCharacters(db).find((item) => item.name === "守卫")!.id;
    db.close();
    await assert.rejects(
      f.service.saveCompanion(f.roomId, a.id, { characterId: npc }, player),
      /NPC/,
    );
    await f.service.saveCompanion(f.roomId, a.id, null, player);
    assert.equal((await f.service.companionSettings(f.roomId)).seats.length, 0);
    await assert.rejects(
      f.service.saveCompanion(f.roomId, a.id, { characterId: f.characterId }, player),
      /不存在/,
    );
    await humanAction(f, randomUUID(), "select", f.characterId);
  } finally {
    await f.close();
  }
});

test("两个真人同时选一张卡只有一人成功；换选会原子释放旧卡", async () => {
  const f = await fixture(async () => {}, false, true);
  try {
    const humans = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      humans.map((id) => humanAction(f, id, "select", f.characterId)),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const winner = humans[results.findIndex((result) => result.status === "fulfilled")];
    const loser = humans.find((id) => id !== winner)!;
    const elin = (await f.service.companionSettings(f.roomId)).characters.find(
      (item) => item.name === "艾琳",
    )!;
    await humanAction(f, winner, "select", elin.id);
    await humanAction(f, loser, "select", f.characterId);
    await humanAction(f, winner, "confirm");
    await humanAction(f, loser, "confirm");
  } finally {
    await f.close();
  }
});

test("多名队友每轮各回应一次，行动逐个交主持裁定；移除只影响对应席位", async () => {
  const calls: Args[] = [];
  const f = await fixture(
    async (args) => {
      calls.push(args);
      emit(args, args.companion ? "TURN\n我留意身后的动静。" : "主持裁定完成。");
    },
    false,
    true,
  );
  try {
    const first = (await f.enable()).companion!;
    let settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const second = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1];
    settings = await f.service.saveCompanion(f.roomId, second.id, { characterId: elin.id }, player);
    assert.equal(settings.seats.length, 2);
    await f.send("我们开始探索");
    await f.idle();
    assert.equal(calls.length, 5);
    assert.deepEqual(
      new Set(calls.filter((args) => args.companion).map((args) => args.companion!.id)),
      new Set([first.id, second.id]),
    );
    assert.ok(
      calls.find((args) => args.companion?.id === first.id)?.text.includes('"name":"阿洛"'),
    );
    assert.ok(
      calls.find((args) => args.companion?.id === second.id)?.text.includes('"name":"艾琳"'),
    );
    await f.service.saveCompanion(f.roomId, second.id, null, player);
    assert.equal((await f.service.companionSettings(f.roomId)).seats[0].companion?.id, first.id);
    await f.send("@阿洛 你看到了什么？");
    await f.idle();
    assert.equal(calls.length, 7);
    assert.equal(calls[5].companion?.id, first.id);
  } finally {
    await f.close();
  }
});

test("停止一名队友会停止本轮剩余队友，不在后台继续自动发言", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const calls: Args[] = [];
  const f = await fixture(
    async (args) => {
      calls.push(args);
      if (args.companion) {
        enter();
        await new Promise<void>((resolve) =>
          args.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      } else emit(args, "主持回应。");
    },
    false,
    true,
  );
  try {
    await f.enable();
    const settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const seat = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1];
    await f.service.saveCompanion(f.roomId, seat.id, { characterId: elin.id }, player);
    await f.send("看看前面");
    await entered;
    const active = (await f.history()).messages.find((item) => item.status === "running")!;
    await f.service.cancel(f.roomId, active.id);
    await f.idle();
    assert.equal(calls.length, 2);
  } finally {
    await f.close();
  }
});

test("选择时原子建席并占用，失败不留下席位；仅接受模组预设", async () => {
  const f = await fixture(async () => {}, true);
  try {
    let settings = await f.service.companionSettings(f.roomId);
    assert.equal(settings.seats.length, 0);
    const db = await openSessionDatabase(f.sessions, f.roomId);
    const npc = readCharacters(db).find((item) => item.name === "守卫")!.id;
    db.close();
    await assert.rejects(f.service.selectCompanion(f.roomId, npc), /NPC/);
    const unconfigured = settings.characters.find((item) => item.name === "玩家角色")!;
    await assert.rejects(f.service.selectCompanion(f.roomId, unconfigured.id), /预设/);
    assert.equal((await f.service.companionSettings(f.roomId)).seats.length, 0);
    settings = await f.service.selectCompanion(f.roomId, f.characterId);
    assert.equal(settings.seats.length, 1);
    const seat = settings.seats[0];
    assert.equal(seat.reservedCharacterId, f.characterId);
    assert.equal(
      settings.characters.find((item) => item.id === f.characterId)?.reservedBy,
      seat.id,
    );
    await assert.rejects(
      f.service.saveCompanion(
        f.roomId,
        seat.id,
        { characterId: f.characterId, personality: "客户端篡改" } as never,
        player,
      ),
    );
    settings = await f.service.saveCompanion(
      f.roomId,
      seat.id,
      { characterId: f.characterId },
      player,
    );
    assert.equal(settings.seats[0].companion?.personality, "谨慎，主动提醒同伴");
  } finally {
    await f.close();
  }
});

test("会话统计隔离主持与队友上下文，并汇总包括沉默队友在内的消耗", async () => {
  const f = await fixture(async (args) => {
    args.onContextWindow?.(args.companion ? 32000 : 128000);
    emit(
      {
        ...args,
        onAgentEvent(event) {
          if (event.type === "message_end" || event.type === "message_start") {
            const input = args.companion ? 100 : 1000;
            args.onAgentEvent({
              ...event,
              message: {
                ...event.message,
                usage: {
                  ...event.message.usage,
                  input,
                  cacheRead: 20,
                  totalTokens: input + 25,
                },
              },
            });
          } else args.onAgentEvent(event);
        },
      },
      args.companion ? "SILENT" : "门边有一道刮痕。",
    );
  });
  try {
    const empty = await f.service.metrics(f.roomId);
    assert.equal(empty.host.current.status, "idle");
    assert.equal(empty.totals.totalTokens, 0);
    const settings = await f.enable();
    const before = await f.service.metrics(f.roomId);
    assert.equal(before.companions[0]?.current.status, "idle");
    await f.send("看看房门");
    await f.idle();
    const metrics = await f.service.metrics(f.roomId);
    assert.equal(metrics.host.current.contextTokens, 1020);
    assert.equal(metrics.host.current.contextWindow, 128000);
    assert.equal(metrics.companions.length, 1);
    assert.equal(metrics.companions[0].id, settings.companion!.id);
    assert.equal(metrics.companions[0].name, "阿洛");
    assert.equal(metrics.companions[0].current.contextTokens, 120);
    assert.equal(metrics.companions[0].current.contextWindow, 32000);
    assert.equal(metrics.host.totals.attempts, 1);
    assert.equal(metrics.companions[0].totals.attempts, 1);
    assert.equal(metrics.totals.totalTokens, 1150);
    assert.equal(metrics.totals.attempts, 2);
    assert.equal(metrics.totals.completedAttempts, 2);
  } finally {
    await f.close();
  }
});

test("主持人与队友调用读取各自的压缩阈值，修改后下次调用生效", async () => {
  const seen: { role: string; threshold: number | null | undefined }[] = [];
  const f = await fixture(async (args) => {
    seen.push({
      role: args.companion ? "companion" : "host",
      threshold: args.compaction?.thresholdTokens,
    });
    emit(args, args.companion ? "SILENT" : "门边有一道刮痕。");
  });
  try {
    await f.enable();
    const directory = join(f.sessions, f.roomId);
    saveCompactionSettingsFile(directory, "host", { thresholdTokens: 64000 });
    saveCompactionSettingsFile(directory, "companion", { thresholdTokens: 8000 });
    await f.send("看看房门");
    await f.idle();
    assert.deepEqual(seen, [
      { role: "host", threshold: 64000 },
      { role: "companion", threshold: 8000 },
    ]);
    saveCompactionSettingsFile(directory, "host", { thresholdTokens: 32000 });
    await f.send("再看看");
    await f.idle();
    assert.deepEqual(seen.slice(2), [
      { role: "host", threshold: 32000 },
      { role: "companion", threshold: 8000 },
    ]);
  } finally {
    await f.close();
  }
});

test("互动主动性保存在对应队友上，从下一次发言起生效", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(args, args.companion ? "SAY\n我跟上。" : "主持回应。");
  });
  try {
    const settings = await f.enable();
    const id = settings.companion!.id;
    await assert.rejects(
      () => f.service.setCompanionInitiative(f.roomId, id, { level: "custom", prompt: "   " }),
      /请填写自定义提示词/,
    );
    await f.service.setCompanionInitiative(f.roomId, id, { level: "eager", prompt: "" });
    await f.send("看看房门");
    await f.idle();
    assert.equal(calls.find((call) => call.companion)?.companion?.initiative?.level, "eager");
    await f.service.setCompanionInitiative(f.roomId, id, {
      level: "custom",
      prompt: "只在被点名或遇险时开口。",
    });
    await f.send("再看看");
    await f.idle();
    const latest = calls.filter((call) => call.companion).at(-1)?.companion?.initiative;
    assert.equal(latest?.level, "custom");
    assert.equal(latest?.prompt, "只在被点名或遇险时开口。");
    assert.equal(
      (await f.service.companionSettings(f.roomId)).seats[0].companion?.initiative.level,
      "custom",
    );
  } finally {
    await f.close();
  }
});

test("队友专属设置随席位保存和删除，重新确认不丢失且不改写房间设置", async () => {
  const f = await fixture(async () => {});
  try {
    const settingsPath = join(f.sessions, f.roomId, "settings.json");
    const roomSettings = await readFile(settingsPath, "utf8");
    const enabled = await f.enable();
    const id = enabled.companion!.id;
    const voice = {
      mode: "design" as const,
      description: "低沉而温暖的男声",
      instructions: "语速缓慢",
    };
    await assert.rejects(f.service.setCompanionVoice(f.roomId, id, { ...voice, description: " " }));
    await f.service.setCompanionVoice(f.roomId, id, voice);
    await f.service.setCompanionDocumentAccess(f.roomId, id, true);
    assert.deepEqual((await f.enable()).companion!.voice, voice);
    await f.service.setCompanionInitiative(f.roomId, id, { level: "reserved", prompt: "" });
    const model = {
      provider: "test",
      model: "companion-test",
      name: "队友模型",
      providerName: "测试",
    };
    await f.service.setCompanionModel(f.roomId, id, model);
    const confirmed = (await f.enable()).companion!;
    assert.equal(confirmed.documentAccess, true);
    assert.deepEqual(confirmed.model, model);
    assert.deepEqual(confirmed.voice, voice);
    assert.equal(confirmed.initiative.level, "reserved");
    const adventurePath = join(f.sessions, f.roomId, "adventure.json");
    const adventure = JSON.parse(await readFile(adventurePath, "utf8"));
    const seat = adventure.party.companions.find((seat: { id: string }) => seat.id === id);
    assert.deepEqual(seat.voice, voice);
    assert.equal(seat.initiative.level, "reserved");
    assert.equal(seat.documentAccess, true);
    assert.deepEqual(seat.model, model);
    await assert.rejects(f.service.setCompanionVoice(f.roomId, randomUUID(), voice), /席位不存在/);
    const restored = await f.service.setCompanionVoice(f.roomId, id, null);
    assert.equal(restored.seats.find((seat) => seat.id === id)?.companion?.voice, undefined);
    assert.equal(await readFile(settingsPath, "utf8"), roomSettings, "队友设置不重写房间设置");
    assert.equal(
      restored.seats.find((seat) => seat.id === id)?.companion?.initiative.level,
      "reserved",
    );
    await f.service.saveCompanion(f.roomId, id, null, player);
    const removed = JSON.parse(await readFile(adventurePath, "utf8"));
    assert.ok(!removed.party.companions.some((seat: { id: string }) => seat.id === id));
    assert.equal(await readFile(settingsPath, "utf8"), roomSettings);
  } finally {
    await f.close();
  }
});

test("新增队友复制冒险模板；之后修改模板只影响新队友，重新确认保留个人设置", async () => {
  const f = await fixture(async () => {}, false, true);
  try {
    const { patchRoomSettings } = await import("../sessions/room-settings");
    const directory = join(f.sessions, f.roomId);
    const model = {
      provider: "test",
      model: "companion-model",
      name: "队友模型",
      providerName: "测试",
    };
    const voice = { mode: "preset" as const, voice: "苏打" as const, instructions: "清晰" };
    patchRoomSettings(directory, {
      companion: {
        model,
        initiative: { level: "reserved", prompt: "保留文本" },
        voice,
        documentAccess: true,
      },
    });
    const first = (await f.enable()).companion!;
    assert.deepEqual(first.model, model);
    assert.equal(first.initiative.level, "reserved");
    assert.equal(first.documentAccess, true);
    assert.equal(first.voice, undefined, "默认声音不能成为覆盖模组声音的个人覆盖");
    patchRoomSettings(directory, {
      companion: {
        model: null,
        initiative: { level: "active" },
        voice: null,
        documentAccess: false,
      },
    });
    const confirmed = await f.enable();
    assert.deepEqual(confirmed.companion!.model, model);
    assert.equal(confirmed.companion!.initiative.level, "reserved");
    assert.equal(confirmed.companion!.documentAccess, true);
    const options = await f.service.companionSettings(f.roomId);
    const character = options.characters.find((item) => item.name === "艾琳")!;
    const selected = await f.service.selectCompanion(f.roomId, character.id);
    const second = selected.seats.find((seat) => !seat.companion)!.id;
    const result = await f.service.saveCompanion(
      f.roomId,
      second,
      { characterId: character.id },
      player,
    );
    const added = result.seats.find((seat) => seat.id === second)!.companion!;
    assert.equal(added.model, undefined, "null 策略继续跟随冒险主持模型");
    assert.equal(added.initiative.level, "active");
    assert.equal(added.documentAccess, false);
    assert.equal(added.initiative.prompt, "保留文本");
    const state = JSON.parse(await readFile(join(directory, "adventure.json"), "utf8"));
    assert.deepEqual(
      state.party.companions.find((seat: { id: string }) => seat.id === first.id).defaultVoice,
      voice,
    );
    assert.equal(
      state.party.companions.find((seat: { id: string }) => seat.id === second).defaultVoice,
      null,
    );
  } finally {
    await f.close();
  }
});

test("真人与队友混合批次准备失败后保留顺序和原始意图，重试只投递一次", async () => {
  const calls: Args[] = [];
  let declared = false;
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion) {
      if (declared) return emit(args, "SILENT");
      declared = true;
      return emit(args, "TURN\n队友检查门锁");
    }
    emit(args, "主持处理两个行动");
  });
  const start = spyOn(ChatRuns.prototype, "start");
  try {
    await f.enable();
    await f.service.setSubmissionMode(f.roomId, "manual");
    await f.send("@阿洛 请检查门锁");
    await f.idle();
    await f.send("真人守住入口");
    start.mockImplementationOnce(() => {
      throw new Error("准备失败");
    });
    await assert.rejects(
      f.service.continue({ roomId: f.roomId, clientRequestId: randomUUID() }, player),
      /准备失败/,
    );
    start.mockRestore();
    const failed = (await f.history()).messages
      .filter((message) => message.kind === "assistant" && !message.companionId)
      .at(-1)!;
    assert(failed.kind === "assistant" && failed.inputBatch);
    assert.equal(calls.filter((args) => !args.companion).length, 0);
    await assert.rejects(f.send("新的行动"), /先重试或放弃/);
    await f.service.resolveInput(
      { roomId: f.roomId, messageId: failed.id, batchId: failed.inputBatch.id, action: "retry" },
      player,
    );
    await f.idle();
    await f.service.resolveInput(
      { roomId: f.roomId, messageId: failed.id, batchId: failed.inputBatch.id, action: "retry" },
      player,
    );
    const hosts = calls.filter((args) => !args.companion);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].inputBatch?.id, failed.inputBatch.id);
    assert.deepEqual(
      hosts[0].inputBatch?.turns.map((turn) => turn.text),
      ["队友检查门锁", "真人守住入口"],
    );
    assert.ok(hosts[0].text.indexOf("队友检查门锁") < hosts[0].text.indexOf("真人守住入口"));
    assert.ok(!hosts[0].text.includes('"recent"'));
  } finally {
    start.mockRestore();
    await f.close();
  }
});

for (const mode of ["manual", "auto"] as const) {
  test(`${mode} 模式在玩家行动后收集积极队友行动，裁定后不重复唤起`, async () => {
    const calls: Args[] = [];
    const f = await fixture(async (args) => {
      calls.push(args);
      emit(args, args.companion ? "TURN\n我点燃火把并跟上。" : "你们进入洞口。");
    });
    try {
      const { companion } = await f.enable();
      await f.service.setCompanionInitiative(f.roomId, companion!.id, {
        level: "active",
        prompt: "",
      });
      await f.service.setSubmissionMode(f.roomId, mode);
      await f.send("这只是闲聊", true);
      await f.idle();
      assert.equal(calls.length, 0);
      const requestId = randomUUID();
      await f.send("侧身进入洞口", false, requestId);
      await f.idle();
      await f.send("侧身进入洞口", false, requestId);
      await f.idle();
      assert.ok(calls[0].companion);
      assert.equal(calls[0].requireResponse, false);
      assert.match(calls[0].text, /侧身进入洞口/);
      if (mode === "manual") {
        assert.equal(calls.length, 1);
        assert.equal((await f.history()).pendingMessageIds.length, 2);
        // 已有待提交行动时不重复调用或覆盖队友意图。
        await f.send("我压低身体");
        await f.idle();
        assert.equal(calls.length, 1);
        await f.service.continue({ roomId: f.roomId, clientRequestId: randomUUID() }, player);
        await f.idle();
      }
      assert.deepEqual(
        calls.map((args) => Boolean(args.companion)),
        [true, false],
      );
      assert.match(calls[1].text, mode === "manual" ? /我压低身体/ : /侧身进入洞口/);
      assert.match(calls[1].text, /我点燃火把并跟上/);
      assert.equal((await f.history()).pendingMessageIds.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("活跃队友可以在连续裁定后主动推进，直到自己沉默", async () => {
  const calls: Args[] = [];
  let turns = 0;
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(
      args,
      args.companion
        ? ++turns <= 3
          ? `TURN\n主动探索第 ${turns} 处线索`
          : "SILENT"
        : "主持完成裁定。",
    );
  });
  try {
    const { companion } = await f.enable();
    await f.service.setCompanionInitiative(f.roomId, companion!.id, { level: "eager", prompt: "" });
    await f.service.setSubmissionMode(f.roomId, "auto");
    await f.send("侧身进入");
    await f.idle();
    assert.deepEqual(
      calls.map((args) => Boolean(args.companion)),
      [true, false, true, false, true, false, true],
    );
    assert.equal((await f.history()).pendingMessageIds.length, 0);
  } finally {
    await f.close();
  }
});

for (const response of ["SILENT", "error"] as const) {
  test(`积极队友${response === "error" ? "生成失败" : "沉默"}后仍将玩家行动交主持`, async () => {
    const calls: Args[] = [];
    const f = await fixture(async (args) => {
      calls.push(args);
      if (args.companion && response === "error") throw new Error("测试生成失败");
      emit(args, args.companion ? response : "主持裁定。");
    });
    try {
      const { companion } = await f.enable();
      await f.service.setCompanionInitiative(f.roomId, companion!.id, {
        level: "active",
        prompt: "",
      });
      await f.service.setSubmissionMode(f.roomId, "auto");
      await f.send("侧身进入");
      await f.idle();
      assert.deepEqual(
        calls.map((args) => Boolean(args.companion)),
        [true, false],
      );
      assert.match(calls[1].text, /侧身进入/);
      assert.equal((await f.history()).pendingMessageIds.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("多名积极队友补充完毕才统一裁定，单名凭据失败不丢弃玩家行动", async () => {
  const calls: Args[] = [];
  let brokenId: string | undefined;
  const f = await fixture(
    async (args) => {
      calls.push(args);
      emit(args, args.companion ? `TURN\n${args.companion.id}准备照明` : "主持统一裁定。");
    },
    false,
    true,
    async (roomId, selection) => {
      if (brokenId && selection?.model === brokenId) throw new Error("测试凭据不可用");
      return credentials(roomId, selection);
    },
  );
  try {
    const first = (await f.enable()).companion!;
    const settings = await f.service.companionSettings(f.roomId);
    const elin = settings.characters.find((item) => item.name === "艾琳")!;
    const seat = (await f.service.selectCompanion(f.roomId, elin.id)).seats[1];
    await f.service.saveCompanion(f.roomId, seat.id, { characterId: elin.id }, player);
    for (const id of [first.id, seat.id]) {
      await f.service.setCompanionInitiative(f.roomId, id, { level: "active", prompt: "" });
    }
    await f.service.setSubmissionMode(f.roomId, "auto");
    await f.send("侧身进入");
    await f.idle();
    assert.deepEqual(
      calls.map((args) => Boolean(args.companion)),
      [true, true, false],
    );
    assert.match(calls[2].text, new RegExp(first.id));
    assert.match(calls[2].text, new RegExp(seat.id));
    brokenId = "broken-model";
    await f.service.setCompanionModel(f.roomId, first.id, {
      provider: "test",
      model: brokenId,
      name: "Broken",
      providerName: "Test",
    });
    calls.length = 0;
    await f.send("继续前进");
    await f.idle();
    assert.deepEqual(
      calls.map((args) => Boolean(args.companion)),
      [true, false],
    );
    assert.equal(calls[0].companion?.id, seat.id);
    assert.match(calls[1].text, /继续前进/);
  } finally {
    await f.close();
  }
});

test("停止玩家行动后的队友判断，保留待提交且不启动主持", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    if (args.companion) {
      enter();
      await new Promise<void>((resolve) =>
        args.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    } else emit(args, "主持裁定。");
  });
  try {
    const { companion } = await f.enable();
    await f.service.setCompanionInitiative(f.roomId, companion!.id, { level: "eager", prompt: "" });
    await f.service.setSubmissionMode(f.roomId, "auto");
    const source = await f.send("侧身进入");
    await entered;
    const active = (await f.history()).messages.find((item) => item.status === "running")!;
    await f.service.cancel(f.roomId, active.id);
    await f.idle();
    assert.equal(calls.length, 1);
    assert.deepEqual((await f.history()).pendingMessageIds, [source.id]);
  } finally {
    await f.close();
  }
});

test("模组分队不阻止积极队友参与公开行动交流", async () => {
  const calls: Args[] = [];
  const f = await fixture(async (args) => {
    calls.push(args);
    emit(args, args.companion ? "SAY\n我留在这里，可以先商量怎么配合。" : "主持裁定。");
  }, true);
  try {
    const { companion } = await f.enable();
    await f.service.setCompanionInitiative(f.roomId, companion!.id, {
      level: "active",
      prompt: "",
    });
    const db = await openSessionDatabase(f.sessions, f.roomId);
    try {
      const root = join(f.sessions, f.roomId, "game");
      const world = await readStateDocument(db, root, "世界状态/世界.json");
      const scenes = world.content.scenes as Array<{ id: string; members: string[] }>;
      scenes[0].members = ["人物/玩家"];
      scenes[1].members = ["人物/阿洛"];
      await updateGameDocument(db, root, {
        path: world.path,
        changes: [{ op: "set", path: "/scenes", value: scenes }],
      });
    } finally {
      db.close();
    }
    await f.service.setSubmissionMode(f.roomId, "auto");
    const source = await f.send("侧身进入");
    const messages = await f.idle();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].companion?.id, companion!.id);
    assert.equal(calls[1].companion, undefined);
    const context = JSON.parse(calls[0].text.split("\n")[0]!);
    assert.equal(context.scene, undefined);
    assert.ok(context.events.some((event: { id: string }) => event.id === source.id));
    const reply = messages.find(
      (message) => message.kind === "assistant" && message.companionId === companion!.id,
    )!;
    assert.match(chatText(reply), /可以先商量/);
  } finally {
    await f.close();
  }
});
