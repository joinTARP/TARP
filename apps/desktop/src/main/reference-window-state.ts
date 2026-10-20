import { structuredFile } from "@tarp/core/node/storage/structured-file";
import { z } from "zod";

import type { WindowRectangle } from "./reference-window-bounds";

const boundsSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .nullable();

function boundsFile(path: string) {
  return structuredFile(path, {
    validate: (value) => boundsSchema.parse(value),
    missing: () => null,
    fileMode: 0o600,
    directoryMode: 0o700,
  });
}

/** 窗口位置是可恢复的偏好；加载期间的新位置始终优先于旧磁盘快照。 */
export class ReferenceWindowState {
  private readonly file: ReturnType<typeof boundsFile>;
  private revision = 0;
  private saved: WindowRectangle | null = null;

  constructor(path: string) {
    this.file = boundsFile(path);
  }

  get value(): WindowRectangle | null {
    return this.saved ? { ...this.saved } : null;
  }

  async load(): Promise<void> {
    const revision = this.revision;
    const value = await this.file.read();
    if (revision === this.revision) this.saved = value;
  }

  async save(value: WindowRectangle): Promise<void> {
    const bounds = boundsSchema.parse(value);
    this.revision++;
    this.saved = bounds;
    await this.file.write(bounds);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
