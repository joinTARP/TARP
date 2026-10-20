/** 按 SSE 事件读取，兼容 UTF-8、CRLF 和任意网络分块；退出时释放上游。 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let lines: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 8 * 1024 * 1024) throw new Error("语音流事件过大");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/u, "");
        pending = pending.slice(end + 1);
        if (!line) {
          if (lines.length) yield lines.join("\n");
          lines = [];
          eventSize = 0;
        } else if (line.startsWith("data:")) {
          eventSize += line.length;
          if (eventSize > 8 * 1024 * 1024) throw new Error("语音流事件过大");
          lines.push(line.slice(5).replace(/^ /u, ""));
        }
      }
      if (done) break;
    }
    if (pending.startsWith("data:")) lines.push(pending.slice(5).trimStart());
    if (lines.length) yield lines.join("\n");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
