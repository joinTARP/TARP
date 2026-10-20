import { nanoid } from "nanoid";

/** 新身份使用 16 位 Nano ID；房间内创建时排除已有身份。 */
export function createIdentityId(existing: Iterable<string> = []): string {
  const used = new Set(existing);
  let id: string;
  do {
    id = nanoid(16);
  } while (used.has(id));
  return id;
}
