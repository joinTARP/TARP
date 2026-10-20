import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { call } from "@orpc/server";
import { initializeAdventure } from "@tarp/core/node/sessions/room-storage";

import { roomNotesRouter } from "./room-notes-router";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-notes-rpc-"));
  const roomId = randomUUID();
  const directory = join(root, "sessions", roomId);
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  initializeAdventure(directory, {
    id: roomId,
    name: "测试冒险",
    moduleName: "测试",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return { root, roomId, sessionsRoot: join(root, "sessions") };
}

test("笔记 RPC 使用主进程玩家身份，拒绝读取、覆盖其他玩家及切换身份后的旧请求", async () => {
  const f = await fixture();
  const first = { id: randomUUID(), nickname: "同名玩家" };
  const second = { id: randomUUID(), nickname: "同名玩家" };
  const firstContext = { sessionsRoot: f.sessionsRoot, player: first };
  const secondContext = { sessionsRoot: f.sessionsRoot, player: second };
  try {
    await call(
      roomNotesRouter.save,
      { roomId: f.roomId, playerId: first.id, content: "甲的秘密" },
      { context: firstContext },
    );
    assert.equal(
      await call(
        roomNotesRouter.get,
        { roomId: f.roomId, playerId: second.id },
        { context: secondContext },
      ),
      "",
    );
    await call(
      roomNotesRouter.save,
      { roomId: f.roomId, playerId: second.id, content: "乙的线索" },
      { context: secondContext },
    );
    await assert.rejects(
      call(
        roomNotesRouter.get,
        { roomId: f.roomId, playerId: first.id },
        { context: secondContext },
      ),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(
      call(
        roomNotesRouter.save,
        { roomId: f.roomId, playerId: first.id, content: "串入的旧草稿" },
        { context: secondContext },
      ),
      { code: "FORBIDDEN" },
    );
    assert.equal(
      await call(
        roomNotesRouter.get,
        { roomId: f.roomId, playerId: first.id },
        { context: { ...firstContext, player: { ...first, nickname: "新昵称" } } },
      ),
      "甲的秘密",
    );
    assert.equal(
      await call(
        roomNotesRouter.get,
        { roomId: f.roomId, playerId: second.id },
        { context: secondContext },
      ),
      "乙的线索",
    );
    await assert.rejects(
      call(
        roomNotesRouter.save,
        { roomId: f.roomId, playerId: first.id, content: "字".repeat(200_001) },
        { context: firstContext },
      ),
      { code: "BAD_REQUEST" },
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
