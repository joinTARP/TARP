import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { Decoder } from "@colyseus/schema";

import { roomEntityOverlays, applyRoomEntityOverlay } from "../../shared/room-state-overlay";
import { RoomStateSchema } from "../../shared/room-state-schema";
import {
  createRoomBaseline,
  createRoomReplica,
  createRoomEncoder,
} from "../../testing/room-replica";

test("原始文档协议按顶层对象覆盖并保留正文与幕后字段", () => {
  const replica = createRoomReplica();
  const baseline = createRoomBaseline(replica.entities);
  const original = replica.entities.monster!;
  replica.entities = {
    ...replica.entities,
    monster: {
      ...original,
      document: {
        ...original.document,
        name: "原始名称",
        body: "完整正文",
        values: { secret: "幕后字段", inventory: [{ count: 0 }] },
      },
    },
  };
  const overlay = roomEntityOverlays(baseline, replica.entities).monster!;
  assert.equal(Object.hasOwn(overlay.document, "values"), false);
  assert.deepEqual(overlay.fields, { secret: "幕后字段", inventory: [{ count: 0 }] });
  const restored = applyRoomEntityOverlay("monster", baseline.entities.monster, overlay)!;
  assert.equal(restored.document.body, "完整正文");
  assert.equal(restored.document.values?.hp, undefined);
  assert.equal(restored.document.values?.secret, "幕后字段");
  const encoder = createRoomEncoder(baseline);
  const frame = encoder.update(replica)!;
  assert.equal(frame.protocolVersion, 1);
  assert.equal(frame.schemaVersion, "game-document-overlay-v1");
  const wire = new RoomStateSchema();
  new Decoder(wire).decode(Buffer.from(frame.payload, "base64"));
  assert.equal(JSON.parse(wire.entities.get("monster")!.header).document.body, "完整正文");
});

test("恢复基线删除累计覆盖，删除与新增原始文档可应用", () => {
  const replica = createRoomReplica();
  const baseline = createRoomBaseline(replica.entities);
  const entity = replica.entities.monster!;
  const revised = { ...entity, revision: 8 };
  assert.deepEqual(
    Object.keys(roomEntityOverlays(baseline, { ...replica.entities, monster: revised })),
    [],
  );
  const deleted = roomEntityOverlays(baseline, {});
  assert.equal(applyRoomEntityOverlay("monster", entity, deleted.monster!), undefined);
  const added = roomEntityOverlays(createRoomBaseline(), replica.entities);
  assert.deepEqual(applyRoomEntityOverlay("monster", undefined, added.monster!), entity);
});

test("每个订阅独立序号，大型单字段可完整同步", () => {
  const replica = createRoomReplica();
  const baseline = createRoomBaseline(replica.entities);
  replica.entities = {
    ...replica.entities,
    monster: {
      ...replica.entities.monster!,
      document: { ...replica.entities.monster!.document, body: "字".repeat(30000) },
    },
  };
  const a = createRoomEncoder(baseline);
  const b = createRoomEncoder(baseline);
  const first = a.update(replica)!;
  assert.equal(first.seq, 1);
  assert.equal(b.update(replica)!.seq, 1);
  assert.equal(a.update(replica), undefined);
  replica.documentRevision++;
  assert.equal(a.update(replica)!.seq, 2);
  assert.equal(b.update(replica)!.seq, 2);
});

test("HP字段变化不重复传输未修改的大型原始字段", () => {
  const replica = createRoomReplica();
  const original = replica.entities.monster!;
  const values = { hp: 10, longText: "未变文字".repeat(30000) };
  replica.entities = {
    monster: { ...original, document: { ...original.document, values } },
  };
  const baseline = createRoomBaseline(replica.entities);
  const fields = { ...values, hp: 9 };
  replica.entities = {
    monster: {
      ...replica.entities.monster!,
      document: { ...original.document, values: fields },
    },
  };
  const overlay = roomEntityOverlays(baseline, replica.entities).monster!;
  assert.deepEqual(overlay.fields, { hp: 9 });
  assert.equal(Object.hasOwn(overlay.document, "values"), false);
  const frame = createRoomEncoder(baseline).update(replica)!;
  assert.ok(Buffer.from(frame.payload, "base64").length < 5000);
  assert.equal(
    applyRoomEntityOverlay("monster", baseline.entities.monster, overlay)!.document.values
      ?.longText,
    values.longText,
  );
});

test("角色归属通过明确字段绑定和解除，文档内容保持独立", () => {
  const replica = createRoomReplica();
  const original = replica.entities.monster!;
  const character = {
    id: "角色身份",
    typeId: "怪物",
    playerId: "玩家",
    sourcePath: original.document.path,
    retired: false,
    version: 1,
  };
  const bound = { ...original, character };
  const baseline = createRoomBaseline({ monster: bound });
  const removed = roomEntityOverlays(baseline, { monster: original }).monster!;
  assert.equal(removed.character, null);
  assert.deepEqual(removed.fields, {});
  assert.deepEqual(removed.document, {});
  assert.equal(removed.revision, original.revision);
  const restored = applyRoomEntityOverlay("monster", baseline.entities.monster, removed)!;
  assert.equal(restored.character, undefined);
  assert.deepEqual(restored.document, original.document);
  const binding = roomEntityOverlays(createRoomBaseline({ monster: original }), {
    monster: bound,
  }).monster!;
  assert.deepEqual(binding.character, character);
  assert.deepEqual(applyRoomEntityOverlay("monster", original, binding), bound);
});
