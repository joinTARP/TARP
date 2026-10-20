import { createHash } from "node:crypto";

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const receiptType = "companion_event_receipt";
const receiptSchema = z.array(z.tuple([z.string(), z.string()]));
const contextSchema = z
  .object({
    events: z.array(z.object({ id: z.string() }).passthrough()),
  })
  .passthrough();

/** 接收记录只进入会话元数据，不占模型上下文；压缩后仍沿原生分支恢复。 */
export function prepareCompanionInput(manager: SessionManager, text: string) {
  const newline = text.indexOf("\n");
  const header = newline < 0 ? text : text.slice(0, newline);
  let context: z.infer<typeof contextSchema>;
  try {
    context = contextSchema.parse(JSON.parse(header));
  } catch {
    // 独立运行或补问可以没有公开事件封套。
    return { text, acknowledge() {} };
  }
  const received = new Map<string, string>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== receiptType) continue;
    const parsed = receiptSchema.safeParse(entry.data);
    if (parsed.success) for (const [id, fingerprint] of parsed.data) received.set(id, fingerprint);
  }
  const changes: [string, string][] = [];
  const events = context.events.filter((event) => {
    const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if (received.get(event.id) === fingerprint) return false;
    changes.push([event.id, fingerprint]);
    return true;
  });
  return {
    text:
      JSON.stringify({
        ...context,
        eventMode: received.size ? "incremental" : "initial",
        events,
      }) + (newline < 0 ? "" : text.slice(newline)),
    acknowledge() {
      if (changes.length) manager.appendCustomEntry(receiptType, changes);
    },
  };
}
