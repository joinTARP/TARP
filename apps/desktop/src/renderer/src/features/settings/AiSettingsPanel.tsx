import { customAiApis, type AiProviderSettings, type AiSettings } from "@tarp/core/shared/game";
import { Check, ChevronRight, Eye, EyeOff, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel, Form } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { desktopRpc } from "../../desktop-rpc";
import { errorMessage } from "../sessions/game-client";
import { SearchField } from "./ModelPicker";
import { SubscriptionLogin } from "./SubscriptionLogin";

type Option = { id: string; name: string };
type SettingsDialog =
  | { type: "providers" }
  | { type: "subscription" }
  | { type: "api"; provider?: Option; custom?: boolean; service?: AiProviderSettings }
  | { type: "disconnect"; service: AiProviderSettings };

export function AiSettingsPanel({
  onSaved,
  embedded = false,
}: {
  onSaved?: (settings: AiSettings) => void;
  embedded?: boolean;
}) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [providers, setProviders] = useState<Option[]>([]);
  const [connected, setConnected] = useState(false);
  const [dialog, setDialog] = useState<SettingsDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([
      desktopRpc.ai.get(),
      desktopRpc.ai.providers(),
      desktopRpc.ai.subscription.status(),
    ])
      .then(([value, options, subscription]) => {
        if (!active) return;
        setSettings(value);
        setProviders(options);
        setConnected(subscription.connected);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const authenticated = useCallback(() => {
    setDialog(null);
    setReload((value) => value + 1);
    setNotice("服务商已连接。可设置新冒险的默认模型。");
  }, []);

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setError("");
    setReload((value) => value + 1);
  }
  function openDialog(next: SettingsDialog) {
    setError("");
    setNotice("");
    setDialog(next);
  }

  async function disconnect(service: AiProviderSettings) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await desktopRpc.ai.disconnect({ provider: service.id });
      setSettings(value);
      setDialog(null);
      setReload((value) => value + 1);
      setNotice("已断开服务商连接。");
      onSaved?.(value);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const apiServices = settings?.providers ?? [];
  const title =
    dialog?.type === "providers"
      ? "连接服务商"
      : dialog?.type === "subscription"
        ? "ChatGPT 订阅"
        : dialog?.type === "disconnect"
          ? "断开连接"
          : dialog?.service
            ? "管理服务商"
            : "连接服务商";

  return (
    <>
      {embedded ? (
        <header className="px-9 pt-5">
          <h2 className="text-xl font-semibold">模型配置</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            管理服务商连接与可选模型。新冒险的默认模型在冒险默认设置中选择。
          </p>
        </header>
      ) : (
        <PageToolbarHeader
          widthClassName="max-w-4xl"
          title="模型配置"
          description="管理服务商连接与可选模型。新冒险的默认模型在冒险默认设置中选择。"
        />
      )}
      <div className="mx-auto max-w-4xl space-y-8 px-9 pt-8 pb-8">
        {loading && !settings ? (
          <p role="status" className="text-muted-foreground text-sm">
            正在读取 AI 设置…
          </p>
        ) : null}
        {settings ? (
          <>
            <section className="space-y-3" aria-label="服务商">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">服务商</h3>
                <Button
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => openDialog({ type: "providers" })}
                >
                  <Plus aria-hidden="true" />
                  连接服务商
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                每个服务连接一次，即可供不同冒险选择使用。
              </p>
              {!connected && apiServices.length === 0 ? (
                <p className="text-muted-foreground text-sm">尚未连接服务商。</p>
              ) : (
                <div className="border-border divide-border divide-y rounded-xl border">
                  {connected ? (
                    <div className="flex flex-wrap items-center gap-4 p-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <h4 className="text-sm font-medium">ChatGPT</h4>
                        <p className="text-muted-foreground text-xs">订阅账号 · 已连接</p>
                      </div>
                      <Check className="text-primary size-4" aria-label="已连接" />
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => openDialog({ type: "subscription" })}
                      >
                        管理账号
                      </Button>
                    </div>
                  ) : null}
                  {apiServices.map((service) => (
                    <div key={service.id} className="flex flex-wrap items-center gap-4 p-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <h4 className="text-sm font-medium break-all">{service.name}</h4>
                        <p className="text-muted-foreground text-xs break-all">
                          {service.custom
                            ? service.baseUrl
                            : (providers.find((provider) => provider.id === service.id)?.name ??
                              service.id)}{" "}
                          · {service.hasKey ? "已连接" : "需要填写密钥"}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          openDialog({
                            type: "api",
                            service,
                            custom: service.custom,
                            provider: providers.find((item) => item.id === service.id) ?? {
                              id: service.id,
                              name: service.id,
                            },
                          })
                        }
                      >
                        管理
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => openDialog({ type: "disconnect", service })}
                      >
                        断开
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
        {notice ? (
          <p role="status" className="text-muted-foreground text-sm">
            {notice}
          </p>
        ) : null}
        {error && !dialog ? (
          <div role="alert" className="text-destructive text-sm">
            {error}
            <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
              重试
            </Button>
          </div>
        ) : null}
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent
          showCloseButton={false}
          overlayClassName="z-[110] bg-black/30 backdrop-blur-xs"
          className="z-[120] flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-6 shadow-xl sm:max-w-xl"
        >
          <ScrollAreaPane className="min-h-0 flex-1">
            <div className="mb-5 space-y-2">
              <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
              <DialogDescription>
                {dialog?.type === "providers"
                  ? "选择服务商，再登录账号或填写 API Key。"
                  : dialog?.type === "disconnect"
                    ? "断开后，此连接的模型将从可选列表中移除。"
                    : "连接信息保存在这台设备上。"}
              </DialogDescription>
            </div>
            {dialog?.type === "providers" ? (
              <ProviderChooser
                providers={providers}
                services={apiServices}
                connected={connected}
                onSubscription={() => openDialog({ type: "subscription" })}
                onApi={(provider) =>
                  openDialog({
                    type: "api",
                    provider,
                    service: apiServices.find(
                      (service) => !service.custom && service.id === provider.id,
                    ),
                  })
                }
                onCustom={() => openDialog({ type: "api", custom: true })}
              />
            ) : null}
            {dialog?.type === "subscription" ? (
              <SubscriptionLogin onConnected={setConnected} onAuthenticated={authenticated} />
            ) : null}
            {dialog?.type === "api" ? (
              <ProviderForm
                key={dialog.service?.id ?? dialog.provider?.id ?? "custom"}
                provider={dialog.provider}
                service={dialog.service}
                custom={dialog.custom ?? false}
                onBusyChange={setBusy}
                onSaved={(value) => {
                  setSettings(value);
                  authenticated();
                  onSaved?.(value);
                }}
                onCancel={closeDialog}
              />
            ) : null}
            {dialog?.type === "disconnect" ? (
              <div className="space-y-4">
                <p className="text-sm break-all">
                  断开“{dialog.service.name}”？ 使用此连接的冒险需要重新选择可用模型。
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" disabled={busy} onClick={closeDialog}>
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => dialog.type === "disconnect" && void disconnect(dialog.service)}
                  >
                    {busy ? "正在断开…" : "断开连接"}
                  </Button>
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive mt-3 text-sm">
                {error}
              </p>
            ) : null}
            {dialog && dialog.type !== "api" && dialog.type !== "disconnect" ? (
              <div className="border-border mt-5 flex justify-end border-t pt-4">
                <Button variant="outline" disabled={busy} onClick={closeDialog}>
                  关闭
                </Button>
              </div>
            ) : null}
          </ScrollAreaPane>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProviderChooser({
  providers,
  services,
  connected,
  onSubscription,
  onApi,
  onCustom,
}: {
  providers: Option[];
  services: AiProviderSettings[];
  connected: boolean;
  onSubscription: () => void;
  onApi: (provider: Option) => void;
  onCustom: () => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const options = [
    {
      id: "subscription",
      name: "ChatGPT / OpenAI Codex",
      description: "订阅登录",
      connected,
      action: onSubscription,
    },
    ...providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      description: "API Key",
      connected: services.some(
        (service) => !service.custom && service.id === provider.id && service.hasKey,
      ),
      action: () => onApi(provider),
    })),
    {
      id: "custom",
      name: "自定义服务",
      description: "兼容模型接口",
      connected: false,
      action: onCustom,
    },
  ].filter((option) =>
    `${option.id} ${option.name} ${option.description}`.toLowerCase().includes(query),
  );
  return (
    <div className="space-y-3">
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="搜索服务商，例如 ChatGPT、DeepSeek"
      />
      <ScrollAreaPane className="h-[min(20rem,40vh)]" contentClassName="space-y-1">
        {options.map((option) => (
          <button
            type="button"
            key={option.id}
            className="hover:bg-muted focus-visible:outline-ring flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left outline-none focus-visible:outline-1 focus-visible:outline-offset-2"
            onClick={option.action}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.name}</span>
              <span className="text-muted-foreground mt-1 block text-xs">{option.description}</span>
            </span>
            {option.connected ? <span className="text-primary text-xs">已连接</span> : null}
            <ChevronRight className="text-muted-foreground size-4" aria-hidden="true" />
          </button>
        ))}
        {!options.length ? (
          <p className="text-muted-foreground p-4 text-sm">没有匹配的服务商。</p>
        ) : null}
      </ScrollAreaPane>
    </div>
  );
}

function ProviderForm({
  provider,
  service,
  custom,
  onBusyChange,
  onSaved,
  onCancel,
}: {
  provider?: Option;
  service?: AiProviderSettings;
  custom: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: (settings: AiSettings) => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? "");
  const [reasoning, setReasoning] = useState(service?.reasoning ?? false);
  const [model, setModel] = useState(service?.model ?? "");
  const [providerId, setProviderId] = useState(service?.id ?? "");
  const [api, setApi] = useState<(typeof customAiApis)[number]>(
    service?.api ?? "openai-completions",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retainsKey = Boolean(service?.hasKey && (!custom || service.baseUrl === baseUrl.trim()));
  async function save() {
    if (busy) return;
    setError("");
    if (!apiKey.trim() && !retainsKey) {
      setError("请填写此服务的 API Key。");
      return;
    }
    if (
      custom &&
      (!/^[a-z0-9][a-z0-9-]*$/.test(providerId.trim()) ||
        !/^https?:\/\//i.test(baseUrl.trim()) ||
        !model.trim())
    ) {
      setError("请填写服务商 ID、HTTP(S) 服务地址和模型 ID。");
      return;
    }
    setBusy(true);
    onBusyChange(true);
    try {
      const value = await desktopRpc.ai.connect({
        provider: custom ? providerId.trim() : provider!.id,
        custom,
        ...(custom ? { baseUrl: baseUrl.trim(), api, model: model.trim(), reasoning } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      onSaved(value);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <Form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <p className="text-sm font-medium">{custom ? "自定义兼容服务" : provider?.name}</p>
        {custom ? (
          <>
            <Field
              name="providerId"
              className="space-y-2 text-sm"
              validate={(value) =>
                /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? "").trim())
                  ? null
                  : "请填写服务商 ID，使用小写字母、数字和连字符。"
              }
            >
              <FieldLabel>服务商 ID</FieldLabel>
              <Input
                aria-required
                value={providerId}
                disabled={Boolean(service)}
                onChange={(event) => setProviderId(event.target.value)}
                placeholder="例如 my-service"
              />
              <FieldDescription className="text-muted-foreground block text-xs">
                使用小写字母、数字和连字符。每个服务商保存一套连接。
              </FieldDescription>
              <FieldError />
            </Field>
            <Field name="api" className="space-y-2 text-sm">
              <FieldLabel>接口协议</FieldLabel>
              <Select
                items={[
                  { value: "openai-completions", label: "OpenAI Chat Completions" },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic-messages", label: "Anthropic Messages" },
                  { value: "google-generative-ai", label: "Google Generative AI" },
                ]}
                value={api}
                onValueChange={(value) => value && setApi(value as (typeof customAiApis)[number])}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
                  <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
                  <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                  <SelectItem value="google-generative-ai">Google Generative AI</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              name="baseUrl"
              className="space-y-2 text-sm"
              validate={(value) => {
                try {
                  const url = new URL(String(value ?? "").trim());
                  if (["http:", "https:"].includes(url.protocol) && url.hostname) return null;
                } catch {
                  /* 字段下方显示地址错误。 */
                }
                return "请填写有效的 HTTP(S) 服务地址。";
              }}
            >
              <FieldLabel>服务地址</FieldLabel>
              <Input
                aria-required
                inputMode="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://example.com/v1"
              />
              <FieldError />
            </Field>
            <Field
              name="model"
              className="space-y-2 text-sm"
              validate={(value) => (String(value ?? "").trim() ? null : "请填写模型 ID。")}
            >
              <FieldLabel>模型 ID</FieldLabel>
              <Input
                aria-required
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="填写服务商提供的模型 ID"
              />
              <FieldDescription className="text-muted-foreground block text-xs">
                自定义接口需要手动指定模型。
              </FieldDescription>
              <FieldError />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(event) => setReasoning(event.target.checked)}
                disabled={busy}
              />
              此模型支持推理（可设置推理强度）
            </label>
          </>
        ) : null}
        <Field
          name="apiKey"
          className="space-y-2"
          validate={(value) =>
            String(value ?? "").trim() || retainsKey ? null : "请填写此服务的 API Key。"
          }
        >
          <FieldLabel htmlFor="provider-api-key" className="text-sm">
            API Key
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              autoFocus
              id="provider-api-key"
              aria-required={!retainsKey}
              value={apiKey}
              type={showKey ? "text" : "password"}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={retainsKey ? "已保存，留空保留原密钥" : "粘贴服务商的 API Key"}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              aria-pressed={showKey}
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <FieldDescription className="text-muted-foreground text-xs">
            {custom ? "密钥用于此接口地址。" : "连接后即可在模型列表中选择此服务商的模型。"}
          </FieldDescription>
          <FieldError />
        </Field>
      </fieldset>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="border-border flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "正在保存…" : "保存配置"}
        </Button>
      </div>
    </Form>
  );
}
