import { randomUUID } from "node:crypto";

import { Encoder } from "@colyseus/schema";
import { ORPCError } from "@orpc/server";

import {
  ROOM_MAX_FRAME_BYTES,
  ROOM_PROTOCOL_VERSION,
  ROOM_SCHEMA_VERSION,
  type RoomProjection,
  type RoomBaseline,
  type RoomStateFrame,
} from "../../shared/room-state";
import { EntityStateSchema, RoomStateSchema, stableJson } from "../../shared/room-state-schema";

/** 每个订阅独立基线；永不把某个客户端的 patch 交给另一个 Decoder。 */
export class RoomStateEncoder {
  private state = new RoomStateSchema();
  private encoder = new Encoder(this.state);
  private streamId = randomUUID();
  private seq = 0;
  private overlayRevision: number | undefined;
  private overlayBytes = 0;
  private overlayEntries = new Map<string, { value: unknown; bytes: number }>();
  constructor(private baseline: RoomBaseline) {}

  update(replica: RoomProjection): RoomStateFrame | undefined {
    const overlays = replica.overlays;
    // 约束累积状态，避免连续小 patch 把房间增长到无法重新发送快照。
    // 每条字符串额外预留 Map 操作、索引及 Schema 引用的编码空间。
    let snapshotBytes = 128;
    const account = (key: string, value: string) => {
      snapshotBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 32;
      if (snapshotBytes > ROOM_MAX_FRAME_BYTES)
        throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间状态超过同步容量，无法完整同步" });
    };
    this.state.sections.set("documentRevision", stableJson(replica.documentRevision));
    for (const [key, value] of Object.entries(replica.sections)) {
      const json = stableJson(value);
      account(key, json);
      if (this.state.sections.get(key) !== json) this.state.sections.set(key, json);
    }
    const sectionBytes = snapshotBytes;
    if (replica.overlayRevision !== this.overlayRevision) {
      for (const id of this.state.entities.keys())
        if (!Object.hasOwn(overlays, id)) {
          this.state.entities.delete(id);
          this.overlayBytes -= this.overlayEntries.get(id)?.bytes ?? 0;
          this.overlayEntries.delete(id);
        }
      for (const [id, overlay] of Object.entries(overlays)) {
        const previous = this.overlayEntries.get(id);
        if (previous?.value === overlay) continue;
        const startBytes = snapshotBytes;
        let target = this.state.entities.get(id);
        if (!target) {
          target = new EntityStateSchema();
          this.state.entities.set(id, target);
        }
        const { fields: _fields, ...header } = overlay;
        const jsonHeader = stableJson(header);
        account(id, jsonHeader);
        if (target.header !== jsonHeader) target.header = jsonHeader;
        for (const key of target.fields.keys())
          if (!Object.hasOwn(overlay.fields, key)) target.fields.delete(key);
        for (const [key, value] of Object.entries(overlay.fields)) {
          const json = stableJson(value);
          account(key, json);
          if (target.fields.get(key) !== json) target.fields.set(key, json);
        }
        const size = snapshotBytes - startBytes;
        this.overlayBytes += size - (previous?.bytes ?? 0);
        this.overlayEntries.set(id, { value: overlay, bytes: size });
      }
      this.overlayRevision = replica.overlayRevision;
    }
    if (sectionBytes + this.overlayBytes > ROOM_MAX_FRAME_BYTES)
      throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间状态超过同步容量" });
    const snapshot = this.seq === 0;
    const bytes = snapshot ? this.encoder.encodeAll() : this.encoder.encode();
    if (bytes.length > ROOM_MAX_FRAME_BYTES)
      throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "房间状态超过同步容量，无法完整同步" });
    // base64 字符串独立持有内容，不保留 Encoder 可复用的缓冲区。
    const payload = Buffer.from(bytes).toString("base64");
    this.encoder.discardChanges();
    if (!snapshot && !bytes.length) return;
    const baseSeq = this.seq++;
    const common = {
      protocolVersion: ROOM_PROTOCOL_VERSION,
      schemaVersion: ROOM_SCHEMA_VERSION,
      baselineVersion: this.baseline.version,
      streamId: this.streamId,
      seq: this.seq,
      payload,
    } as const;
    return snapshot
      ? { ...common, kind: "snapshot", seq: 1 }
      : { ...common, kind: "patch", baseSeq };
  }
}
