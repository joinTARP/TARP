import type { ParsedModuleDocument } from "@jointarp/module/document-evaluator";
import type { ModuleDocument } from "@jointarp/module/module-document";

export type DocumentSnapshotItem = ParsedModuleDocument | ModuleDocument;
export type DocumentWorkerCommand =
  | {
      op: "sync";
      full: boolean;
      revision: number;
      items: readonly DocumentSnapshotItem[];
      removedPaths: readonly string[];
    }
  | { op: "read" | "name"; path: string }
  | { op: "draft"; item: ParsedModuleDocument };
export type DocumentWorkerRequest = {
  id: number;
  generation: number;
  command: DocumentWorkerCommand;
};
export type DocumentWorkerResponse =
  | { ready: true }
  | { id: number; generation: number; document?: ModuleDocument; error?: string };

/** 与原求值器相同的异步读取契约，生命周期由房间连接管理。 */
export interface RendererDocumentEvaluator {
  setSnapshot(revision: number, items: readonly DocumentSnapshotItem[]): void;
  updateSnapshot(
    revision: number,
    items: readonly DocumentSnapshotItem[],
    removedPaths?: readonly string[],
  ): void;
  readDocument(path: string): Promise<ModuleDocument>;
  readDocumentName(path: string): Promise<ModuleDocument>;
  evaluateDocument(item: ParsedModuleDocument): Promise<ModuleDocument>;
  dispose?(): void;
}
