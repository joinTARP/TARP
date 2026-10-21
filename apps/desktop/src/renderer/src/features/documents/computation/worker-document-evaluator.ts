import type { ParsedModuleDocument } from "@jointarp/module/document-evaluator";
import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleDocument } from "@jointarp/module/module-document";

import type {
  DocumentSnapshotItem,
  DocumentWorkerCommand,
  DocumentWorkerResponse,
  RendererDocumentEvaluator,
} from "./document-worker-protocol";

type ComputationWorker = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror"
>;
export interface WorkerEvaluatorOptions {
  createWorker?: () => ComputationWorker;
  startupTimeoutMs?: number;
  computationTimeoutMs?: number;
}
const identity = (item: DocumentSnapshotItem) =>
  documentIdentity("identity" in item ? item.document.path : item.path);

/** renderer 端的快照副本仅用于 Worker 重建；求值、引用图及结果缓存在 Worker 内。 */
export class WorkerDocumentEvaluator implements RendererDocumentEvaluator {
  private records = new Map<string, DocumentSnapshotItem>();
  private dirty = new Set<string>();
  private fullSnapshot = true;
  private revision = -1;
  private generation = 0;
  private syncedGeneration = -1;
  private worker?: ComputationWorker;
  private ready?: Promise<void>;
  private sequence = 0;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<
    number,
    {
      resolve(response: Exclude<DocumentWorkerResponse, { ready: true }>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private rejectStartup?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: WorkerEvaluatorOptions = {}) {}

  setSnapshot(revision: number, items: readonly DocumentSnapshotItem[]): void {
    this.assertOpen();
    this.records = new Map(structuredClone(items).map((item) => [identity(item), item]));
    this.revision = revision;
    this.generation++;
    this.fullSnapshot = true;
    this.dirty.clear();
  }
  updateSnapshot(
    revision: number,
    items: readonly DocumentSnapshotItem[],
    removedPaths: readonly string[] = [],
  ): void {
    this.assertOpen();
    for (const path of removedPaths) {
      const key = documentIdentity(path);
      this.records.delete(key);
      this.dirty.add(key);
    }
    for (const item of structuredClone(items)) {
      const key = identity(item);
      this.records.set(key, item);
      this.dirty.add(key);
    }
    this.revision = revision;
    this.generation++;
  }
  readDocument(path: string): Promise<ModuleDocument> {
    return this.read({ op: "read", path });
  }
  readDocumentName(path: string): Promise<ModuleDocument> {
    return this.read({ op: "name", path });
  }
  evaluateDocument(item: ParsedModuleDocument): Promise<ModuleDocument> {
    return this.read({ op: "draft", item: structuredClone(item) });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.fail(new Error("文档计算已关闭"));
    this.records.clear();
    this.dirty.clear();
  }
  private assertOpen() {
    if (this.disposed) throw new Error("文档计算已关闭");
  }
  private assertCurrent(generation: number) {
    this.assertOpen();
    if (generation !== this.generation) throw new Error("文档资料版本已变化");
  }
  private fail(error: Error) {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
    this.fullSnapshot = true;
    this.syncedGeneration = -1;
    clearTimeout(this.startupTimer);
    this.rejectStartup?.(error);
    this.rejectStartup = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  private start(): Promise<void> {
    this.assertOpen();
    if (this.ready) return this.ready;
    const worker =
      this.options.createWorker?.() ??
      new Worker(new URL("./document-worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.fullSnapshot = true;
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectStartup = reject;
      this.startupTimer = setTimeout(
        () => this.fail(new Error("计算环境启动超时，请重试。")),
        this.options.startupTimeoutMs ?? 10_000,
      );
      worker.onmessage = ({ data }: MessageEvent<DocumentWorkerResponse>) => {
        if (this.worker !== worker) return;
        if ("ready" in data) {
          clearTimeout(this.startupTimer);
          this.rejectStartup = undefined;
          resolve();
          return;
        }
        const request = this.pending.get(data.id);
        if (!request) return;
        this.pending.delete(data.id);
        clearTimeout(request.timer);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        if (this.worker === worker) this.fail(new Error(`计算环境运行失败：${event.message}`));
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.fail(new Error("计算结果传输失败"));
      };
    });
    return this.ready;
  }
  private request(command: DocumentWorkerCommand, generation: number, timeoutMs: number) {
    return new Promise<Exclude<DocumentWorkerResponse, { ready: true }>>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.fail(new Error("文档计算超时，计算环境已重置，请检查公式或重试。")),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker!.postMessage({ id, generation, command });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private async sync(generation: number) {
    if (!this.fullSnapshot && this.syncedGeneration === generation) return;
    const full = this.fullSnapshot;
    const keys = [...this.dirty];
    const items = full
      ? [...this.records.values()]
      : keys.flatMap((key) => (this.records.has(key) ? [this.records.get(key)!] : []));
    const removedPaths = full ? [] : keys.filter((key) => !this.records.has(key));
    this.fullSnapshot = false;
    this.dirty.clear();
    try {
      const response = await this.request(
        { op: "sync", full, revision: this.revision, items, removedPaths },
        generation,
        5000,
      );
      if (response.generation !== generation) throw new Error("文档资料版本已变化");
      this.syncedGeneration = generation;
    } catch (error) {
      this.fullSnapshot = true;
      throw error;
    }
  }
  private read(command: DocumentWorkerCommand): Promise<ModuleDocument> {
    const generation = this.generation;
    const run = async () => {
      this.assertCurrent(generation);
      await this.start();
      this.assertCurrent(generation);
      await this.sync(generation);
      this.assertCurrent(generation);
      const reply = await this.request(
        command,
        generation,
        this.options.computationTimeoutMs ?? 1000,
      );
      this.assertCurrent(generation);
      if (reply.generation !== generation || !reply.document) throw new Error("无效的文档计算结果");
      return reply.document;
    };
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    return pending;
  }
}
