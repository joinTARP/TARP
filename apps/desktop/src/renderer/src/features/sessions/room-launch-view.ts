import type { RoomEntity, RoomLaunchState } from "@jointarp/core/shared/room-state";
import type { WorkbenchView } from "@jointarp/module/creation-workbench";
import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@shared/desktop-api";

/** 仅供下一条命令使用，不作为界面展示缓存。 */
export type LaunchCommandProgress = Pick<RoomLaunchState, "room" | "progress"> & { roomId: string };
export function mergeLaunchCommandProgress(
  current: LaunchCommandProgress,
  roomId: string,
  next: Pick<RoomLaunchState, "room" | "progress">,
): LaunchCommandProgress {
  if (current.roomId !== roomId) return current;
  return {
    roomId,
    room: next.room.revision > current.room.revision ? next.room : current.room,
    progress: next.progress.revision > current.progress.revision ? next.progress : current.progress,
  };
}

/** 只预取正在展示的阶段；同一引用对应同一稳定实体。 */
export function workbenchReferenceEntities(
  launch: RoomLaunchState | null,
  entities: Readonly<Record<string, RoomEntity>>,
): RoomEntity[] {
  const stage = launch?.progress.workbench?.stage ?? 0;
  const paths = new Map(
    Object.values(entities).map((entity) => [documentIdentity(entity.document.path), entity]),
  );
  const selected = new Map<string, RoomEntity>();
  for (const item of launch?.workbench?.items ?? []) {
    if (item.kind !== "reference" || item.stage !== stage) continue;
    for (const option of item.options) {
      const entity = paths.get(documentIdentity(option.value));
      if (entity) selected.set(entity.id, entity);
    }
  }
  return [...selected.values()];
}

/** 选项背景来自已合并的本地文档，远端工作台只传引用和选择结果。 */
export function restoreWorkbenchReferencePreviews(
  workbench: WorkbenchView,
  stage: number,
  documents: readonly ModuleDocument[],
): WorkbenchView {
  const paths = new Map(documents.map((document) => [documentIdentity(document.path), document]));
  return {
    ...workbench,
    items: workbench.items.map((item) =>
      item.kind === "reference" && item.stage === stage
        ? {
            ...item,
            options: item.options.map((option) => ({
              ...option,
              body: paths.get(documentIdentity(option.value))?.body,
            })),
          }
        : item,
    ),
  };
}
