import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ZodError } from "zod";

import { isMissingFile, withFileMutation } from "./file-queue";
import { writeFileAtomic, writeFileAtomicSync } from "./write-file-atomic";

export interface FileCodec {
  readonly format: string;
  decode(source: string, path: string): unknown;
  encode(value: unknown, path: string): string;
}

const jsonFileCodec: FileCodec = {
  format: "JSON",
  decode: (source) => JSON.parse(source) as unknown,
  encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
};

/** 只包含路径、格式和字段名，不附带配置原文或校验中的敏感值。 */
export class StructuredFileError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}：${detail}`);
    this.name = "StructuredFileError";
  }
}

export interface StructuredFileOptions<T> {
  readonly codec?: FileCodec;
  readonly validate: (value: unknown) => T;
  /** 仅文件不存在时调用；未提供则保留 ENOENT，损坏文件永远不会走默认值。 */
  readonly missing?: () => NoInfer<T>;
  readonly fileMode?: number;
  readonly directoryMode?: number;
}

/** 无缓存的结构化文件存储。一个目标应统一使用异步接口或同步接口。 */
export function structuredFile<T>(path: string, options: StructuredFileOptions<T>) {
  const codec = options.codec ?? jsonFileCodec;

  function validate(value: unknown): T {
    try {
      return options.validate(value);
    } catch (error) {
      const fields =
        error instanceof ZodError
          ? [...new Set(error.issues.map((issue) => issue.path.join(".") || "根节点"))]
          : [];
      throw new StructuredFileError(
        path,
        `字段校验失败${fields.length ? `：${fields.join("、")}` : ""}。`,
      );
    }
  }

  function decode(source: string): T {
    let value: unknown;
    try {
      value = codec.decode(source, path);
    } catch {
      throw new StructuredFileError(path, `${codec.format} 格式无效。`);
    }
    return validate(value);
  }

  async function read(): Promise<T> {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error) && options.missing) return validate(options.missing());
      throw error;
    }
    return decode(source);
  }

  function readSync(): T {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error) && options.missing) return validate(options.missing());
      throw error;
    }
    return decode(source);
  }

  async function write(value: T): Promise<T> {
    const parsed = validate(value);
    const source = codec.encode(parsed, path);
    await mkdir(dirname(path), { recursive: true, mode: options.directoryMode });
    await writeFileAtomic(path, source, { mode: options.fileMode });
    return parsed;
  }

  function writeSync(value: T): T {
    const parsed = validate(value);
    const source = codec.encode(parsed, path);
    mkdirSync(dirname(path), { recursive: true, mode: options.directoryMode });
    writeFileAtomicSync(path, source, { mode: options.fileMode });
    return parsed;
  }

  return {
    // 读取等待先前已登记的保存完成，更新内部使用未入队的 read/write，避免嵌套锁。
    read: () => withFileMutation(path, read),
    write: (value: T) => {
      const snapshot = structuredClone(value);
      return withFileMutation(path, () => write(snapshot));
    },
    update: (change: (current: T) => T | Promise<T>) =>
      withFileMutation(path, async () => write(await change(await read()))),
    flush: () => withFileMutation(path, async () => undefined),
    // 同步调用无 await 间隙；由调用方已有的房间事务或业务锁协调。
    readSync,
    writeSync,
    updateSync: (change: (current: T) => T) => writeSync(change(readSync())),
  };
}
