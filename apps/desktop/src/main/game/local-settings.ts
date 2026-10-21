import { join } from "node:path";

import type { AuthContext, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, InMemoryModelsStore } from "@jointarp/core/node/agent/models";
import { createIdentityId } from "@jointarp/core/node/identity";
import { structuredFile, StructuredFileError } from "@jointarp/core/node/storage/structured-file";
import {
  playerSchema,
  customAiApis,
  type AiSettings,
  type ThinkingLevel,
  type AvailableAiModel,
} from "@jointarp/core/shared/game";
import { gameDefaultsSchema, type GameDefaultsPatch } from "@jointarp/core/shared/game-defaults";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  AppConfigError,
  appSettingsFileName,
  readStoredAppSettings,
  updateStoredAppSettings,
  readGameDefaults,
  updateGameDefaults,
  type StoredGameSettings,
} from "../config/app-settings";

const modelDefinition = z.object({ id: z.string().min(1) }).passthrough();
const providerDefinition = z
  .object({
    name: z.string().optional(),
    baseUrl: z.string().optional(),
    api: z.string().optional(),
    models: z.array(modelDefinition).optional(),
  })
  .passthrough();
const modelsSchema = z.object({ providers: z.record(z.string(), providerDefinition) }).strict();
interface ModelSettings {
  runtime: ModelRuntime;
  definitions: z.infer<typeof modelsSchema>;
}
export const connectProviderSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "服务商 ID 只能使用小写字母、数字和连字符"),
    custom: z.boolean(),
    reasoning: z.boolean().optional(),
    baseUrl: z.url().optional(),
    api: z.enum(customAiApis).optional(),
    model: z.string().trim().min(1).optional(),
    apiKey: z.string().trim().optional(),
  })
  .strict();

// 桌面连接由应用保存的凭据启用，不自动发现宿主环境或其他工具的认证文件。
const desktopAuthContext: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

function desktopProvider(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return provider;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        ...(apiKey.check
          ? {
              check: async (input: Parameters<NonNullable<typeof apiKey.check>>[0]) => {
                input.signal.throwIfAborted();
                if (!input.credential) return undefined;
                return apiKey.check!({ ...input, ctx: desktopAuthContext });
              },
            }
          : {}),
        resolve: async (input) => {
          input.signal.throwIfAborted();
          if (!input.credential) return undefined;
          return apiKey.resolve({ ...input, ctx: desktopAuthContext });
        },
      },
    },
  };
}

/** 应用只管理玩家和默认选择；模型、协议与认证由 pi 解析。 */
export class LocalGameSettings {
  private readonly configPath: string;
  private readonly modelsPath: string;
  private readonly authPath: string;
  private readonly builtins = builtinProviders();
  private runtimePromise?: Promise<ModelRuntime>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.configPath = join(root, appSettingsFileName);
    this.modelsPath = join(root, "models.json");
    this.authPath = join(root, "auth.json");
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private modelsFile() {
    return structuredFile(this.modelsPath, {
      validate: (value) => modelsSchema.parse(value),
      missing: () => ({ providers: {} }),
      fileMode: 0o600,
      directoryMode: 0o700,
    });
  }
  private async modelsOperation<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StructuredFileError)
        throw new AppConfigError(this.modelsPath, error.detail);
      throw error;
    }
  }
  private runtime(): Promise<ModelRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = ModelRuntime.create({
        authPath: this.authPath,
        modelsPath: this.modelsPath,
        modelsStore: new InMemoryModelsStore(),
        allowModelNetwork: false,
        refreshOnCreate: false,
      })
        .then((runtime) => {
          for (const provider of this.builtins)
            if (provider.auth.apiKey) runtime.registerNativeProvider(desktopProvider(provider));
          return runtime;
        })
        .catch((error) => {
          this.runtimePromise = undefined;
          throw error;
        });
    }
    return this.runtimePromise;
  }
  private async refreshRuntime(runtime: ModelRuntime): Promise<void> {
    await runtime.refresh({ allowNetwork: false });
    const error = runtime.getError();
    // 认证失败应允许重新登录；模型格式或组合错误才阻止配置读写。
    if (error && !error.startsWith("Availability refresh:"))
      throw new AppConfigError(this.modelsPath, "模型定义或服务商配置无效。");
  }
  /** 每次业务读取重新加载磁盘；同一次操作复用这份配置与运行时。 */
  private async loadModels(): Promise<ModelSettings> {
    // 应用的配置只接收标准 JSON；pi 负责完整的模型定义与协议校验。
    const definitions = await this.modelsOperation(() => this.modelsFile().read());
    const runtime = await this.runtime();
    await this.refreshRuntime(runtime);
    return { runtime, definitions };
  }
  async modelRuntime(): Promise<ModelRuntime> {
    return (await this.loadModels()).runtime;
  }
  private async load(): Promise<StoredGameSettings> {
    const current = await readStoredAppSettings(this.configPath);
    if (current.game) return current.game;
    return (
      await updateStoredAppSettings(this.configPath, (value) => ({
        ...value,
        game: value.game ?? {
          player: { id: createIdentityId(), nickname: "玩家" },
          defaults: gameDefaultsSchema.parse({}),
        },
      }))
    ).game!;
  }
  defaults() {
    return readGameDefaults(this.configPath);
  }
  updateDefaults(patch: GameDefaultsPatch) {
    return updateGameDefaults(this.configPath, patch);
  }
  private async publicSettings(models?: ModelSettings): Promise<AiSettings> {
    const [settings, { definitions, runtime }] = await Promise.all([
      this.load(),
      models ?? this.loadModels(),
    ]);
    const stored = await runtime.listCredentials();
    const builtinIds = new Set(this.builtins.map((provider) => provider.id));
    const providers = runtime
      .getProviders()
      .filter(
        (provider) =>
          provider.id !== "openai-codex" &&
          (definitions.providers[provider.id] ||
            stored.some((value) => value.providerId === provider.id) ||
            runtime.hasConfiguredAuth(provider.id)),
      )
      .map((provider) => {
        const definition = definitions.providers[provider.id];
        const custom = Boolean(definition?.models && !builtinIds.has(provider.id));
        return {
          id: provider.id,
          name: provider.name,
          custom,
          hasKey: runtime.hasConfiguredAuth(provider.id),
          ...(custom
            ? {
                baseUrl: definition?.baseUrl,
                api: definition?.api as (typeof customAiApis)[number],
                model: definition?.models?.[0]?.id,
                reasoning: definition?.models?.[0]?.reasoning === true,
              }
            : {}),
        };
      });
    return { providers, defaultModel: settings.defaults.ai };
  }
  providers() {
    return this.serial(async () =>
      this.builtins
        .filter(
          (provider) =>
            provider.id !== "openai-codex" && provider.auth.apiKey && provider.getModels().length,
        )
        .map((provider) => ({ id: provider.id, name: provider.name })),
    );
  }
  player() {
    return this.serial(async () => ({ ...(await this.load()).player }));
  }
  updatePlayer(nickname: string) {
    return this.serial(async () => {
      await this.load();
      return (
        await updateStoredAppSettings(this.configPath, (current) => ({
          ...current,
          game: {
            ...current.game!,
            player: playerSchema.parse({ ...current.game!.player, nickname }),
          },
        }))
      ).game!.player;
    });
  }
  get() {
    return this.serial(() => this.publicSettings());
  }
  async availableModels(): Promise<AvailableAiModel[]> {
    return this.listAvailableModels(await this.modelRuntime());
  }
  private async listAvailableModels(runtime: ModelRuntime): Promise<AvailableAiModel[]> {
    return (await runtime.getAvailable()).map((model) => ({
      provider: model.provider,
      model: model.id,
      name: model.name,
      providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
    }));
  }
  setDefaultModel(provider: string, model: string, thinkingLevel?: ThinkingLevel) {
    return this.serial(async () => {
      const models = await this.loadModels();
      const selected = (await this.listAvailableModels(models.runtime)).find(
        (item) => item.provider === provider && item.model === model,
      );
      if (!selected) throw new ORPCError("PRECONDITION_FAILED", { message: "此模型当前不可用" });
      await this.load();
      await updateStoredAppSettings(this.configPath, (current) => ({
        ...current,
        game: {
          ...current.game!,
          defaults: { ...current.game!.defaults, ai: { ...selected, thinkingLevel } },
        },
      }));
      return this.publicSettings(models);
    });
  }
  clearDefaultModel() {
    return this.serial(async () => {
      await this.clearDefault();
      return this.publicSettings();
    });
  }
  private async clearDefault() {
    await this.load();
    await updateStoredAppSettings(this.configPath, (current) => ({
      ...current,
      game: {
        ...current.game!,
        defaults: { ...current.game!.defaults, ai: null },
      },
    }));
  }
  connect(input: z.infer<typeof connectProviderSchema>) {
    return this.serial(async () => {
      const parsed = connectProviderSchema.parse(input);
      const models = await this.loadModels();
      const { runtime, definitions } = models;
      const builtin = this.builtins.find((provider) => provider.id === parsed.provider);
      if (parsed.custom ? Boolean(builtin) : !builtin?.auth.apiKey)
        throw new ORPCError("BAD_REQUEST", {
          message: parsed.custom
            ? "自定义服务商 ID 不能与内置服务商重复"
            : "请选择支持 API Key 的服务商",
        });
      const previous = definitions.providers[parsed.provider];
      const sameEndpoint = !parsed.custom || previous?.baseUrl === parsed.baseUrl;
      if (!parsed.apiKey && !(sameEndpoint && runtime.hasConfiguredAuth(parsed.provider)))
        throw new ORPCError("BAD_REQUEST", { message: "请填写此服务的 API Key" });
      if (parsed.custom) {
        if (!parsed.baseUrl || !parsed.model || !parsed.api)
          throw new ORPCError("BAD_REQUEST", { message: "请填写接口地址、协议和模型 ID" });
        const url = new URL(parsed.baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new ORPCError("BAD_REQUEST", {
            message: "接口地址必须使用 HTTP(S)，不能包含账号或密码",
          });
        // 地址改变时先撤销旧密钥，避免配置更新失败后向新地址发送原密钥。
        if (!sameEndpoint) await runtime.logout(parsed.provider);
        models.definitions = await this.modelsOperation(() =>
          this.modelsFile().update((current) => ({
            providers: {
              ...current.providers,
              [parsed.provider]: {
                ...current.providers[parsed.provider],
                api: parsed.api,
                baseUrl: parsed.baseUrl,
                authHeader: true,
                models: [
                  {
                    ...previous?.models?.find((model) => model.id === parsed.model),
                    id: parsed.model!,
                    ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
                  },
                  ...(previous?.models?.filter((model) => model.id !== parsed.model) ?? []),
                ],
              },
            },
          })),
        );
        await this.refreshRuntime(runtime);
      }
      // pi 的登录与登出会同步凭据状态，无需再次刷新整个模型目录。
      if (parsed.apiKey)
        await runtime.login(parsed.provider, "api_key", {
          prompt: async (prompt) => {
            if (prompt.type !== "secret")
              throw new ORPCError("BAD_REQUEST", {
                message: "此服务商还需要额外认证参数，请按服务商要求配置环境变量。",
              });
            return parsed.apiKey!;
          },
          notify: () => {},
        });
      return this.publicSettings(models);
    });
  }
  disconnect(provider: string) {
    return this.serial(async () => {
      const models = await this.loadModels();
      const { runtime } = models;
      await runtime.logout(provider);
      if (models.definitions.providers[provider]) {
        models.definitions = await this.modelsOperation(() =>
          this.modelsFile().update((current) => {
            const providers = { ...current.providers };
            delete providers[provider];
            return { providers };
          }),
        );
        await this.refreshRuntime(runtime);
      }
      return this.publicSettings(models);
    });
  }
  async credentialsFor(selection: AvailableAiModel) {
    const runtime = await this.modelRuntime();
    if (
      !(await runtime.getAvailable(selection.provider)).some(
        (model) => model.id === selection.model,
      )
    )
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "此模型连接不可用，请重新连接服务商或选择模型。",
      });
    return {
      config: {
        provider: selection.provider,
        model: selection.model,
        thinkingLevel: selection.thinkingLevel,
      },
    };
  }
}
