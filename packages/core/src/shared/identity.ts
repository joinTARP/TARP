import { z } from "zod";

/** 玩家、队友席位与角色身份是不透明且区分大小写的 URL 安全字符串。 */
export const identityIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
