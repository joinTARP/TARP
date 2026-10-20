import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 测试资料按类型和分组分目录保存，准备内容时一并创建父目录。 */
export async function writeTestFile(
  path: string,
  content: Parameters<typeof writeFile>[1],
  options?: Parameters<typeof writeFile>[2],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, options);
}
