import { onTestFinished, test } from "bun:test";
import { strict as assert } from "node:assert";

import { DocumentEvaluator, type ParsedModuleDocument } from "@jointarp/module/document-evaluator";
import { documentIdentity } from "@jointarp/module/document-path";
import { validateDocumentLayout, validateDocumentType } from "@jointarp/module/document-type";

import { WorkerDocumentEvaluator, type WorkerEvaluatorOptions } from "./worker-document-evaluator";

function evaluator(options: WorkerEvaluatorOptions = {}) {
  const value = new WorkerDocumentEvaluator(options);
  onTestFinished(() => value.dispose());
  return value;
}
function item(
  path: string,
  fields: Record<string, unknown>,
  values: Record<string, unknown> = {},
): Omit<ParsedModuleDocument, "documentType"> & {
  documentType: ParsedModuleDocument["documentType"];
} {
  const documentType = validateDocumentType(path.split("/")[0]!, { fields });
  return {
    identity: documentIdentity(path),
    documentType,
    values,
    document: { path, title: "测试", docType: documentType.id, valid: true, values },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Worker 的多级引用、实例定义、展示错误与增量删除保持文档求值语义", async () => {
  const clock = item(
    "时钟/当前.json",
    { elapsed: { type: "number", mutable: true } },
    { elapsed: 5 },
  );
  const definition = item(
    "道具/计时器.json",
    { factor: { type: "number", mutable: true } },
    {
      factor: 2,
      instance: {
        fields: {
          budget: { type: "number", mutable: true, required: true },
          remaining: {
            type: "number",
            compute: "($item.budget-load($self.world).elapsed)*$definition.factor",
          },
        },
        display: ["remaining"],
      },
    },
  );
  const holder = item(
    "角色/甲.json",
    {
      world: { type: "reference", targets: ["时钟"], visibility: "gm" },
      items: {
        type: "list",
        item: {
          type: "object",
          instance: { referenceField: "definition", stateField: "state" },
          fields: { definition: { type: "reference", targets: ["道具"], required: true } },
        },
      },
      total: { type: "number", compute: "sum($self.items, row => row.state.remaining)" },
      broken: { type: "number", compute: '"wrong"' },
    },
    {
      world: "时钟/当前",
      items: [
        { definition: "道具/计时器", state: { budget: 20 } },
        { definition: "道具/计时器", state: { budget: 30 } },
      ],
    },
  );
  holder.documentType = {
    ...holder.documentType,
    layout: validateDocumentLayout(holder.documentType, {
      displayFields: {
        summary: { type: "text", label: "汇总", compute: "self => String(self.total)" },
        failed: {
          type: "number",
          label: "错误",
          compute: "self => {try{return self.broken}catch{return 1}}",
        },
      },
    }),
  };
  const native = new DocumentEvaluator(),
    worker = evaluator();
  const items = [holder, clock, definition];
  native.setSnapshot(1, items);
  worker.setSnapshot(1, items);
  const original = await worker.readDocument(holder.document.path);
  assert.deepEqual(original, await native.readDocument(holder.document.path));
  assert.equal(original.values?.total, 80);
  assert.equal(original.displayValues?.summary, "80");
  assert.equal(original.displayValues?.failed, null);
  assert.ok(original.displayErrors?.failed);
  const changed = { ...clock, values: { elapsed: 10 } };
  native.updateSnapshot(2, [changed]);
  worker.updateSnapshot(2, [changed]);
  const updated = await worker.readDocument(holder.document.path);
  assert.deepEqual(updated, await native.readDocument(holder.document.path));
  assert.equal(updated.values?.total, 60);
  native.updateSnapshot(3, [], [definition.document.path]);
  worker.updateSnapshot(3, [], [definition.document.path]);
  assert.deepEqual(
    await worker.readDocument(holder.document.path),
    await native.readDocument(holder.document.path),
  );
  assert.equal((await worker.readDocument(holder.document.path)).values?.total, null);
});

test("客户端两种公式无法获取宿主能力或修改原型，批次不保留全局状态", async () => {
  const probe = item("探针/一.json", {
    result: {
      type: "text",
      compute:
        '[typeof Bun,typeof process,typeof fetch,typeof Worker,typeof document,typeof indexedDB].join(",")',
    },
    escape: { type: "text", compute: '({}).constructor.constructor("return typeof process")()' },
    readonly: {
      type: "text",
      compute: "(()=>{try{$raw.injected=1}catch{}return String($raw.injected)})()",
    },
    prototype: {
      type: "text",
      compute: "(()=>{try{Array.prototype.injected=1}catch{}return String([].injected)})()",
    },
    marker: { type: "text", compute: '(globalThis.__probe="previous","ok")' },
    clock: {
      type: "text",
      compute: '(()=>{try{return String(Date.now())}catch{return "blocked"}})()',
    },
    random: {
      type: "text",
      compute: '(()=>{try{return String(Math.random())}catch{return "blocked"}})()',
    },
  });
  probe.documentType = {
    ...probe.documentType,
    layout: validateDocumentLayout(probe.documentType, {
      displayFields: {
        api: {
          label: "能力",
          type: "text",
          compute: 'self => [typeof fetch,typeof Worker,typeof process].join(",")',
        },
      },
    }),
  };
  const worker = evaluator();
  worker.setSnapshot(1, [probe]);
  const result = await worker.readDocument(probe.document.path);
  assert.equal(result.values?.result, Array(6).fill("undefined").join(","));
  assert.equal(result.values?.escape, null);
  assert.ok(result.fieldErrors?.escape);
  assert.equal(result.values?.readonly, "undefined");
  assert.equal(result.values?.prototype, "undefined");
  assert.equal(result.displayValues?.api, "undefined,undefined,undefined");
  assert.equal(result.values?.clock, "blocked");
  assert.equal(result.values?.random, "blocked");
  const next = item("探针/二.json", {
    marker: { type: "text", compute: "typeof globalThis.__probe" },
  });
  assert.equal((await worker.evaluateDocument(next)).values?.marker, "undefined");
  assert.equal(Object.isFrozen(Array.prototype), false, "lockdown不能影响调用线程");
});

test("更新期间的旧读取被拒绝，空增量版本与同版本重置仍同步，草稿不覆盖真实快照", async () => {
  const source = item(
    "角色/甲.json",
    { base: { type: "number" }, result: { type: "number", compute: "$raw.base*2" } },
    { base: 2 },
  );
  const readStarted = deferred<void>();
  let release!: () => void;
  let delayed = true;
  const worker = evaluator({
    createWorker: () => {
      const port = new Worker(new URL("./document-worker.ts", import.meta.url), { type: "module" });
      const send = port.postMessage.bind(port);
      port.postMessage = (message: unknown) => {
        const request = message as { command: { op: string } };
        if (delayed && request.command.op === "read") {
          delayed = false;
          release = () => send(message);
          readStarted.resolve();
        } else send(message);
      };
      return port;
    },
  });
  worker.setSnapshot(1, [source]);
  const first = worker.readDocument(source.document.path);
  const rejected = assert.rejects(first, /版本已变化/);
  await readStarted.promise;
  const changed = { ...source, values: { base: 5 } };
  worker.updateSnapshot(2, [changed]);
  release();
  await rejected;
  assert.equal((await worker.readDocument(source.document.path)).values?.result, 10);
  worker.updateSnapshot(3, []);
  assert.equal((await worker.readDocument(source.document.path)).values?.result, 10);
  assert.equal(
    (await worker.evaluateDocument({ ...source, values: { base: 8 } })).values?.result,
    16,
  );
  assert.equal((await worker.readDocument(source.document.path)).values?.result, 10);
  worker.setSnapshot(3, [source]);
  assert.equal((await worker.readDocument(source.document.path)).values?.result, 4);
});

test("死循环终止计算 Worker 后可从最新快照恢复，排队不占用后续任务执行期限", async () => {
  let spawned = 0;
  const worker = evaluator({
    computationTimeoutMs: 50,
    createWorker: () => {
      spawned++;
      return new Worker(new URL("./document-worker.ts", import.meta.url), { type: "module" });
    },
  });
  const hostile = item("角色/坏.json", {
    result: { type: "number", compute: "(()=>{while(true){}})()" },
  });
  const safe = item(
    "角色/好.json",
    { base: { type: "number" }, result: { type: "number", compute: "$raw.base+1" } },
    { base: 2 },
  );
  worker.setSnapshot(1, [hostile, safe]);
  const stopped = assert.rejects(worker.readDocument(hostile.document.path), /计算超时/);
  const next = worker.readDocument(safe.document.path);
  await stopped;
  assert.equal((await next).values?.result, 3);
  assert.equal(spawned, 2);
  worker.dispose();
  await assert.rejects(worker.readDocument(safe.document.path), /已关闭/);
});
