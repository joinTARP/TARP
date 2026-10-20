import { join } from "node:path";

import { forgetRoomProjection } from "../game/room-state-projection";
import type { SessionDatabase } from "../storage/session-database";
import { forgetFrozenModule } from "./frozen-module";
import { forgetGameDocumentViews } from "./game-document-views";
import { retainRoomChanges } from "./room-changes";
import { forgetStateVersions } from "./state-version";

const connections = new Map<string, number>();
// 短期命令之间保留轻量版本，避免一次文档操作结束后下次读取立即退回版本 1。
// 完整模组与计算缓存不进入此窗口；长期不用的房间版本最多保留 32 份。
const idleVersions = new Set<string>();

function releaseCachedDocuments(directory: string) {
  forgetFrozenModule(join(directory, "module"));
  forgetGameDocumentViews(join(directory, "game"));
  forgetRoomProjection(directory);
}

/** 显式关闭或删除时释放全部资源；仍被其他连接使用的房间不能重置版本。 */
export function forgetRoomResources(directory: string): void {
  if (connections.has(directory)) return;
  releaseCachedDocuments(directory);
  idleVersions.delete(directory);
  forgetStateVersions(directory);
}

/** 所有房间连接共用的资源生命周期，覆盖正常关闭、只读访问和打开失败。 */
export function retainRoomResources(db: SessionDatabase, directory: string): void {
  idleVersions.delete(directory);
  connections.set(directory, (connections.get(directory) ?? 0) + 1);
  const releaseChanges = retainRoomChanges(directory);
  db.onClose(() => {
    const remaining = connections.get(directory)! - 1;
    if (remaining) connections.set(directory, remaining);
    else connections.delete(directory);
    releaseChanges();
    if (remaining) return;
    releaseCachedDocuments(directory);
    idleVersions.add(directory);
    while (idleVersions.size > 32) {
      const oldest = idleVersions.values().next().value!;
      idleVersions.delete(oldest);
      forgetStateVersions(oldest);
    }
  });
}
