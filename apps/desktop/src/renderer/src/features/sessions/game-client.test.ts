import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { SteeringSnapshot } from "@tarp/core/shared/game";

import { errorMessage, type GameClient } from "./game-client";
import { RoomChatStore } from "./room-chat-store";

test("业务错误原文保留，oRPC 的英文状态名不直接展示", () => {
  assert.equal(errorMessage(new Error("请先确认角色并完成开场")), "请先确认角色并完成开场");
  assert.equal(errorMessage(new Error("Internal Server Error")), "操作没有完成，请再试一次。");
  assert.equal(errorMessage({ message: "Precondition Failed" }), "操作没有完成，请再试一次。");
  assert.equal(errorMessage("失败"), "操作没有完成，请再试一次。");
});

test("插话删除通知先于旧 RPC 响应时，旧快照不能让卡片复活", () => {
  const store = new RoomChatStore({} as GameClient, "room");
  const entry = {
    id: "entry",
    playerId: "player",
    nickname: "玩家",
    text: "补充",
    createdAt: "now",
    sequence: 1,
    state: "pending" as const,
  };
  const queued: SteeringSnapshot = { enabled: true, revision: 1, entries: [entry] };
  store.acceptSteering(queued);
  store.applyEvent({
    type: "steering",
    cursor: 2,
    snapshot: { enabled: true, revision: 2, entries: [] },
  });
  store.acceptSteering(queued);
  assert.equal(store.getSnapshot().steering.entries.length, 0);
  assert.equal(store.getSnapshot().steering.revision, 2);
  store.acceptSteering({ ...queued, revision: 3 });
  assert.equal(store.getSnapshot().steering.entries.length, 1);
});
