import { lstatSync } from "node:fs";

/** 已发布的存档文件必须存在且为普通文件，不通过符号链接读写。 */
export function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`无效的存档文件路径：${path}`);
}
