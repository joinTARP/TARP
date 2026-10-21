import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, chmod, rm, access, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";

import { Decoder } from "@colyseus/schema";
import { ChatService } from "@jointarp/core/node/game/chat-service";
import { gameRouter } from "@jointarp/core/node/game/game-router";
import { RoomStateEncoder } from "@jointarp/core/node/game/room-state-encoder";
import {
  assertRoomOverlayAdmission,
  projectLaunch,
  projectEntities,
} from "@jointarp/core/node/game/room-state-projection";
import { readCharacters } from "@jointarp/core/node/sessions/character-db";
import {
  characterSnapshot,
  validateCharacterDraft,
} from "@jointarp/core/node/sessions/character-store";
import {
  materializeCharacter,
  updateGameDocument,
  writeGameDocument,
} from "@jointarp/core/node/sessions/game-state";
import { launchState } from "@jointarp/core/node/sessions/launch-store";
import { notifyRoomChanged } from "@jointarp/core/node/sessions/room-changes";
import { roomDirectoryForDatabase } from "@jointarp/core/node/sessions/session-paths";
import {
  createSession,
  loadSessionModuleResources,
  openSessionDatabase,
  gameDirectoryForDatabase,
} from "@jointarp/core/node/sessions/session-store";
import { documentRevision } from "@jointarp/core/node/sessions/state-version";
import type { gameContract, RoomNotification } from "@jointarp/core/shared/game";
import type { LaunchAction } from "@jointarp/core/shared/launch";
import { ROOM_PROTOCOL_VERSION } from "@jointarp/core/shared/room-state";
import { RoomStateSchema } from "@jointarp/core/shared/room-state-schema";
import { createLaunchTestModule } from "@jointarp/core/testing/launch-module";
import type { WorkbenchView } from "@jointarp/module/creation-workbench";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/message-port";

import { RoomConnection } from "../../renderer/src/features/sessions/room-connection";
import {
  workbenchReferenceEntities,
  restoreWorkbenchReferencePreviews,
  mergeLaunchCommandProgress,
  type LaunchCommandProgress,
} from "../../renderer/src/features/sessions/room-launch-view";
import { RoomStateStore } from "../../renderer/src/features/sessions/room-state-store";
import { documentMediaUrl } from "../../shared/document-media";
import { NativeMessagePort } from "../../shared/native-bridge";
import { resolveMediaRequestFile } from "../media-path";
import { registerRoomMedia } from "../sessions/local-room-resources";

async function fixture(computedBody = false, uppercase = false) {
  const root = await mkdtemp(join(tmpdir(), "tarp-room-sync-"));
  const module = join(root, "module");
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({ name: "同步测试", description: "同步测试" }),
  );
  await writeFile(
    join(module, ".types/怪物.fields.json"),
    JSON.stringify({
      fields: {
        ...(computedBody
          ? {
              body: {
                type: "text",
                compute:
                  "$self.hp === 8 ? '本局改写背景' : $self.hp < 8 ? null : $self.source_body",
              },
              source_body: { type: "text", visibility: "gm" },
            }
          : {}),
        hp: { type: "number", mutable: true },
        revealed: { type: "boolean", mutable: true },
        hint: { type: "text", compute: "$self.revealed ? '已发现的线索' : '？？？'" },
        secret: { type: "text", visibility: "gm", mutable: true },
      },
    }),
  );
  await writeFile(
    join(module, "怪物/卫兵.json"),
    JSON.stringify({
      name: "卫兵",
      hp: 10,
      revealed: false,
      secret: "幕后内容",
      [computedBody ? "source_body" : "body"]: "完整正文只在详情接口返回",
    }),
  );
  if (uppercase) await rename(join(module, "怪物/卫兵.json"), join(module, "怪物/卫兵.JSON"));
  const sessions = join(root, "sessions");
  const room = await createSession(sessions, module, "同步测试");
  const chat = new ChatService(sessions, { run: async () => {} }, async () => ({
    config: { provider: "test", model: "test" },
  }));
  const db = await openSessionDatabase(sessions, room.id);
  return {
    root,
    sessions,
    room,
    chat,
    db,
    cleanup: async () => {
      db.close();
      await chat.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function nextState(
  stream: AsyncIterator<RoomNotification>,
  store: RoomStateStore,
  ack?: (delivery: { id: string; seq: number }) => Promise<void>,
) {
  for (let i = 0; i < 100; i++) {
    const item = await stream.next();
    assert.equal(item.done, false);
    if (item.value.type === "state") {
      store.apply(item.value.frame);
      await ack?.(item.value.delivery);
      return item.value.frame;
    }
  }
  throw new Error("没有状态帧");
}

test("两个原生 JSON 桥客户端同步全部实体；二进制帧、字段更改、失败和重连", async () => {
  const f = await fixture();
  const ports: NativeMessagePort[] = [];
  const abort = new AbortController();
  try {
    const connect = (nickname: string) => {
      const port1 = new NativeMessagePort((packet) =>
        queueMicrotask(() => port2.receive(JSON.parse(JSON.stringify(packet)))),
      );
      const port2 = new NativeMessagePort((packet) =>
        queueMicrotask(() => port1.receive(JSON.parse(JSON.stringify(packet)))),
      );
      ports.push(port1, port2);
      const handler = new RPCHandler(gameRouter);
      handler.upgrade(port2, { context: { player: { id: randomUUID(), nickname }, chat: f.chat } });
      return createORPCClient<ContractRouterClient<typeof gameContract>>(
        new RPCLink({ port: port1 }),
      );
    };
    const a = connect("甲");
    const b = connect("乙");
    const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
    const input = {
      baselineVersion: baseline.version,
      roomId: f.room.id,
      protocolVersion: ROOM_PROTOCOL_VERSION,
      afterChatCursor: 0,
      afterChatStreamId: (await f.chat.history({ roomId: f.room.id, limit: 1 })).streamId,
    } as const;
    const streamA = (await a.room.subscribe(input, { signal: abort.signal }))[
      Symbol.asyncIterator
    ]();
    const streamB = (await b.room.subscribe(input, { signal: abort.signal }))[
      Symbol.asyncIterator
    ]();
    const storeA = new RoomStateStore(baseline);
    const storeB = new RoomStateStore(baseline);
    const ackA = (delivery: { id: string; seq: number }) =>
      a.room.acknowledge({
        roomId: f.room.id,
        subscriptionId: delivery.id,
        sequence: delivery.seq,
      });
    const ackB = (delivery: { id: string; seq: number }) =>
      b.room.acknowledge({
        roomId: f.room.id,
        subscriptionId: delivery.id,
        sequence: delivery.seq,
      });
    const initialA = await nextState(streamA, storeA, ackA);
    const initialB = await nextState(streamB, storeB, ackB);
    const wire = new Decoder(new RoomStateSchema());
    wire.decode(Buffer.from(initialA.payload, "base64"));
    assert.equal(wire.state.entities.size, 0);
    assert.notEqual(initialA.streamId, initialB.streamId);
    const entity = Object.values(storeA.getSnapshot()!.entities)[0];
    assert.equal(entity.document.values.hp, 10);
    assert.equal(entity.document.values.hint, undefined);
    assert.equal(entity.document.values?.secret, "幕后内容");
    assert.equal(entity.document.body, "完整正文只在详情接口返回");
    assert.notEqual(
      storeA.getSnapshot()!.sections.viewerId,
      storeB.getSnapshot()!.sections.viewerId,
    );
    await updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
      path: "怪物/卫兵.json",
      changes: [{ op: "set", path: "/hp", value: 0 }],
    });
    await nextState(streamA, storeA, ackA);
    await nextState(streamB, storeB, ackB);
    assert.equal(storeA.getSnapshot()!.entities[entity.id].document.values.hp, 0);
    assert.equal(storeB.getSnapshot()!.entities[entity.id].document.values.hp, 0);
    await updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
      path: "怪物/卫兵.json",
      changes: [{ op: "set", path: "/revealed", value: true }],
    });
    await nextState(streamA, storeA, ackA);
    await nextState(streamB, storeB, ackB);
    assert.equal(storeB.getSnapshot()!.entities[entity.id].document.values?.revealed, true);
    assert.equal(storeB.getSnapshot()!.entities[entity.id].document.values.hint, undefined);
    assert.deepEqual(
      (await loadSessionModuleResources(f.sessions, f.room.id)).baseline,
      baseline,
      "资源基线不跟随本局修改改变",
    );
    await assert.rejects(
      updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
        path: "怪物/卫兵.json",
        changes: [{ op: "set", path: "/hp", value: "错误类型" }],
      }),
    );
    await writeGameDocument(f.db, gameDirectoryForDatabase(f.db), {
      path: "怪物/新怪物.json",
      content: { name: "新怪物", hp: 5, revealed: false, secret: "另一份秘密" },
    });
    await nextState(streamA, storeA, ackA);
    await nextState(streamB, storeB, ackB);
    assert.deepEqual(
      (await loadSessionModuleResources(f.sessions, f.room.id)).baseline,
      baseline,
      "本局新增不影响冻结基线",
    );
    assert.equal(Object.keys(storeA.getSnapshot()!.entities).length, 2);
    assert.equal(storeA.getSnapshot()!.entities[entity.id].document.values.hp, 0);
    const reconnect = (await a.room.subscribe(input, { signal: abort.signal }))[
      Symbol.asyncIterator
    ]();
    storeA.resetBaseline();
    const fresh = await nextState(reconnect, storeA, ackA);
    assert.equal(fresh.kind, "snapshot");
    assert.notEqual(fresh.streamId, initialA.streamId);
    assert.equal(Object.keys(storeA.getSnapshot()!.entities).length, 2);
  } finally {
    abort.abort();
    for (const port of ports) port.close();
    await f.cleanup();
  }
});

test("同一通知流在状态快照后重放聊天，慢消费者合并状态而不积累 patch", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const player = { id: randomUUID(), nickname: "甲" };
    await f.chat.send(
      { roomId: f.room.id, clientMessageId: randomUUID(), text: "你好", chatOnly: true },
      player,
    );
    const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
    const stream = f.chat.subscribeRoom(
      {
        roomId: f.room.id,
        protocolVersion: ROOM_PROTOCOL_VERSION,
        baselineVersion: baseline.version,
        afterChatCursor: 0,
        afterChatStreamId: (await f.chat.history({ roomId: f.room.id, limit: 1 })).streamId,
      },
      player,
      abort.signal,
    );
    const store = new RoomStateStore(baseline);
    await nextState(stream, store);
    for (const hp of [8, 6, 3])
      await updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
        path: "怪物/卫兵.json",
        changes: [{ op: "set", path: "/hp", value: hp }],
      });
    const event = await stream.next();
    assert.equal(event.value?.type, "chat");
    const patch = await nextState(stream, store);
    assert.equal(patch.seq, 2);
    assert.equal(Object.values(store.getSnapshot()!.entities)[0].document.values.hp, 3);
    const pending = stream.next();
    abort.abort();
    assert.equal((await pending).done, true);
  } finally {
    abort.abort();
    await f.cleanup();
  }
});

test("重建主机后仍用原始模组基线，只发送已存档的覆盖，拒绝错误基线", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const player = { id: randomUUID(), nickname: "重连玩家" };
  let reopened: ChatService | undefined;
  try {
    const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
    await updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
      path: "怪物/卫兵.json",
      changes: [{ op: "set", path: "/hp", value: 4 }],
    });
    await f.chat.close();
    reopened = new ChatService(f.sessions, { run: async () => {} }, async () => {
      throw new Error("不调用模型");
    });
    const reloaded = await loadSessionModuleResources(f.sessions, f.room.id);
    assert.deepEqual(reloaded.baseline, baseline);
    const bad = reopened.subscribeRoom(
      {
        roomId: f.room.id,
        protocolVersion: ROOM_PROTOCOL_VERSION,
        baselineVersion: "f".repeat(64),
        afterChatCursor: 0,
        afterChatStreamId: (await reopened.history({ roomId: f.room.id, limit: 1 })).streamId,
      },
      player,
      abort.signal,
    );
    await assert.rejects(
      bad.next(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "PRECONDITION_FAILED",
    );
    const stream = reopened.subscribeRoom(
      {
        roomId: f.room.id,
        protocolVersion: ROOM_PROTOCOL_VERSION,
        baselineVersion: baseline.version,
        afterChatCursor: 0,
        afterChatStreamId: (await reopened.history({ roomId: f.room.id, limit: 1 })).streamId,
      },
      player,
      abort.signal,
    );
    const store = new RoomStateStore(baseline);
    const frame = await nextState(stream, store);
    const wire = new Decoder(new RoomStateSchema());
    wire.decode(Buffer.from(frame.payload, "base64"));
    const entity = [...wire.state.entities.values()][0];
    assert.equal(wire.state.entities.size, 1);
    assert.deepEqual([...entity.fields], [["hp", "4"]]);
    assert.equal(Object.values(store.getSnapshot()!.entities)[0].document.values.hp, 4);
    abort.abort();
    await stream.return(undefined);
  } finally {
    abort.abort();
    await reopened?.close();
    await f.cleanup();
  }
});

test("只消费房间流即可完成准备、选角、绑定及预写开场，无状态轮询", async () => {
  const fixture = await createLaunchTestModule();
  const room = await createSession(fixture.sessions, fixture.modulePath, "开场同步");
  const player = { id: randomUUID(), nickname: "玩家" };
  const chat = new ChatService(fixture.sessions, { run: async () => {} }, async () => {
    throw new Error("预写开场不调用模型");
  });
  const { port1, port2 } = new MessageChannel();
  let launchReads = 0;
  new RPCHandler(gameRouter, {
    interceptors: [
      async ({ path, next }) => {
        if (path.join(".") === "launch.get") launchReads++;
        return next();
      },
    ],
  }).upgrade(port2, { context: { chat, player } });
  port1.start();
  port2.start();
  const client = createORPCClient<ContractRouterClient<typeof gameContract>>(
    new RPCLink({ port: port1 }),
  );
  const connection = new RoomConnection(client, room.id, {
    resources: (id) => loadSessionModuleResources(fixture.sessions, id),
  });
  const release = connection.retain();
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `开场同步超时：${connection.getSnapshot().error?.message ?? "没有收到目标状态"}`,
    );
  };
  const state = () => connection.getSnapshot().replica?.sections.launch;
  let command: LaunchCommandProgress | undefined;
  const act = async (action: LaunchAction["action"], extra = {}) => {
    const view = state()!;
    command = command
      ? mergeLaunchCommandProgress(command, room.id, view)
      : { roomId: room.id, room: view.room, progress: view.progress };
    const latest = command;
    const next = await client.launch.advance({
      roomId: room.id,
      revision: latest.progress.revision,
      roomRevision: latest.room.revision,
      action,
      ...extra,
    });
    if (next) command = mergeLaunchCommandProgress(command, room.id, next);
    return next;
  };
  try {
    await until(() => !!state());
    const resourceOnly = state();
    assert.ok(!resourceOnly || !("references" in resourceOnly));
    assert.ok(!resourceOnly || !("config" in resourceOnly));
    assert.ok(!resourceOnly || !("types" in resourceOnly));
    const ready = connection
      .getSnapshot()
      .messages.find((message) => message.kind === "card" && message.card.type === "ready")!;
    assert.ok(ready);
    await client.launch.confirmReady({ roomId: room.id, messageId: ready.id });
    await until(() => state()?.progress.stage === "character");
    const characterId = state()!.characterIds.find((id) =>
      Object.values(connection.getSnapshot().replica!.entities).some(
        (entity) => entity.character?.id === id && entity.document.title === "测试旅人",
      ),
    )!;
    const beforeSelect = state()!;
    const selected = await act("select", { characterId });
    assert.ok(selected);
    command = mergeLaunchCommandProgress(command!, room.id, beforeSelect);
    assert.equal(
      command.progress.revision,
      selected.progress.revision,
      "陈旧渲染不能覆盖动作返回的进度",
    );
    const otherRoom = { ...command, roomId: randomUUID() };
    assert.equal(
      mergeLaunchCommandProgress(otherRoom, room.id, selected),
      otherRoom,
      "旧房间响应不能更新新房间命令",
    );
    await act("confirm");
    await until(() => state()?.progress.confirmed === true);
    assert.equal(
      Object.values(connection.getSnapshot().replica!.entities).find(
        (entity) => entity.character?.id === characterId,
      )?.character?.playerId,
      player.id,
    );
    await act("beginAdventure");
    await until(() => state()?.room.opening === "complete");
    await until(() =>
      connection.getSnapshot().messages.some((message) => message.kind === "scripted"),
    );
    assert.equal(launchReads, 0, "正常开局无需独立 launch.get 查询");
  } finally {
    release();
    port1.close();
    port2.close();
    await chat.close();
    await fixture.cleanup();
  }
});

test("跨目录同一冻结模组保持相同原始基线，角色 UUID 和图片 URL 不进入原始文档", async () => {
  const f = await createLaunchTestModule();
  const databases = [] as Awaited<ReturnType<typeof openSessionDatabase>>[];
  try {
    const source = join(f.modulePath, "角色/测试旅人.json");
    const document = JSON.parse(await readFile(source, "utf8"));
    await writeFile(
      source,
      JSON.stringify({ ...document, body: "冻结背景", image: "头像.png", avatar: "头像.png" }),
    );
    await writeFile(
      join(f.modulePath, "角色/头像.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const a = await createSession(f.sessions, f.modulePath, "甲的冒险");
    const otherRoot = join(f.root, "another-sessions");
    const b = await createSession(otherRoot, f.modulePath, "乙的冒险");
    const dbA = await openSessionDatabase(f.sessions, a.id);
    const dbB = await openSessionDatabase(otherRoot, b.id);
    databases.push(dbA, dbB);
    assert.notEqual(readCharacters(dbA)[0].id, readCharacters(dbB)[0].id);
    const baselineA = (await loadSessionModuleResources(f.sessions, a.id)).baseline;
    const baselineB = (await loadSessionModuleResources(otherRoot, b.id)).baseline;
    assert.deepEqual(baselineA, baselineB);
    assert.ok(Object.values(baselineA.entities).every((entity) => !entity.character));
    assert.ok(!JSON.stringify(baselineA).includes(f.root));
    const docA = Object.values(baselineA.entities).find(
      (entity) => entity.document.path === "角色/测试旅人.json",
    )!.document;
    const docB = Object.values(baselineB.entities).find(
      (entity) => entity.document.path === "角色/测试旅人.json",
    )!.document;
    assert.equal(docA.image, "头像.png");
    assert.equal(docB.image, docA.image);
    assert.equal(docA.avatar, "头像.png");
    assert.equal(docA.values?.avatar, undefined);
    await writeFile(join(f.modulePath, "角色/头像.png"), "修改图片字节");
    const c = await createSession(otherRoot, f.modulePath, "新图片版本");
    assert.notEqual(
      (await loadSessionModuleResources(otherRoot, c.id)).baseline.version,
      baselineA.version,
      "图片文件内容也参与冻结模组版本",
    );
  } finally {
    for (const db of databases) db.close();
    await f.cleanup();
  }
});

test("计算展示字段不参与原始文档投影，仅文档提交更新版本，普通房间通知不推进版本", async () => {
  const f = await fixture(true);
  try {
    const initial = await projectEntities(f.db);
    const revision = initial.documentRevision;
    await updateGameDocument(f.db, gameDirectoryForDatabase(f.db), {
      path: "怪物/卫兵.json",
      changes: [{ op: "set", path: "/hp", value: 8 }],
    });
    const changed = await projectEntities(f.db);
    const entity = Object.values(changed.entities)[0]!;
    assert.equal(entity.document.body, undefined);
    assert.equal(entity.document.values?.source_body, "完整正文只在详情接口返回");
    assert.equal(entity.document.values?.hp, 8);
    assert.equal(entity.document.values?.hint, undefined);
    assert.equal(changed.documentRevision, revision + 1);
    notifyRoomChanged(roomDirectoryForDatabase(f.db));
    const notified = await projectEntities(f.db);
    assert.equal(notified.documentRevision, changed.documentRevision);
    assert.equal(notified.overlayRevision, changed.overlayRevision);
  } finally {
    await f.cleanup();
  }
});

test("同目录的冻结文件修复后重新读取资源，清除旧模组投影缓存", async () => {
  const f = await fixture();
  try {
    const original = await loadSessionModuleResources(f.sessions, f.room.id);
    const file = join(f.sessions, f.room.id, "module/怪物/卫兵.json");
    const source = await readFile(file, "utf8");
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ name: "错误副本", hp: 11, revealed: false }));
    const wrong = await loadSessionModuleResources(f.sessions, f.room.id);
    assert.notEqual(wrong.baseline.version, original.baseline.version);
    assert.equal(Object.values(wrong.baseline.entities)[0].document.values.hp, 11);
    await writeFile(file, source);
    const restored = await loadSessionModuleResources(f.sessions, f.room.id);
    assert.deepEqual(restored.baseline, original.baseline);
  } finally {
    await f.cleanup();
  }
});

test("计算名称与画像的建卡预览和落盘一致，客户端本地入口可还原图片", async () => {
  const f = await createLaunchTestModule();
  let db: Awaited<ReturnType<typeof openSessionDatabase>> | undefined;
  try {
    const typePath = join(f.modulePath, ".types/角色.fields.toml");
    await rm(typePath);
    await writeFile(
      join(f.modulePath, ".types/角色.fields.json"),
      JSON.stringify({
        designation: "character",

        fields: {
          name: { type: "text", compute: "'冒险者 ' + $self.hp" },
          image: { type: "text", compute: "'角色/头像.png'" },
          avatar: { type: "text", compute: "'角色/专用头像.png'" },
          hp: { type: "number", mutable: true },
        },
      }),
    );
    await writeFile(join(f.modulePath, "角色/头像.png"), "临时图片");
    await writeFile(join(f.modulePath, "角色/专用头像.png"), "临时头像");
    const characterPath = join(f.modulePath, "角色/测试旅人.json");
    const original = JSON.parse(await readFile(characterPath, "utf8"));
    delete original.name;
    await writeFile(
      characterPath,
      JSON.stringify({
        ...original,
        body: "未改选项正文",
      }),
    );
    await writeFile(join(f.modulePath, "角色/测试守卫.json"), JSON.stringify({ hp: 10 }));
    const room = await createSession(f.sessions, f.modulePath, "预览图片");
    db = await openSessionDatabase(f.sessions, room.id);
    const draft = {
      id: "draft",
      typeId: "角色",
      sourcePath: null,
      playerId: null,
      name: "",
      description: "",
      values: { hp: 8 },
      version: 1,
    };
    validateCharacterDraft(db, {
      typeId: draft.typeId,
      name: draft.name,
      description: draft.description,
      values: draft.values,
    });
    const snapshot = await characterSnapshot(db, draft);
    const draftView = snapshot.characters.find((character) => character.id === "draft")!;
    assert.equal(draftView.name, "冒险者 8");
    await materializeCharacter(db, gameDirectoryForDatabase(db), draft);
    const stored = JSON.parse(
      await readFile(join(gameDirectoryForDatabase(db), "角色/draft.json"), "utf8"),
    );
    assert.deepEqual(stored, { hp: 8 });
    assert.equal(draftView.image, "角色/头像.png");
    assert.equal(draftView.avatar, "角色/专用头像.png");
    const launch = (await launchState(f.sessions, room.id, randomUUID()))!;
    const workbench: WorkbenchView = {
      stages: [
        { id: "current", title: "当前", complete: false },
        { id: "future", title: "以后", complete: false },
      ],
      draft: { typeId: "角色", name: "新角色", description: "", values: { hp: 8 } },
      swap: [],
      missing: [],
      items: [0, 1].map((stage) => ({
        key: `stage-${stage}`,
        title: "参考",
        kind: "reference",
        stage,
        options: [
          {
            value: stage === 0 ? "角色/测试旅人" : "地点/试验场",
            label: "参考",
            body: "未改选项正文",
          },
        ],
        missing: true,
        private: false,
      })),
    };
    const projected = projectLaunch(db, { ...launch, workbench, draftView })!;
    assert.ok(projected.workbench!.items.every((item) => item.options[0].body === undefined));
    const { entities } = await projectEntities(db);
    const references = workbenchReferenceEntities(projected, entities);
    assert.equal(references.length, 1);
    const localDocument = references[0].document;
    const previews = restoreWorkbenchReferencePreviews(projected.workbench!, 0, [localDocument]);
    assert.equal(previews.items[0].options[0].body, "未改选项正文");
    assert.equal(previews.items[1].options[0].body, undefined, "未来阶段不预取正文");
    assert.equal(projected.draftView!.image, "角色/头像.png");
    assert.equal(projected.draftView!.avatar, "角色/专用头像.png");
    registerRoomMedia(f.sessions, room.id);
    const image = await resolveMediaRequestFile(
      documentMediaUrl(`room:${room.id}`, "角色/draft.json", projected.draftView!.image)!,
    );
    assert.ok(image?.endsWith("角色/头像.png"));
    const avatar = await resolveMediaRequestFile(
      documentMediaUrl(`room:${room.id}`, "角色/draft.json", projected.draftView!.avatar)!,
    );
    assert.ok(avatar?.endsWith("角色/专用头像.png"));
    assert.notEqual(avatar, image);
    assert.ok(!JSON.stringify(projected).includes(f.root));
  } finally {
    db?.close();
    await f.cleanup();
  }
});

test("协议版本校验且文档准入在落盘前拒绝单文档和累计超限", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const { baseline } = await loadSessionModuleResources(f.sessions, f.room.id);
    const stream = f.chat.subscribeRoom(
      {
        roomId: f.room.id,
        protocolVersion: Number.MAX_SAFE_INTEGER,
        baselineVersion: baseline.version,
        afterChatCursor: 0,
        afterChatStreamId: (await f.chat.history({ roomId: f.room.id, limit: 1 })).streamId,
      },
      { id: randomUUID(), nickname: "协议不匹配客户端" },
      abort.signal,
    );
    await assert.rejects(
      stream.next(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BAD_REQUEST",
    );
    await assert.rejects(
      assertRoomOverlayAdmission(
        f.db,
        new Map([["怪物/超限.json", JSON.stringify({ body: "x".repeat(1024 * 1024) })]]),
      ),
    );
    const batch = new Map(
      Array.from({ length: 9 }, (_, index) => [
        `怪物/新增${index}.json`,
        JSON.stringify({ body: "x".repeat(950000) }),
      ]),
    );
    await assert.rejects(assertRoomOverlayAdmission(f.db, batch));
    const excessive = new Map(
      Array.from({ length: 10000 }, (_, index) => [
        `怪物/计数${index}.json`,
        JSON.stringify({ hp: 1 }),
      ]),
    );
    await assert.rejects(
      assertRoomOverlayAdmission(f.db, excessive),
      (error: unknown) => error instanceof Error && error.message.includes("10000"),
    );
    assert.equal(Object.keys((await projectEntities(f.db)).entities).length, 1);
  } finally {
    abort.abort();
    await f.cleanup();
  }
});

test("累计容量拒绝时不创建文件、不推进文档版本，已提交覆盖仍能重连", async () => {
  const f = await fixture();
  try {
    const root = gameDirectoryForDatabase(f.db);
    for (let index = 0; index < 8; index++)
      await writeGameDocument(f.db, root, {
        path: `怪物/容量${index}.json`,
        content: { hp: 1, revealed: false, body: "x".repeat(950000) },
      });
    const before = documentRevision(f.db);
    await assert.rejects(
      writeGameDocument(f.db, root, {
        path: "怪物/容量溢出.json",
        content: { hp: 1, revealed: false, body: "x".repeat(950000) },
      }),
      /累计文档覆盖/u,
    );
    assert.equal(documentRevision(f.db), before);
    await assert.rejects(access(join(root, "怪物/容量溢出.json")));
    const resources = await loadSessionModuleResources(f.sessions, f.room.id);
    const replica = await f.chat.roomProjection(f.room.id, {
      id: randomUUID(),
      nickname: "容量测试",
    });
    const frame = new RoomStateEncoder(resources.baseline).update(replica)!;
    const store = new RoomStateStore(resources.baseline);
    store.apply(frame);
    assert.equal(Object.keys(store.getSnapshot()!.entities).length, 9);
  } finally {
    await f.cleanup();
  }
});

test("原始同步保留大写格式扩展名的文档类型，计算输入仍可识别", async () => {
  const f = await fixture(false, true);
  try {
    const resources = await loadSessionModuleResources(f.sessions, f.room.id);
    const doc = Object.values(resources.baseline.entities)[0].document;
    assert.equal(doc.path, "怪物/卫兵.JSON");
    assert.equal(doc.docType, "怪物");
    assert.equal(doc.contentType, "json");
    const view = await projectEntities(f.db);
    assert.equal(Object.values(view.entities)[0].document.docType, "怪物");
  } finally {
    await f.cleanup();
  }
});
