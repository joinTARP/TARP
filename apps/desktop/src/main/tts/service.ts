import { createHash } from "node:crypto";
import { join } from "node:path";

import { documentIdentity } from "@jointarp/module/document-path";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { readRoomSettings, updateRoomSettings } from "@tarp/core/node/sessions/room-settings";
import { readAdventure } from "@tarp/core/node/sessions/room-storage";
import { roomDirectory } from "@tarp/core/node/sessions/session-store";
import { z } from "zod";

import type { ModuleMetadata } from "../../shared/desktop-api";
import {
  ttsConfigWithVoice,
  roomTtsSettingsSchema,
  ttsVoiceOverrideSchema,
  ttsSaveSchema,
  ttsSynthesizeSchema,
  type TtsSpeaker,
  type TtsConfig,
  type TtsAudio,
  type TtsChunk,
  type TtsResolvedVoice,
  type TtsSettings,
  type TtsPreview,
} from "../../shared/tts";
import {
  readStoredAppSettings,
  appSettingsFileName,
  updateStoredAppSettings,
  readGameDefaults,
  updateGameDefaults,
  type StoredTtsSettings as Stored,
} from "../config/app-settings";
import { mimoTtsProvider } from "./mimo";
import { pcmToWav } from "./pcm";
import { TtsError, type TtsProvider } from "./provider";
import { SharedTtsJobs } from "./shared-jobs";

export class TtsService {
  private readonly configPath: string;
  private providers: Map<string, TtsProvider>;
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, TtsAudio>();
  private cacheSize = 0;
  private jobs = new SharedTtsJobs();
  private credentialEpoch = 0;
  private modules = new Map<string, Promise<ModuleMetadata>>();
  constructor(
    private root: string,
    providers = [mimoTtsProvider()],
  ) {
    if (!providers.length) throw new Error("至少需要一个语音服务商");
    this.providers = new Map(providers.map((provider) => [provider.info.id, provider]));
    this.configPath = join(root, appSettingsFileName);
  }
  close() {
    this.jobs.close();
    this.credentialEpoch++;
    this.cache.clear();
    this.cacheSize = 0;
    this.modules.clear();
  }
  catalog() {
    return Array.from(this.providers.values(), (provider) => provider.info);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async load(): Promise<Stored> {
    return (
      (await readStoredAppSettings(this.configPath)).tts ?? {
        connections: [],
      }
    );
  }
  private provider(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new TtsError("此语音服务商暂不受支持，请重新选择。");
    return provider;
  }
  private key(value: Stored, providerId: string) {
    return value.connections.find((item) => item.provider === providerId)?.apiKey ?? "";
  }
  private async public(value: Stored): Promise<TtsSettings> {
    const defaults = await readGameDefaults(this.configPath);
    return {
      automatic: defaults.tts.automatic,
      config: defaults.tts.config,
      hasKey: Boolean(this.key(value, defaults.tts.config.provider)),
    };
  }
  private async persist(value: Stored): Promise<Stored> {
    return (
      await updateStoredAppSettings(this.configPath, (current) => ({
        ...current,
        tts: value,
      }))
    ).tts!;
  }
  get() {
    return this.serial(async () => this.public(await this.load()));
  }
  private validateConfig(config: TtsConfig, provider = this.provider(config.provider)) {
    const model = provider.info.models.find((item) => item.id === config.model);
    if (
      !model ||
      (model.kind === "design"
        ? config.voice !== "custom" || !config.voiceDescription?.trim()
        : !provider.info.voices.some((voice) => voice.id === config.voice))
    )
      throw new TtsError(
        model?.kind === "design" ? "请填写音色描述。" : "请选择此服务商支持的语音模型和音色。",
      );
  }
  /** 连接管理不改变游戏默认值。 */
  connections() {
    return this.serial(async () => {
      const value = await this.load();
      return this.catalog().map((provider) => ({
        provider: provider.id,
        name: provider.name,
        hasKey: Boolean(this.key(value, provider.id)),
      }));
    });
  }
  connect(provider: string, apiKey: string) {
    return this.serial(async () => {
      this.provider(provider);
      const current = await this.load();
      await this.persist({
        connections: [
          ...current.connections.filter((item) => item.provider !== provider),
          { provider, apiKey },
        ],
      });
      this.clearAudio();
    });
  }
  /** 组合保存供服务调用方使用，界面分别编辑连接与默认项。 */
  async save(input: z.infer<typeof ttsSaveSchema>) {
    const { config, automatic, apiKey } = ttsSaveSchema.parse(input);
    this.validateConfig(config);
    if (apiKey) await this.connect(config.provider, apiKey);
    await updateGameDefaults(this.configPath, { tts: { config, automatic } });
    return this.get();
  }
  async setRoomAutomatic(roomId: string, automatic: boolean) {
    const directory = roomDirectory(join(this.root, "sessions"), roomId);
    updateRoomSettings(directory, (settings) => ({
      ...settings,
      tts: { ...settings.tts, automatic },
    }));
    return this.roomSettings(roomId);
  }
  private clearAudio() {
    this.credentialEpoch++;
    this.cache.clear();
    this.cacheSize = 0;
  }
  disconnect(provider: string) {
    return this.serial(async () => {
      const value = await this.load();
      await this.persist({
        connections: value.connections.filter((item) => item.provider !== provider),
      });
      this.clearAudio();
    });
  }
  private roomConfig(roomId: string) {
    return readRoomSettings(roomDirectory(join(this.root, "sessions"), roomId)).tts.config;
  }
  async voiceSettings(roomId: string, companionId: string) {
    return this.moduleConfig(
      { roomId, kind: "companion", id: companionId },
      this.roomConfig(roomId),
    );
  }
  async hostVoiceSettings(roomId: string): Promise<TtsResolvedVoice> {
    const directory = roomDirectory(join(this.root, "sessions"), roomId);
    const override = readRoomSettings(directory).tts.host;
    return {
      config: await this.moduleConfig({ roomId, kind: "host", id: "" }, this.roomConfig(roomId)),
      overridden: override !== null,
    };
  }
  async roomSettings(roomId: string) {
    const directory = roomDirectory(join(this.root, "sessions"), roomId);
    const settings = readRoomSettings(directory).tts;
    const value = await this.load();
    return {
      ...settings,
      hasKey: Boolean(
        this.providers.has(settings.config.provider) && this.key(value, settings.config.provider),
      ),
    };
  }
  async saveRoomSettings(roomId: string, enabled: boolean) {
    const directory = roomDirectory(join(this.root, "sessions"), roomId);
    const value = roomTtsSettingsSchema.parse({ enabled });
    updateRoomSettings(directory, (settings) => ({
      ...settings,
      tts: { ...settings.tts, ...value },
    }));
    return this.roomSettings(roomId);
  }
  async saveHostVoice(roomId: string, voice: unknown) {
    const parsed = voice === null ? null : ttsVoiceOverrideSchema.parse(voice);
    const directory = roomDirectory(join(this.root, "sessions"), roomId);
    updateRoomSettings(directory, (settings) => ({
      ...settings,
      tts: { ...settings.tts, host: parsed },
    }));
    return this.hostVoiceSettings(roomId);
  }
  private async moduleConfig(speaker: TtsSpeaker, base: TtsConfig): Promise<TtsConfig> {
    // 房间使用冻结的模组副本；模组提示不是客户端传来的任意字符串。
    if (base.provider !== "mimo") return base;
    const directory = roomDirectory(join(this.root, "sessions"), speaker.roomId);
    if (speaker.kind === "host") {
      const override = readRoomSettings(directory).tts.host;
      if (override) return ttsConfigWithVoice(base, override);
    }
    let characterPath: string | undefined;
    let fallback = base;
    if (speaker.kind === "companion") {
      const { party } = readAdventure(directory);
      const companion = party.companions.find((seat) => seat.id === speaker.id);
      if (companion?.status === "active") {
        if (companion.voice) return ttsConfigWithVoice(base, companion.voice);
        if (companion.defaultVoice) fallback = ttsConfigWithVoice(base, companion.defaultVoice);
        characterPath =
          party.characters.find((item) => item.id === companion.characterId)?.sourcePath ??
          undefined;
      }
    }

    let pending = this.modules.get(speaker.roomId);
    if (pending) this.modules.delete(speaker.roomId);
    else
      pending = loadModuleMetadata(join(directory, "module")).catch((error: unknown) => {
        if (this.modules.get(speaker.roomId) === pending) this.modules.delete(speaker.roomId);
        throw error;
      });
    this.modules.set(speaker.roomId, pending);
    if (this.modules.size > 64) this.modules.delete(this.modules.keys().next().value!);
    const metadata = await pending;
    const tts = metadata.tts;
    if (!tts) return fallback;
    let profile;
    if (speaker.kind === "host") profile = tts.host;
    else if (speaker.kind === "npc") profile = tts.characters?.[documentIdentity(speaker.id)];
    else if (characterPath) profile = tts.characters?.[documentIdentity(characterPath)];
    if (!profile) return fallback;
    return {
      ...fallback,
      ...(profile.description
        ? {
            model: "mimo-v2.5-tts-voicedesign",
            voice: "custom",
            voiceDescription: profile.description,
          }
        : {}),
      ...(profile.instructions ? { instructions: profile.instructions } : {}),
    };
  }
  private async prepare(
    text: string,
    speaker?: TtsSpeaker,
    signal?: AbortSignal,
    preview?: TtsPreview,
  ) {
    ({ text, speaker, preview } = ttsSynthesizeSchema.parse({ text, speaker, preview }));
    if (!preview && speaker && !(await this.roomSettings(speaker.roomId)).enabled)
      throw new TtsError("当前冒险已关闭语音。");
    const { config, apiKey, provider, epoch } = await this.serial(async () => {
      const value = await this.load();
      const config =
        preview?.config ??
        (speaker ? this.roomConfig(speaker.roomId) : (await this.public(value)).config);
      const provider = this.provider(config.provider);
      const apiKey = preview?.apiKey || this.key(value, config.provider);
      if (!apiKey)
        throw new TtsError("当前冒险的语音供应商未连接，请在设置 → 语音供应商中填写 API Key。");
      return {
        config,
        apiKey,
        provider,
        epoch: this.credentialEpoch,
      };
    });
    signal?.throwIfAborted();
    const effectiveConfig = !preview && speaker ? await this.moduleConfig(speaker, config) : config;
    this.validateConfig(effectiveConfig, provider);
    signal?.throwIfAborted();
    const key = createHash("sha256")
      .update(JSON.stringify({ config: effectiveConfig, text, apiKey }))
      .digest("hex");
    return { text, config: effectiveConfig, apiKey, provider, key, epoch };
  }
  async synthesize(
    text: string,
    speaker?: TtsSpeaker,
    signal?: AbortSignal,
    preview?: TtsPreview,
  ): Promise<TtsAudio> {
    // 完整音频调用也加入同一份流式任务，避免两条入口重复计费。
    const pcm: Buffer[] = [];
    let sampleRate = 24000;
    let channels = 1;
    for await (const chunk of this.stream(text, speaker, signal, preview)) {
      if (chunk.type === "audio") return chunk.audio;
      pcm.push(Buffer.from(chunk.data, "base64"));
      sampleRate = chunk.sampleRate;
      channels = chunk.channels;
    }
    return {
      data: pcmToWav(Buffer.concat(pcm), sampleRate, channels).toString("base64"),
      mimeType: "audio/wav",
    };
  }
  async *stream(
    text: string,
    speaker?: TtsSpeaker,
    signal?: AbortSignal,
    preview?: TtsPreview,
  ): AsyncGenerator<TtsChunk> {
    const input = await this.prepare(text, speaker, signal, preview);
    const cached = this.cache.get(input.key);
    if (cached) {
      this.cache.delete(input.key);
      this.cache.set(input.key, cached);
      yield { type: "audio", audio: cached };
      return;
    }
    const service = this;
    yield* this.jobs.subscribe(
      `${input.epoch}:${input.key}`,
      async function* (upstreamSignal) {
        let audio: TtsAudio;
        const request = { ...input, signal: upstreamSignal };
        if (
          !input.provider.stream ||
          input.provider.info.models.find((model) => model.id === input.config.model)
            ?.lowLatencyStream === false
        ) {
          audio = await input.provider.synthesize(request);
          upstreamSignal.throwIfAborted();
          yield { type: "audio", audio };
        } else {
          const pieces: Buffer[] = [];
          let bytes = 0;
          let format: { sampleRate: number; channels: number } | undefined;
          for await (const chunk of input.provider.stream(request)) {
            upstreamSignal.throwIfAborted();
            if (
              format &&
              (format.sampleRate !== chunk.sampleRate || format.channels !== chunk.channels)
            )
              throw new TtsError("语音流的音频格式发生变化。");
            format = chunk;
            const piece = Buffer.from(chunk.data, "base64");
            bytes += piece.length;
            if (bytes > 16 * 1024 * 1024) throw new TtsError("语音过长，请缩短文本。");
            pieces.push(piece);
            yield chunk;
          }
          if (!format || !bytes || bytes % (format.channels * 2))
            throw new TtsError("语音数据不完整，请重试。");
          audio = {
            data: pcmToWav(Buffer.concat(pieces), format.sampleRate, format.channels).toString(
              "base64",
            ),
            mimeType: "audio/wav",
          };
        }
        upstreamSignal.throwIfAborted();
        // 断开凭据后，旧任务可以服务已有听众，但不得重新填充已清理的缓存。
        if (input.epoch === service.credentialEpoch) service.remember(input.key, audio);
      },
      signal,
    );
  }
  private remember(key: string, audio: TtsAudio) {
    // 只缓存近期音频，重启后不保留；按 Base64 字符长度约束内存。
    const size = audio.data.length;
    const previous = this.cache.get(key);
    if (previous) this.cacheSize -= previous.data.length;
    this.cache.set(key, audio);
    this.cacheSize += size;
    while (this.cacheSize > 32 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value!;
      this.cacheSize -= this.cache.get(oldest)!.data.length;
      this.cache.delete(oldest);
    }
  }
}
