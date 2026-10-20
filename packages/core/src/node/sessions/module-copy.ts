import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** 已有目录不可通过符号链接指向其他位置。 */
export async function directoryExists(path: string, label = "存档目录"): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error(`无效的${label}：${path}`);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** 复制模组根目录时允许根路径本身是快捷方式；内部仍只复制普通文件和目录。 */
export async function copyModule(
  source: string,
  destination: string,
  options: { writable?: boolean } = {},
): Promise<void> {
  let sourceRoot: string;
  try {
    sourceRoot = await realpath(source);
    const stat = await lstat(sourceRoot);
    if (!stat.isDirectory()) throw new Error("模组路径不是目录");
  } catch (error) {
    if (missing(error)) throw new Error("模组目录不存在");
    throw error;
  }
  // 防止把 staging 建在源目录里后递归复制自身。
  const target = relative(sourceRoot, await realpath(destination));
  if (!target || (!target.startsWith(`..${sep}`) && target !== ".." && !isAbsolute(target))) {
    throw new Error("房间副本目录不能位于源模组内");
  }
  async function copy(from: string, to: string): Promise<void> {
    if (!(await directoryExists(from)) || (await realpath(from)) !== from)
      throw new Error("模组目录包含符号链接");
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const input = join(from, entry.name);
      const output = join(to, entry.name);
      const stat = await lstat(input);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await mkdir(output);
        await copy(input, output);
      } else if (stat.isFile()) {
        const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await file.stat()).isFile()) throw new Error("模组文件类型已改变");
          await writeFile(output, await file.readFile(), {
            flag: "wx",
            mode: options.writable ? 0o600 : 0o444,
          });
        } finally {
          await file.close();
        }
      }
    }
  }
  await copy(sourceRoot, destination);
}
