import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 业务先校验和暂存，再决定发布；调用方负责父目录及事务锁。 */
export async function stageFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: { mode?: number } = {},
) {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const discard = () => rm(temp, { force: true }).catch(() => undefined);
  try {
    await writeFile(temp, content, { flag: "wx", mode: options.mode });
  } catch (error) {
    await discard();
    throw error;
  }
  return {
    discard,
    async publish(): Promise<void> {
      try {
        await rename(temp, target);
      } catch (error) {
        await discard();
        throw error;
      }
    },
  };
}

/** 文件发布基础操作；调用方负责创建父目录及协调完整读改写。不删除目标来重试。 */
export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  await (await stageFileAtomic(target, content, options)).publish();
}

/** 同步读改写场景使用；完整写入临时文件后替换目标。 */
export function writeFileAtomicSync(
  target: string,
  content: string | Uint8Array,
  options: { mode?: number } = {},
): void {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: options.mode });
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理失败不能掩盖最初的写入或替换错误。
    }
    throw error;
  }
}
