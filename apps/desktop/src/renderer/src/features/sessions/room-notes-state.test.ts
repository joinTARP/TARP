import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import {
  clearNotesDraft,
  enqueueNotes,
  hasPendingNotes,
  readNotesDraft,
  roomNotesKey,
  writeNotesDraft,
} from "./room-notes-state";

function withStorage(run: (values: Map<string, string>) => void, writable = true) {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (!writable) throw new Error("存储不可写");
          values.set(key, value);
        },
        removeItem: (key: string) => {
          if (!writable) throw new Error("存储不可写");
          values.delete(key);
        },
      },
    },
  });
  try {
    run(values);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("草稿按房间和玩家隔离，较早的保存回调不会清掉较新的草稿", () => {
  withStorage((values) => {
    const roomId = randomUUID();
    const first = roomNotesKey(roomId, randomUUID());
    const second = roomNotesKey(roomId, randomUUID());
    const anotherRoom = roomNotesKey(randomUUID(), first.split(":")[1]);
    writeNotesDraft(first, "甲的草稿");
    writeNotesDraft(second, "乙的草稿");
    assert.equal(readNotesDraft(first), "甲的草稿");
    assert.equal(readNotesDraft(second), "乙的草稿");
    assert.equal(readNotesDraft(anotherRoom), undefined);
    assert.equal(values.get(`tarp:room-notes-draft:v2:${first}`), "甲的草稿");
    writeNotesDraft(first, "甲的新草稿");
    clearNotesDraft(first, "甲的草稿");
    assert.equal(readNotesDraft(first), "甲的新草稿");
    clearNotesDraft(first, "甲的新草稿");
    assert.equal(readNotesDraft(first), undefined);
    assert.equal(readNotesDraft(second), "乙的草稿");
    const stored = roomNotesKey(roomId, randomUUID());
    values.set(`tarp:room-notes-draft:v2:${stored}`, "重启后的草稿");
    assert.equal(readNotesDraft(stored), "重启后的草稿");
  });
});

test("存储不可写时按玩家保留进程内草稿", () => {
  withStorage(() => {
    const roomId = randomUUID();
    const first = roomNotesKey(roomId, randomUUID());
    const second = roomNotesKey(roomId, randomUUID());
    writeNotesDraft(first, "甲的离线草稿");
    assert.equal(readNotesDraft(first), "甲的离线草稿");
    assert.equal(readNotesDraft(second), undefined);
    writeNotesDraft(second, "乙的离线草稿");
    clearNotesDraft(first, "甲的离线草稿");
    assert.equal(readNotesDraft(first), undefined);
    assert.equal(readNotesDraft(second), "乙的离线草稿");
  }, false);
});

test("同一玩家笔记请求串行执行，另一玩家的队列独立，失败后仍能重试", async () => {
  const roomId = randomUUID();
  const first = roomNotesKey(roomId, randomUUID());
  const second = roomNotesKey(roomId, randomUUID());
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = enqueueNotes(first, async () => {
    events.push("甲保存开始");
    await blocked;
    events.push("甲保存完成");
  });
  const read = enqueueNotes(first, async () => {
    events.push("甲读取");
  });
  await enqueueNotes(second, async () => {
    events.push("乙读取");
  });
  assert.deepEqual(events, ["甲保存开始", "乙读取"]);
  assert.equal(hasPendingNotes(first), true);
  release();
  await Promise.all([save, read]);
  assert.deepEqual(events, ["甲保存开始", "乙读取", "甲保存完成", "甲读取"]);
  assert.equal(hasPendingNotes(first), false);
  await assert.rejects(
    enqueueNotes(first, async () => {
      throw new Error("保存失败");
    }),
    /保存失败/,
  );
  assert.equal(await enqueueNotes(first, async () => "重试成功"), "重试成功");
});
