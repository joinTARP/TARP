import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creationFlowSchema, launchConfigSchema } from "@tarp/module/flow";
import { writeTestFile as writeFile } from "@tarp/module/testing/files";
import { ZodError } from "zod";

import type { LaunchAction, LaunchState } from "../../shared/launch";
import { readOpeningBackground } from "../agent/pi-runtime";
import { ChatService, type Runtime } from "../game/chat-service";
import { assertPlayerReady, readCharacters } from "./character-db";
import { withCharacters } from "./character-store";
import { updateGameDocument } from "./game-state";
import { readLaunchRoom } from "./launch-db";
import { advanceLaunch, launchState } from "./launch-store";
import { createSession, gameDirectoryForDatabase } from "./session-store";

async function fixture(options: { ai?: boolean; instructions?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tarp-launch-")),
    module = join(root, "module"),
    sessions = join(root, "sessions"),
    player = { id: randomUUID(), nickname: "玩家" };
  await mkdir(join(module, ".types"), { recursive: true });
  const creationFlow = creationFlowSchema.parse({
    workbench: {
      stages: [
        {
          id: "identity",
          title: "身份",
          tasks: [{ id: "name", title: "姓名", kind: "input", bind: "name" }],
        },
        {
          id: "vital",
          title: "生命",
          tasks: [
            { id: "hp", title: "生命", kind: "roll", bind: "hp", dice: { count: 1, sides: 6 } },
          ],
        },
      ],
    },
  });
  await writeFile(
    join(module, ".types", "人物.fields.json"),
    JSON.stringify({
      designation: "character",
      fields: {
        hp: { type: "number", required: true, mutable: true },
        detail: { type: "text" },
        status: { type: "text", compute: "$self.hp > 0 ? '行动' : '倒下'" },
      },
      creationFlow,
    }),
  );
  await writeFile(join(module, "人物/向导.json"), JSON.stringify({ name: "向导", hp: 6 }));
  await writeFile(join(module, ".types", "地点.fields.json"), JSON.stringify({ fields: {} }));
  await writeFile(
    join(module, "地点/河畔.json"),
    JSON.stringify({ name: "河畔", description: "风吹过芦苇。" }),
  );
  const config = launchConfigSchema.parse({
    preludeFlow: { steps: [{ id: "intro", type: "introduction", title: "欢迎" }] },
    gameStarts: [
      {
        id: "river",
        name: "河畔",
        description: "风吹过河畔的芦苇。",
        characterTypeIds: ["人物"],
        playablePaths: ["人物/向导.json"],
        opening: {
          mode: options.ai ? "ai" : "scripted",
          prompt: "从河边开始",
          beats: [
            { text: "你听见水声。" },
            { text: '<message npc path="人物/向导" name="向导">\n跟我来。\n</message>' },
          ],
          instructions: options.instructions ?? "",
        },
      },
      {
        id: "night",
        name: "夜晚",
        characterTypeIds: ["人物"],
        opening: { mode: "scripted", beats: [{ text: "夜色降临。" }] },
      },
    ],
  });
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "流程测试", description: "测试", ...config }),
  );
  const room = await createSession(sessions, module, "测试");
  return { root, module, sessions, roomId: room.id, player, config, creationFlow };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test("拒绝不完整的开局进度、角色草稿和队友席位，并保留损坏原文", async () => {
  const f = await fixture();
  try {
    const path = join(f.sessions, f.roomId, "adventure.json");
    const original = await readFile(path, "utf8");
    for (const damage of [
      (stored: any) => {
        delete stored.launch.state.intro;
      },
      (stored: any) => {
        stored.launch.players[f.player.id] = {};
      },
      (stored: any) => {
        stored.party.characters[0].sourcePath = null;
      },
      (stored: any) => {
        stored.party.companions.push({ id: randomUUID(), status: "active" });
      },
    ]) {
      const stored = JSON.parse(original);
      damage(stored);
      const damaged = JSON.stringify(stored);
      await writeFile(path, damaged);
      await assert.rejects(launchState(f.sessions, f.roomId, f.player.id), /字段校验失败/);
      assert.equal(await readFile(path, "utf8"), damaged);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function act(
  f: Fixture,
  args: Omit<LaunchAction, "roomId" | "revision" | "roomRevision">,
  state?: LaunchState,
) {
  const s = state ?? (await launchState(f.sessions, f.roomId, f.player.id))!;
  return (await advanceLaunch(
    f.sessions,
    { roomId: f.roomId, revision: s.progress.revision, roomRevision: s.room.revision, ...args },
    f.player.id,
  ))!;
}
async function work(
  f: Fixture,
  operation: NonNullable<LaunchAction["operation"]>,
  extra: Partial<LaunchAction> = {},
) {
  return act(f, { action: "workbench", operation, requestId: randomUUID(), ...extra });
}
async function choose(f: Fixture) {
  await act(f, { action: "next" });
  await act(f, { action: "start", startId: "river" });
}
async function preset(f: Fixture) {
  await choose(f);
  const state = (await launchState(f.sessions, f.roomId, f.player.id))!;
  await act(f, { action: "select", characterId: state.characters[0].id });
  await act(f, { action: "confirm" });
}
const credentials = async () => ({
  config: { provider: "test", model: "fixture" },
});

async function settled(chat: ChatService, roomId: string) {
  for (let i = 0; i < 100; i++) {
    const h = await chat.history({ roomId, limit: 100 });
    if (!h.messages.some((m) => m.status === "running")) return h;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("未结束");
}
function narrate(args: Parameters<Runtime["run"]>[0]) {
  args.onAgentEvent({
    type: "message_start",
    messageIndex: 0,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "晨雾笼罩河面，你站在河边。" }],
      api: "test",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
}

test("工作台无模型建卡，生成幂等且返回保留结果，拒绝跳步与伪造确认", async () => {
  const f = await fixture();
  try {
    await assert.rejects(act(f, { action: "create", typeId: "人物" }), /先完成/);
    await choose(f);
    await act(f, { action: "create", typeId: "人物" });
    await assert.rejects(
      act(f, { action: "workbench", operation: "review", requestId: randomUUID() }),
      /请完成/,
    );
    await assert.rejects(
      act(f, { action: "roll" } as unknown as Omit<
        LaunchAction,
        "roomId" | "revision" | "roomRevision"
      >),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.deepEqual(
          error.issues.map((issue) => issue.path),
          [["action"]],
        );
        return true;
      },
    );
    await work(f, "save", { answers: { "identity/name": "莉娜" } });
    await work(f, "navigate", { stageIndex: 1 });
    const before = (await launchState(f.sessions, f.roomId, f.player.id))!;
    const request = {
      action: "workbench" as const,
      operation: "generate" as const,
      requestId: randomUUID(),
    };
    const generated = await act(f, request, before);
    const duplicate = await act(f, request, before);
    assert.deepEqual(duplicate.progress.workbench!.rolls, generated.progress.workbench!.rolls);
    assert.equal(duplicate.progress.revision, generated.progress.revision);
    const roll = generated.progress.workbench!.rolls["vital/hp"];
    assert.equal(roll.total >= 1 && roll.total <= 6, true);
    await assert.rejects(
      act(f, { action: "workbench", operation: "generate", requestId: randomUUID() }, before),
      /已变化/,
    );
    await work(f, "navigate", { stageIndex: 0 });
    const restored = await work(f, "navigate", { stageIndex: 1 });
    assert.deepEqual(restored.progress.workbench!.rolls, generated.progress.workbench!.rolls);
    await work(f, "review");
    await assert.rejects(
      act(f, {
        action: "confirm",
        draft: { typeId: "人物", name: "伪造", description: "", values: { hp: 999 } },
      } as unknown as Omit<LaunchAction, "roomId" | "revision" | "roomRevision">),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.ok(
          error.issues.some(
            (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("draft"),
          ),
        );
        return true;
      },
    );
    const confirmed = await act(f, { action: "confirm" });
    assert.equal(confirmed.progress.confirmed, true);
    await act(f, { action: "confirm" }, confirmed);
    await withCharacters(f.sessions, f.roomId, (db) => {
      const own = readCharacters(db).filter((c) => c.playerId === f.player.id);
      assert.equal(own.length, 1);
      assert.equal(own[0].name, "莉娜");
      assert.equal(own[0].values.hp, roll.total);
      assert.throws(() => assertPlayerReady(db, f.player.id), /开场/);
    });
    const chat = new ChatService(
      f.sessions,
      {
        run: async () => {
          throw new Error("不应调用模型");
        },
      },
      async () => {
        throw new Error("不应读取凭据");
      },
    );
    try {
      await chat.openLaunch(f.roomId, f.player);
      await chat.openLaunch(f.roomId, f.player);
      const h = await chat.history({ roomId: f.roomId, limit: 100 });
      assert.equal(h.messages.length, 2);
      assert(h.messages.every((m) => m.kind === "scripted"));
      await withCharacters(f.sessions, f.roomId, (db) => assertPlayerReady(db, f.player.id));
    } finally {
      await chat.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("切换开局清除工作台草稿，原模组修改不影响房间", async () => {
  const f = await fixture();
  try {
    await choose(f);
    await act(f, { action: "create", typeId: "人物" });
    await work(f, "save", { answers: { "identity/name": "A" } });
    await work(f, "navigate", { stageIndex: 1 });
    await work(f, "generate");
    await act(f, { action: "back" });
    await act(f, { action: "back" });
    await act(f, { action: "start", startId: "night" });
    await act(f, { action: "create", typeId: "人物" });
    const current = (await launchState(f.sessions, f.roomId, f.player.id))!;
    assert.equal(current.progress.workbench, undefined);
    await writeFile(join(f.module, "module.json"), JSON.stringify({ name: "已改变" }));
    assert.equal(current.config.gameStarts.length, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("初始化写入后开场中断，下次从当前文件继续并播放预写开场", async () => {
  const f = await fixture({ instructions: "生命设置为 3" });
  let calls = 0;
  const runs: string[] = [];
  const texts: string[] = [];
  const chat = new ChatService(
    f.sessions,
    {
      run: async (a) => {
        calls++;
        runs.push(a.messageId);
        texts.push(a.text);
        await withCharacters(f.sessions, f.roomId, async (db) => {
          const c = readCharacters(db).find((c) => c.playerId === f.player.id)!;
          await updateGameDocument(db, gameDirectoryForDatabase(db), {
            path: c.sourcePath!,
            changes: [{ op: "set", path: "/hp", value: 3 }],
          });
        });
        if (calls === 1) throw new Error("断开");
      },
    },
    credentials,
  );
  try {
    await preset(f);
    await chat.openLaunch(f.roomId, f.player);
    let h = await settled(chat, f.roomId);
    assert.equal(h.messages.filter((m) => m.kind === "scripted").length, 0);
    await withCharacters(f.sessions, f.roomId, async (db) => {
      const character = readCharacters(db).find((item) => item.playerId === f.player.id)!;
      assert.equal(
        JSON.parse(
          await readFile(join(gameDirectoryForDatabase(db), character.sourcePath!), "utf8"),
        ).values.hp,
        3,
      );
      assert.equal(readLaunchRoom(db).opening, "running");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await chat.openLaunch(f.roomId, f.player);
    h = await settled(chat, f.roomId);
    assert.equal(h.messages.filter((m) => m.kind === "scripted").length, 2);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0], runs[1]);
    assert.match(texts[1]!, /中断/);
    await chat.openLaunch(f.roomId, f.player);
    assert.equal(calls, 2);
    await withCharacters(f.sessions, f.roomId, async (db) => {
      const character = readCharacters(db).find((item) => item.playerId === f.player.id)!;
      assert.equal(
        JSON.parse(
          await readFile(join(gameDirectoryForDatabase(db), character.sourcePath!), "utf8"),
        ).values.hp,
        3,
      );
      assert.equal(readLaunchRoom(db).opening, "complete");
    });
  } finally {
    await chat.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("缺少模型不撤销角色；补齐配置后可开始 AI 开场", async () => {
  const f = await fixture({ ai: true });
  let fail = true;
  const chat = new ChatService(f.sessions, { run: async (args) => narrate(args) }, async () => {
    if (fail) throw new Error("未配置模型");
    return credentials();
  });
  try {
    await preset(f);
    await assert.rejects(chat.openLaunch(f.roomId, f.player), /未配置/);
    assert.equal((await launchState(f.sessions, f.roomId, f.player.id))!.progress.confirmed, true);
    fail = false;
    await chat.openLaunch(f.roomId, f.player);
    await settled(chat, f.roomId);
    assert.equal((await launchState(f.sessions, f.roomId, f.player.id))!.room.opening, "complete");
  } finally {
    await chat.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("AI 开场停止后可从当前状态开启新回合；空叙事不能作为成功开场", async () => {
  const f = await fixture({ ai: true });
  let calls = 0;
  let activeRun = "";
  let runtimeEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    runtimeEntered = resolve;
  });
  const chat = new ChatService(
    f.sessions,
    {
      run: async (a) => {
        activeRun = a.messageId;
        runtimeEntered();
        assert.equal(a.rollDice, undefined);
        calls++;
        if (calls === 1)
          await new Promise<void>((r) =>
            a.signal.addEventListener("abort", () => r(), { once: true }),
          );
      },
    },
    credentials,
  );
  try {
    await preset(f);
    await chat.openLaunch(f.roomId, f.player);
    await entered;
    assert(activeRun);
    await chat.cancel(f.roomId, activeRun);
    assert.equal(
      (await launchState(f.sessions, f.roomId, f.player.id))!.openingMessage?.status,
      "cancelled",
    );
    await chat.openLaunch(f.roomId, f.player);
    await settled(chat, f.roomId);
    assert.equal(
      (await launchState(f.sessions, f.roomId, f.player.id))!.openingMessage?.status,
      "failed",
    );
    await chat.close();
    const restarted = new ChatService(
      f.sessions,
      {
        run: async (a) => {
          assert.notEqual(a.messageId, activeRun);
          narrate(a);
        },
      },
      credentials,
    );
    try {
      await restarted.openLaunch(f.roomId, f.player);
      await settled(restarted, f.roomId);
      assert.equal(
        (await launchState(f.sessions, f.roomId, f.player.id))!.room.opening,
        "complete",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await chat.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("第一位玩家确认锁定方案，其他玩家不能抢占，后续提示包含实际开场而无初始化指令", async () => {
  const f = await fixture();
  let prompt = "";
  const chat = new ChatService(
    f.sessions,
    {
      run: async (a) => {
        prompt = a.text;
      },
    },
    credentials,
  );
  try {
    await preset(f);
    const other = { ...f, player: { id: randomUUID(), nickname: "第二位" } };
    const ready = await act(other, { action: "next" });
    assert.equal(ready.progress.stage, "character");
    assert.equal(ready.characters.length, 0);
    await assert.rejects(act(other, { action: "start", startId: "night" }), /锁定/);
    const owned = (await launchState(f.sessions, f.roomId, f.player.id))!.characters.find(
      (c) => c.playerId === f.player.id,
    )!;
    await assert.rejects(act(other, { action: "select", characterId: owned.id }), /不可选/);
    await chat.openLaunch(f.roomId, f.player);
    await chat.send(
      { roomId: f.roomId, clientMessageId: randomUUID(), text: "我向河边走去", chatOnly: false },
      f.player,
    );
    await settled(chat, f.roomId);
    assert(!prompt.includes("你听见水声"));
    assert(!prompt.includes("开局背景资料"));
    const opening = await readOpeningBackground(join(f.sessions, f.roomId));
    assert(opening.includes("你听见水声"));
    assert(opening.includes("风吹过河畔的芦苇。"));
    assert(opening.includes("不代表当前位置"));
    assert(!prompt.includes("初始化要求"));
    assert(!prompt.includes("prelude"));
    assert.equal(
      (await launchState(f.sessions, f.roomId, f.player.id))!.room.characterId,
      owned.id,
    );
  } finally {
    await chat.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
