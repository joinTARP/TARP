import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { structuredFile } from "@jointarp/core/node/storage/structured-file";
import type { McpStatus } from "@shared/mcp";
import { z } from "zod";

import type { PlaytestService } from "./playtest";
import { startPlaytestMcp } from "./server";

const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(0).max(65535),
  token: z.string().min(16),
});
type Settings = z.infer<typeof settingsSchema>;

/** 开关、启动、停止和退出串行执行；关闭后可用新的预演服务重新启用。 */
export class McpService {
  private settings?: Settings;
  private server?: Awaited<ReturnType<typeof startPlaytestMcp>>;
  private connection?: { url: string; headers: { Authorization: string } };
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private status: McpStatus = {
    enabled: false,
    state: "stopped",
    url: null,
    lastRequestAt: null,
    error: null,
  };

  constructor(
    private options: {
      directory: string;
      createPlaytest: () => PlaytestService;
      copyText: (text: string) => void;
    },
  ) {}

  private file() {
    return structuredFile(join(this.options.directory, "mcp-settings.json"), {
      validate: (value) => settingsSchema.parse(value),
      missing: () => ({ enabled: false, port: 0, token: randomBytes(32).toString("hex") }),
      fileMode: 0o600,
      directoryMode: 0o700,
    });
  }
  private serialize<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
  get(): McpStatus {
    return { ...this.status };
  }

  initialize() {
    return this.serialize(async () => {
      try {
        this.settings = await this.file().read();
        this.status.enabled = this.settings.enabled;
        if (this.status.enabled && !this.closing) await this.start();
      } catch (error) {
        this.fail(error);
      }
      return this.get();
    });
  }
  setEnabled(enabled: boolean) {
    if (this.closing) return Promise.reject(new Error("应用正在退出"));
    return this.serialize(async () => {
      this.settings ??= await this.file().read();
      const next = { ...this.settings, enabled };
      await this.file().write(next);
      this.settings = next;
      this.status.enabled = enabled;
      if (enabled && !this.closing) await this.start();
      else await this.stop();
      return this.get();
    });
  }
  private fail(error: unknown) {
    const occupied = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
    this.status = {
      ...this.status,
      state: "error",
      url: null,
      error: occupied
        ? "MCP 本地端口被占用，请关闭占用该端口的程序后重试。"
        : error instanceof Error
          ? error.message
          : "MCP 服务启动失败",
    };
  }
  private async start() {
    if (this.server) return;
    this.status = { ...this.status, state: "starting", error: null, lastRequestAt: null };
    let playtest: PlaytestService | undefined;
    try {
      const saved = this.settings!;
      const { port, token } = saved;
      playtest = this.options.createPlaytest();
      const server = await startPlaytestMcp({
        service: playtest,
        directory: this.options.directory,
        port,
        token,
        onRequest: () => {
          this.status.lastRequestAt = new Date().toISOString();
        },
      });
      try {
        // 首次自动分配端口后固定下来。
        if (saved.port === 0) {
          this.settings = { ...saved, port: Number(new URL(server.url).port) };
          await this.file().write(this.settings);
        }
      } catch (error) {
        await server.close();
        throw error;
      }
      this.server = server;
      this.connection = { url: server.url, headers: { Authorization: `Bearer ${token}` } };
      this.status = { ...this.status, state: "running", url: server.url, error: null };
    } catch (error) {
      await playtest?.close().catch(() => {});
      this.fail(error);
    }
  }
  private async stop() {
    this.status = { ...this.status, state: "stopping", error: null };
    try {
      await this.server?.close();
      this.status = { ...this.status, state: "stopped", url: null };
    } catch (error) {
      this.fail(error);
    } finally {
      this.server = undefined;
      this.connection = undefined;
    }
  }
  copyConfiguration() {
    if (this.closing || this.status.state !== "running" || !this.connection)
      throw new Error("请先开启 MCP 服务");
    this.options.copyText(
      JSON.stringify({ mcpServers: { "tarp-playtest": this.connection } }, null, 2),
    );
    return { copied: true };
  }
  close() {
    this.closing = true;
    return this.serialize(() => this.stop());
  }
}
