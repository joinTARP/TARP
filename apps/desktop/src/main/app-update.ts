import type { AppUpdateStatus } from "@shared/app-update";
import type { Updater } from "electrobun/main";

type UpdateRuntime = Pick<
  typeof Updater,
  | "getLocalInfo"
  | "checkForUpdate"
  | "downloadUpdate"
  | "updateInfo"
  | "onStatusChange"
  | "applyUpdate"
>;

const githubUpdateUrl = "https://github.com/joinTARP/TARP/releases/latest/download";
const updateSources = [
  { name: "GH-Proxy", url: `https://gh-proxy.com/${githubUpdateUrl}` },
  { name: "GHFast", url: `https://ghfast.top/${githubUpdateUrl}` },
  { name: "GitHub", url: githubUpdateUrl },
];

export function createAcceleratedUpdater(updater: UpdateRuntime): UpdateRuntime {
  const getLocalInfo = updater.getLocalInfo.bind(updater);
  let sourceIndex = 0;
  // shortcut: Electrobun 2.0.4 从此公开方法读取全部更新 URL；有正式切源接口后替换。
  updater.getLocalInfo = async () => ({
    ...(await getLocalInfo()),
    baseUrl: updateSources[sourceIndex]!.url,
  });

  async function trySources<T>(operation: () => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (; sourceIndex < updateSources.length; sourceIndex++) {
      try {
        return await operation();
      } catch (error) {
        errors.push(
          `${updateSources[sourceIndex]!.name}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    sourceIndex = 0;
    throw new Error(`所有更新线路均失败，请稍后重试。${errors.join("；")}`);
  }

  return {
    ...updater,
    checkForUpdate: () => {
      sourceIndex = 0;
      return trySources(async () => {
        const info = await updater.checkForUpdate();
        if (info.error) throw new Error(info.error);
        return info;
      });
    },
    downloadUpdate: () =>
      trySources(async () => {
        await updater.downloadUpdate();
        const info = updater.updateInfo();
        if (info.error || !info.updateReady) throw new Error(info.error || "更新归档尚未准备完成");
      }),
  };
}

export class AppUpdateService {
  private status: AppUpdateStatus;

  constructor(
    private readonly runtime: UpdateRuntime,
    currentVersion: string,
    private readonly confirmRestart: () => Promise<boolean>,
  ) {
    this.status = { state: "idle", currentVersion };
    runtime.onStatusChange((entry) => {
      if (this.status.state === "downloading" && entry.status === "download-starting") {
        this.status = { ...this.status, progress: undefined };
      }
      if (this.status.state === "downloading" && entry.status === "download-progress") {
        const progress = entry.details?.progress;
        if (typeof progress === "number" && Number.isFinite(progress)) {
          this.status = { ...this.status, progress: Math.max(0, Math.min(100, progress)) };
        }
      }
    });
  }

  get(): AppUpdateStatus {
    return this.status;
  }

  async check(): Promise<AppUpdateStatus> {
    if (["checking", "downloading", "ready", "installing"].includes(this.status.state))
      return this.status;
    this.status = { state: "checking", currentVersion: this.status.currentVersion };
    try {
      const local = await this.runtime.getLocalInfo();
      this.status = { ...this.status, currentVersion: local.version };
      // shortcut: 仅跟踪稳定正式版；提供预发布更新源时再开放其他通道。
      if (local.channel !== "stable" || !/^\d+\.\d+\.\d+$/.test(local.version)) {
        this.status = { ...this.status, state: "disabled" };
        return this.status;
      }
      const update = await this.runtime.checkForUpdate();
      if (update.error) throw new Error(update.error);
      const remote = update.version.split(".").map(Number);
      const current = local.version.split(".").map(Number);
      const different = remote.findIndex((part, index) => part !== current[index]);
      const newer =
        /^\d+\.\d+\.\d+$/.test(update.version) &&
        different >= 0 &&
        remote[different]! > current[different]!;
      this.status = {
        currentVersion: local.version,
        state:
          update.updateAvailable && newer
            ? update.updateReady
              ? "ready"
              : "available"
            : "current",
        ...(update.updateAvailable && newer ? { version: update.version } : {}),
      };
    } catch (error) {
      this.fail(error);
    }
    return this.status;
  }

  async download(): Promise<AppUpdateStatus> {
    if (this.status.state !== "available") throw new Error("请先检查可用更新");
    this.status = { ...this.status, state: "downloading", progress: undefined, error: undefined };
    try {
      await this.runtime.downloadUpdate();
      const update = this.runtime.updateInfo();
      if (update.error || !update.updateReady)
        throw new Error(update.error || "更新尚未准备完成，请重新检查后重试");
      this.status = { ...this.status, state: "ready", progress: undefined };
    } catch (error) {
      this.fail(error);
    }
    return this.status;
  }

  async restart(): Promise<AppUpdateStatus> {
    if (this.status.state !== "ready") throw new Error("更新尚未准备完成");
    this.status = { ...this.status, state: "installing" };
    try {
      if (!(await this.confirmRestart())) {
        this.status = { ...this.status, state: "ready" };
        return this.status;
      }
      await this.runtime.applyUpdate();
      if (this.runtime.updateInfo().error) throw new Error(this.runtime.updateInfo().error);
    } catch (error) {
      this.fail(error);
    }
    return this.status;
  }

  private fail(error: unknown) {
    this.status = {
      ...this.status,
      state: "error",
      progress: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
