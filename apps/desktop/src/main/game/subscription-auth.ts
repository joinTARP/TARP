import { randomUUID } from "node:crypto";

import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { ModelRuntime } from "@tarp/core/node/agent/models";

// 桌面主进程会被 Bun 打包，pi 的变量路径动态导入无法随包发布。
registerBunOAuthFlows();

const providerId = "openai-codex";

export type SubscriptionRuntime = Pick<ModelRuntime, "listCredentials" | "login" | "logout">;

export class SubscriptionAuth {
  private operations: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.operations.then(fn);
    this.operations = task.catch(() => undefined);
    return task;
  }
  private attempt?: { id: string; controller: AbortController; done: Promise<void> };
  private answer?: (value: string) => void;
  private state: {
    status: "idle" | "pending" | "success" | "error";
    id?: string;
    message?: string;
    manual?: boolean;
    userCode?: string;
  } = { status: "idle" };
  constructor(
    private models: () => Promise<SubscriptionRuntime>,
    private openExternal: (url: string) => Promise<unknown>,
  ) {}
  async status() {
    return {
      ...this.state,
      connected: (await (await this.models()).listCredentials()).some(
        (value) => value.providerId === providerId,
      ),
    };
  }
  start(method: "browser" | "device_code") {
    return this.serial(() => this.startLogin(method));
  }
  private async startLogin(method: "browser" | "device_code") {
    await this.cancelLogin();
    const id = randomUUID();
    const controller = new AbortController();
    this.state = { status: "pending", id, message: "正在打开浏览器…" };
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    const done = (async () => {
      try {
        await (
          await this.models()
        ).login(providerId, "oauth", {
          signal: controller.signal,
          notify: (event) => {
            if (event.type !== "auth_url" && event.type !== "device_code") return;
            const url = event.type === "auth_url" ? event.url : event.verificationUri;
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com")
              throw new Error("无效的登录地址");
            this.state = {
              ...this.state,
              message: "请在浏览器中完成 ChatGPT 登录。",
              ...(event.type === "device_code" ? { userCode: event.userCode } : {}),
            };
            void this.openExternal(url).catch(() => {
              controller.abort();
            });
          },
          prompt: async (prompt) => {
            if (prompt.type === "select") return method;
            if (prompt.type !== "manual_code") throw new Error("不支持的登录步骤");
            this.state = { ...this.state, manual: true };
            const signal = prompt.signal
              ? AbortSignal.any([controller.signal, prompt.signal])
              : controller.signal;
            return new Promise<string>((resolve, reject) => {
              const cleanup = () => {
                signal.removeEventListener("abort", abort);
                this.answer = undefined;
              };
              const abort = () => {
                cleanup();
                reject(new Error("登录已取消"));
              };
              this.answer = (value) => {
                cleanup();
                resolve(value);
              };
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          },
        });
        controller.signal.throwIfAborted();
        this.state = { status: "success", id, message: "ChatGPT 账号已连接。" };
      } catch {
        this.state = {
          status: "error",
          id,
          message: controller.signal.aborted
            ? "登录已取消或超时，请重试。"
            : "登录失败，请重试；浏览器回调不可用时可改用设备码登录。",
        };
      } finally {
        clearTimeout(timer);
        this.answer = undefined;
      }
    })();
    this.attempt = { id, controller, done };
    return { id };
  }
  submit(id: string, value: string) {
    if (this.state.id !== id || this.state.status !== "pending" || !this.answer)
      throw new Error("登录步骤已失效，请重新登录。");
    this.answer(value);
  }
  cancel(id?: string) {
    return this.serial(() => this.cancelLogin(id));
  }
  private async cancelLogin(id?: string) {
    if (id && this.attempt?.id !== id) return;
    this.attempt?.controller.abort();
    await this.attempt?.done;
    this.attempt = undefined;
    this.state = { status: "idle" };
  }
  logout() {
    return this.serial(async () => {
      await this.cancelLogin();
      await (await this.models()).logout(providerId);
      return this.status();
    });
  }
}
