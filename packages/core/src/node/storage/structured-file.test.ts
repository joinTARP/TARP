import { it, onTestFinished, spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { withFileMutation } from "./file-queue";
import { structuredFile, StructuredFileError } from "./structured-file";
import { stageFileAtomic, writeFileAtomic, writeFileAtomicSync } from "./write-file-atomic";

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "tarp-storage-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const schema = z.object({ count: z.number() }).passthrough();
function store(path: string) {
  return structuredFile(path, {
    validate: (value) => schema.parse(value),
    missing: () => ({ count: 0 }),
  });
}

it("多个存储实例对同文件完整读改写，保留全部增量和未知字段", async () => {
  const path = join(await directory(), "nested", "config.json");
  await store(path).write({ count: 0, extra: "保留" });
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store(path).update(async (value) => {
        await Promise.resolve();
        return { ...value, count: value.count + 1 };
      }),
    ),
  );
  assert.deepEqual(await store(path).read(), { count: 12, extra: "保留" });
});

it("原子替换期间旧文件的 realpath 结果变化不会拆散同文件更新队列", async () => {
  const path = join(await directory(), "config.json");
  await store(path).write({ count: 0, extra: "保留" });
  const realpath = fs.realpath;
  let resolutions = 0;
  const resolving = spyOn(fs, "realpath").mockImplementation((async (
    target: Parameters<typeof realpath>[0],
  ) => {
    const actual = await realpath(target);
    // 模拟 Linux 在旧文件已被 rename 替换后返回的描述符路径。
    return target === path && ++resolutions % 2 === 0 ? `${actual} (deleted)` : actual;
  }) as typeof realpath);
  onTestFinished(() => resolving.mockRestore());
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store(path).update(async (value) => {
        await Promise.resolve();
        return { ...value, count: value.count + 1 };
      }),
    ),
  );
  assert.deepEqual(await store(path).read(), { count: 12, extra: "保留" });
});

it("读取等待先前写入，写入使用调用时的快照", async () => {
  const path = join(await directory(), "config.json");
  const value = { count: 1, nested: { label: "原值" } };
  const saving = store(path).write(value);
  value.nested.label = "后来修改";
  const reading = store(path).read();
  assert.deepEqual(await reading, { count: 1, nested: { label: "原值" } });
  await saving;
});

it("某个文件等待时，其他文件仍可执行", async () => {
  const root = await directory();
  const entered = gate();
  const finish = gate();
  const first = withFileMutation(join(root, "a"), async () => {
    entered.release();
    await finish.promise;
  });
  await entered.promise;
  try {
    await withFileMutation(join(root, "b"), async () => undefined);
  } finally {
    finish.release();
  }
  await first;
});

it("失败的操作释放队列，后续更新继续成功", async () => {
  const path = join(await directory(), "config.json");
  const failed = store(path).update(() => {
    throw new Error("业务失败");
  });
  const check = assert.rejects(failed, /业务失败/);
  const next = store(path).update((value) => ({ ...value, count: 2 }));
  await check;
  assert.equal((await next).count, 2);
});

it("不存在的文件通过父目录链接使用同一队列", async () => {
  const root = await directory();
  const real = join(root, "real");
  const alias = join(root, "alias");
  await mkdir(real);
  await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
  await Promise.all([
    store(join(real, "new", "config.json")).update((value) => ({ count: value.count + 1 })),
    store(join(alias, "new", "config.json")).update((value) => ({ count: value.count + 1 })),
  ]);
  assert.equal((await store(join(real, "new", "config.json")).read()).count, 2);
});

for (const source of ["{", "null", '{"count":"private-secret-value"}']) {
  it(`无效文件 ${source} 不使用默认值、不覆盖、不泄露原文`, async () => {
    const path = join(await directory(), "config.json");
    await writeFile(path, source);
    let defaults = 0;
    const file = structuredFile(path, {
      validate: (value) => schema.parse(value),
      missing: () => {
        defaults++;
        return { count: 0 };
      },
    });
    const check = (error: unknown) => {
      assert(error instanceof StructuredFileError);
      assert(!error.message.includes("private-secret-value"));
      return true;
    };
    await assert.rejects(file.read(), check);
    await assert.rejects(
      file.update((value) => ({ ...value, count: 3 })),
      check,
    );
    assert.equal(defaults, 0);
    assert.equal(await readFile(path, "utf8"), source);
  });
}

it("文件系统错误不会误判为缺失，且不会卡住后续登记", async () => {
  const root = await directory();
  const parent = join(root, "ordinary-file");
  await writeFile(parent, "保留");
  await assert.rejects(store(join(parent, "config.json")).read(), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOTDIR");
    return true;
  });
  assert.equal((await store(join(root, "good.json")).write({ count: 1 })).count, 1);
});

it("不提供默认值时保留 ENOENT，同步和异步行为一致", async () => {
  const file = structuredFile(join(await directory(), "missing.json"), { validate: schema.parse });
  await assert.rejects(file.read(), { code: "ENOENT" });
  assert.throws(() => file.readSync(), { code: "ENOENT" });
});

it("写入校验失败时保留已有文件，同步更新也拒绝损坏文件", async () => {
  const path = join(await directory(), "config.json");
  const file = store(path);
  await file.write({ count: 1 });
  const original = await readFile(path, "utf8");
  await assert.rejects(file.write({ count: "bad" } as never), StructuredFileError);
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, "{");
  assert.throws(() => file.updateSync(() => ({ count: 2 })), StructuredFileError);
  assert.equal(await readFile(path, "utf8"), "{");
});

for (const synchronous of [false, true]) {
  it(`${synchronous ? "同步" : "异步"}原子替换失败时保留目标、清理独立临时文件`, async () => {
    const root = await directory();
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "原目标");
    if (synchronous) assert.throws(() => writeFileAtomicSync(target, "新内容"));
    else await assert.rejects(writeFileAtomic(target, "新内容"));
    assert.equal(await readFile(join(target, "sentinel"), "utf8"), "原目标");
    assert.deepEqual(await readdir(root), ["target"]);
  });
}

it("业务暂存不提前修改原文件，取消清理，发布才替换", async () => {
  const root = await directory();
  const target = join(root, "document.json");
  await writeFile(target, "原内容");
  const cancelled = await stageFileAtomic(target, "取消的内容");
  assert.equal(await readFile(target, "utf8"), "原内容");
  await cancelled.discard();
  assert.deepEqual(await readdir(root), ["document.json"]);
  const committed = await stageFileAtomic(target, "新内容");
  await committed.publish();
  assert.equal(await readFile(target, "utf8"), "新内容");
  assert.deepEqual(await readdir(root), ["document.json"]);
});
