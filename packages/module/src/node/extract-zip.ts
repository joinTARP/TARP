import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { open, type Entry, type ZipFile } from "yauzl";

const maxArchiveBytes = 512 * 1024 * 1024;
const maxFileBytes = 512 * 1024 * 1024;
const maxExpandedBytes = 2 * 1024 * 1024 * 1024;
const maxEntries = 10_000;

function entryPath(entry: Entry): string[] {
  const parts = entry.fileName.replace(/\/$/u, "").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\<>:"|?*\u0000-\u001f\u007f]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  )
    throw new Error(`ZIP 包含无效路径：${entry.fileName}`);
  const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (kind && kind !== 0o100000 && kind !== 0o040000)
    throw new Error(`ZIP 包含符号链接或非普通文件：${entry.fileName}`);
  if (entry.isEncrypted()) throw new Error("暂不支持加密 ZIP，请先解密后再导入。");
  return parts;
}

/** 只向新建的临时目录解压；按文件流式读取，不执行归档中的任何内容。 */
export async function extractModuleZip(archive: string, destination: string): Promise<void> {
  const info = await stat(archive);
  if (!info.isFile()) throw new Error("请选择 ZIP 文件。");
  if (info.size > maxArchiveBytes) throw new Error("ZIP 文件不能超过 512 MiB。");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    open(
      archive,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, file) => {
        if (error) reject(error);
        else resolve(file);
      },
    );
  });
  let current: Promise<void> | undefined;
  let expanded = 0;
  let count = 0;
  let failed = false;
  const paths = new Set<string>();
  async function extract(entry: Entry): Promise<void> {
    if (++count > maxEntries) throw new Error("ZIP 文件条目不能超过 10,000 个。");
    const parts = entryPath(entry);
    if (parts.includes("__MACOSX") || parts.includes(".git") || parts.at(-1)!.startsWith("._"))
      return;
    const key = parts.join("/").normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error(`ZIP 包含重复路径：${entry.fileName}`);
    paths.add(key);
    const target = join(destination, ...parts);
    if (entry.fileName.endsWith("/")) {
      await mkdir(target, { recursive: true });
      return;
    }
    if (
      entry.uncompressedSize > maxFileBytes ||
      expanded + entry.uncompressedSize > maxExpandedBytes
    )
      throw new Error("ZIP 内容过大：单个文件最多 512 MiB，解压后总量最多 2 GiB。");
    await mkdir(dirname(target), { recursive: true });
    const input = await new Promise<Readable>((resolve, reject) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
    });
    let fileBytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        fileBytes += chunk.length;
        expanded += chunk.length;
        if (fileBytes > maxFileBytes || expanded > maxExpandedBytes)
          callback(new Error("ZIP 解压内容超过大小限制。"));
        else callback(null, chunk);
      },
    });
    await pipeline(input, limit, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        failed = true;
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", resolve);
      zip.on("entry", (entry: Entry) => {
        current = extract(entry);
        void current.then(() => {
          if (!failed) zip.readEntry();
        }, fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
    // 发生归档错误时先等待当前写入结束，随后调用方才能安全删除临时目录。
    await current?.catch(() => undefined);
  }
}
