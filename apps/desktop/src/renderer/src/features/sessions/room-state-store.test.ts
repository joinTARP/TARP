import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { Decoder } from "@colyseus/schema";
import { ROOM_MAX_FRAME_BYTES, type RoomReplica } from "@jointarp/core/shared/room-state";
import { RoomStateSchema } from "@jointarp/core/shared/room-state-schema";
import {
  createRoomReplica,
  createRoomBaseline,
  createRoomEncoder,
} from "@jointarp/core/testing/room-replica";

import { RoomStateStore } from "./room-state-store";
function setFields(state: RoomReplica, fields: Record<string, unknown>) {
  const entity = state.entities.monster;
  state.entities = {
    ...state.entities,
    monster: { ...entity, document: { ...entity.document, values: fields } },
  };
}

test("完整快照、字段增量、缺失字段删除及实体删除重建", () => {
  const encoder = createRoomEncoder(createRoomBaseline());
  const store = new RoomStateStore(createRoomBaseline());
  const state = createRoomReplica();
  const snapshot = encoder.update(state)!;
  store.apply(snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSnapshot())), state);
  assert.equal(encoder.update(state), undefined);
  setFields(state, { hp: 0, inventory: [{ count: 2, item: "药水" }] });
  const patch = encoder.update(state)!;
  assert.equal(patch.kind, "patch");
  assert.ok(patch.payload.length < snapshot.payload.length / 4);
  assert.ok(!atob(patch.payload).includes("trap"));
  store.apply(patch);
  assert.deepEqual(store.getSnapshot()!.entities.trap, state.entities.trap);
  assert.equal(store.getSnapshot()!.entities.monster.document.values.hp, 0);
  assert.ok(!Object.hasOwn(store.getSnapshot()!.entities.monster.document.values, "option"));
  assert.equal(store.apply(patch), false);
  const alive = state.entities.monster;
  state.entities = { trap: state.entities.trap };
  store.apply(encoder.update(state)!);
  assert.ok(!store.getSnapshot()!.entities.monster);
  state.entities = {
    ...state.entities,
    monster: {
      ...alive,
      document: { ...alive.document, values: { hp: 9, inventory: [], option: "changed" } },
    },
  };
  store.apply(encoder.update(state)!);
  assert.deepEqual(JSON.parse(JSON.stringify(store.getSnapshot())), state);
});

test("缺帧、错误版本和解码失败保留上一份已发布快照，重连使用新基线", () => {
  const encoder = createRoomEncoder(createRoomBaseline());
  const store = new RoomStateStore(createRoomBaseline());
  const state = createRoomReplica();
  const initial = encoder.update(state)!;
  store.apply(initial);
  const previous = structuredClone(store.getSnapshot());
  setFields(state, { hp: 8 });
  encoder.update(state);
  setFields(state, { hp: 3 });
  const gap = encoder.update(state)!;
  assert.throws(() => store.apply(gap), /不连续/);
  assert.deepEqual(structuredClone(store.getSnapshot()), previous);
  assert.throws(() => store.apply({ ...initial, schemaVersion: "wrong" } as never));
  assert.deepEqual(structuredClone(store.getSnapshot()), previous);
  store.resetBaseline();
  const replacement = createRoomEncoder(createRoomBaseline()).update(state)!;
  assert.throws(() => store.apply({ ...replacement, payload: "!!!" }));
  assert.deepEqual(structuredClone(store.getSnapshot()), previous);
  store.apply(replacement);
  assert.equal(store.getSnapshot()!.entities.monster.document.values.hp, 3);
  assert.throws(() => store.apply(gap), /不连续/);
  const valid = structuredClone(store.getSnapshot());
  store.resetBaseline();
  const invalid = createRoomReplica();
  invalid.entities.monster.revision = -1;
  const invalidFrame = createRoomEncoder(createRoomBaseline()).update(invalid)!;
  assert.throws(() => store.apply(invalidFrame), /实体状态无效/);
  assert.deepEqual(structuredClone(store.getSnapshot()), valid);
});

test("规范化对象键顺序不产生更新，编码缓冲区不会改写已发帧", () => {
  const state = createRoomReplica();
  const encoder = createRoomEncoder(createRoomBaseline());
  const initial = encoder.update(state)!;
  const initialPayload = initial.payload;
  setFields(state, { option: null, inventory: [{ count: 1, item: "药水" }], hp: 10 });
  assert.equal(encoder.update(state), undefined);
  for (let hp = 0; hp < 2; hp++) {
    setFields(state, { hp });
    encoder.update(state);
  }
  const store = new RoomStateStore(createRoomBaseline());
  store.apply(initial);
  assert.equal(initial.payload, initialPayload);
  assert.equal(store.getSnapshot()!.entities.monster.document.values.hp, 10);
});

test("连续小更新也受完整快照容量约束", () => {
  const encoder = createRoomEncoder(createRoomBaseline());
  const state = createRoomReplica();
  const maximum = Math.floor(ROOM_MAX_FRAME_BYTES / (63 * 1024 + 80));
  const fields = Object.fromEntries(
    Array.from({ length: maximum - 1 }, (_, i) => [`field${i}`, "x".repeat(63 * 1024)]),
  );
  setFields(state, fields);
  encoder.update(state);
  fields[`field${maximum - 1}`] = "x".repeat(63 * 1024);
  encoder.update(state);
  fields.overflow = "x".repeat(63 * 1024);
  assert.throws(() => encoder.update(state), /超过同步容量/);
});

test("首帧仅包含相对模组的累计修改；恢复原值、移除字段与删除实体可正确合并", () => {
  const state = createRoomReplica();
  const baseline = createRoomBaseline(state.entities);
  const encoder = createRoomEncoder(baseline);
  const store = new RoomStateStore(baseline);
  const wire = new Decoder(new RoomStateSchema());
  const first = encoder.update(state)!;
  wire.decode(Buffer.from(first.payload, "base64"));
  assert.equal(wire.state.entities.size, 0, "未修改的模组实体不进首帧");
  store.apply(first);
  setFields(state, { ...state.entities.monster.document.values, hp: 2 });
  const patch = encoder.update(state)!;
  wire.decode(Buffer.from(patch.payload, "base64"));
  assert.deepEqual([...wire.state.entities.get("monster")!.fields], [["hp", "2"]]);
  assert.equal(wire.state.entities.has("trap"), false);
  store.apply(patch);
  assert.equal(store.getSnapshot()!.entities.monster.document.values.hp, 2);
  assert.deepEqual(
    store.getSnapshot()!.entities.monster.document.values.inventory,
    baseline.entities.monster.document.values.inventory,
  );

  // 晚加入/重启后首次快照仍只传累计 HP 修改，不依赖上一条连接的内存。
  const rejoin = createRoomEncoder(baseline).update(state)!;
  const rejoinWire = new Decoder(new RoomStateSchema());
  rejoinWire.decode(Buffer.from(rejoin.payload, "base64"));
  assert.equal(rejoinWire.state.entities.size, 1);
  assert.deepEqual([...rejoinWire.state.entities.get("monster")!.fields], [["hp", "2"]]);
  store.resetBaseline();
  store.apply(rejoin);
  assert.equal(store.getSnapshot()!.entities.monster.document.values.hp, 2);
  assert.throws(
    () => new RoomStateStore({ ...baseline, version: "1".repeat(64) }).apply(rejoin),
    /基线/,
  );

  const resumed = new RoomStateStore(baseline);
  resumed.apply(first);
  resumed.apply(patch);
  setFields(state, structuredClone(baseline.entities.monster.document.values));
  const reset = encoder.update(state)!;
  wire.decode(Buffer.from(reset.payload, "base64"));
  assert.equal(wire.state.entities.size, 0, "恢复原值后删除覆盖");
  resumed.apply(reset);
  assert.deepEqual(resumed.getSnapshot()!.entities.monster, baseline.entities.monster);
  setFields(state, { hp: 10, inventory: [] });
  resumed.apply(encoder.update(state)!);
  assert.ok(!Object.hasOwn(resumed.getSnapshot()!.entities.monster.document.values, "option"));
  state.entities = { monster: state.entities.monster };
  resumed.apply(encoder.update(state)!);
  assert.equal(resumed.getSnapshot()!.entities.trap, undefined);
  state.entities = structuredClone(baseline.entities);
  resumed.apply(encoder.update(state)!);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.getSnapshot()!.entities)), baseline.entities);
});

test("角色归属变更与解除不改文档内容，不推进文档版本", () => {
  const state = createRoomReplica();
  const baseline = createRoomBaseline(state.entities);
  const encoder = createRoomEncoder(baseline);
  const store = new RoomStateStore(baseline);
  store.apply(encoder.update(state)!);
  const initial = store.getSnapshot()!;
  const document = initial.entities.monster.document;
  state.entities = {
    ...state.entities,
    monster: {
      ...state.entities.monster,
      character: {
        id: "角色",
        typeId: "怪物",
        playerId: "玩家",
        sourcePath: document.path,
        version: 1,
      },
    },
  };
  store.apply(encoder.update(state)!);
  const bound = store.getSnapshot()!;
  assert.equal(bound.entities.monster.character?.playerId, "玩家");
  assert.deepEqual(bound.entities.monster.document, document);
  assert.equal(bound.documentRevision, initial.documentRevision);
  const { character: _character, ...released } = state.entities.monster;
  state.entities = { ...state.entities, monster: released };
  store.apply(encoder.update(state)!);
  assert.equal(store.getSnapshot()!.entities.monster.character, undefined);
  assert.deepEqual(store.getSnapshot()!.entities.monster.document, document);
  assert.equal(store.getSnapshot()!.documentRevision, initial.documentRevision);
});
