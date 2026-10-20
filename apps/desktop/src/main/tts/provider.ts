import type { TtsAudio, TtsConfig, TtsPcmChunk, TtsProviderInfo } from "../../shared/tts";

/** 允许直接向用户展示的语音业务错误。 */
export class TtsError extends Error {}

export interface TtsRequest {
  text: string;
  config: TtsConfig;
  apiKey: string;
  signal?: AbortSignal;
}

/** 新增服务商实现此接口并注册；不依赖聊天模型运行时或渲染器。 */
export interface TtsProvider {
  info: TtsProviderInfo;
  synthesize(input: TtsRequest): Promise<TtsAudio>;
  /** 可选的 PCM16LE 流式输出；未实现时由服务层回退到完整音频。 */
  stream?(input: TtsRequest): AsyncIterable<TtsPcmChunk>;
}
