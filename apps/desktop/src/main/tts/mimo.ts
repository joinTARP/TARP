import { defaultTtsConfig } from "@tarp/core/shared/voice";

import { TtsError, type TtsRequest, type TtsProvider } from "./provider";
import { readSse } from "./sse";

export function mimoTtsProvider(fetcher: typeof fetch = fetch): TtsProvider {
  async function request({ text, config, apiKey, signal }: TtsRequest, stream: boolean) {
    const designed = config.model === "mimo-v2.5-tts-voicedesign";
    if (designed && !config.voiceDescription?.trim()) throw new TtsError("请先填写音色描述。");
    const timeout = AbortSignal.timeout(90_000);
    const response = await fetcher("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          ...(designed
            ? [
                {
                  role: "user",
                  content: [config.voiceDescription, config.instructions]
                    .filter(Boolean)
                    .join("\n"),
                },
              ]
            : config.instructions
              ? [{ role: "user", content: config.instructions }]
              : []),
          { role: "assistant", content: text },
        ],
        audio: designed
          ? { format: stream ? "pcm16" : "wav" }
          : { format: stream ? "pcm16" : "wav", voice: config.voice },
        stream,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw new TtsError(
        timeout.aborted
          ? "MiMo 语音合成超时，请重试。"
          : "无法连接 MiMo 语音服务，请检查网络后重试。",
      );
    });
    if (!response.ok) {
      // 不回显上游响应体，避免代理错误页带回请求凭据。
      if (response.status === 401 || response.status === 403)
        throw new TtsError("MiMo 语音鉴权失败，请检查 API Key 和模型权限。");
      if (response.status === 429)
        throw new TtsError("MiMo 语音请求过于频繁或额度不足，请稍后重试。");
      throw new TtsError(`MiMo 语音合成失败（HTTP ${response.status}）。`);
    }
    return response;
  }
  return {
    info: {
      id: "mimo",
      name: "小米 MiMo",
      models: [
        { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", kind: "preset", lowLatencyStream: true },
        {
          id: "mimo-v2.5-tts-voicedesign",
          name: "MiMo V2.5 TTS VoiceDesign",
          kind: "design",
          lowLatencyStream: false,
        },
      ],
      voices: [
        { id: "mimo_default", name: "默认音色" },
        ...["冰糖", "茉莉"].map((id) => ({ id, name: `${id} · 中文女声` })),
        ...["苏打", "白桦"].map((id) => ({ id, name: `${id} · 中文男声` })),
        ...["Mia", "Chloe"].map((id) => ({ id, name: `${id} · 英文女声` })),
        ...["Milo", "Dean"].map((id) => ({ id, name: `${id} · 英文男声` })),
      ],
      defaultConfig: defaultTtsConfig,
    },
    async synthesize({ text, config, apiKey, signal }) {
      const response = await request({ text, config, apiKey, signal }, false);
      const body = await response.json();
      const data: unknown = body?.choices?.[0]?.message?.audio?.data;
      if (
        typeof data !== "string" ||
        !data ||
        data.length > 24 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
      )
        throw new TtsError("MiMo 未返回有效的语音数据，请重试。");
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
        throw new TtsError("MiMo 返回的音频格式无效，请重试。");
      return { data, mimeType: "audio/wav" };
    },
    async *stream(input) {
      const response = await request(input, true);
      if (!response.body) throw new TtsError("MiMo 未返回语音流，请重试。");
      let received = false;
      let complete = false;
      try {
        for await (const event of readSse(response.body)) {
          input.signal?.throwIfAborted();
          if (event === "[DONE]") {
            complete = true;
            break;
          }
          const body = JSON.parse(event);
          if (body.error) throw new TtsError("MiMo 语音流生成失败，请重试。");
          const choice = body.choices?.[0];
          const data = choice?.delta?.audio?.data;
          if (data !== undefined && data !== "") {
            if (
              typeof data !== "string" ||
              data.length > 8 * 1024 * 1024 ||
              data.length % 4 !== 0 ||
              !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
            )
              throw new TtsError("MiMo 返回了无效的语音片段。");
            received = true;
            yield { type: "pcm", data, sampleRate: 24000, channels: 1 };
          }
          if (choice?.finish_reason === "stop") complete = true;
          else if (choice?.finish_reason) throw new TtsError("MiMo 语音生成未完整结束，请重试。");
        }
        if (!complete || !received) throw new TtsError("MiMo 语音流中断或未返回音频，请重试。");
      } catch (error) {
        if (input.signal?.aborted || error instanceof TtsError) throw error;
        throw new TtsError("MiMo 语音流接收失败，请重试。");
      }
    },
  };
}
