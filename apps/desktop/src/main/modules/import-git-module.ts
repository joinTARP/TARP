import { execFile } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { withFileMutation, isMissingFile } from "@jointarp/core/node/storage/file-queue";
import { githubRepository } from "@shared/module-import";

import { assertNoSymlinks, moduleFolderName, publishModule } from "./module-import";
import { resolveModuleRoot } from "./module-root";

const runGit = promisify(execFile);

export interface ImportGitModuleInput {
  readonly url: string;
  readonly replacePath?: string;
}

function repositoryAddress(value: string): { url: string; name: string } {
  const url = value.trim();
  if (!url || /[\s\u0000-\u001f\u007f]/u.test(url)) {
    throw new Error("请输入有效的 Git 仓库地址。");
  }
  let path: string;
  const scp = url.match(/^(?:[\w.-]+@)?([\w][\w.-]*):(.+)$/u);
  if (scp && !url.includes("://")) {
    if (scp[2].startsWith(":")) throw new Error("请输入有效的 Git 仓库地址。");
    if (scp[2].startsWith("-")) throw new Error("Git 仓库路径不能以 - 开头。");
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("请输入 HTTPS、SSH、Git 或 file:// 仓库地址。");
    }
    if (
      !["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol) ||
      parsed.hostname.startsWith("-") ||
      parsed.search ||
      parsed.hash ||
      parsed.password ||
      (parsed.username && (parsed.protocol !== "ssh:" || !/^[\w.-]+$/u.test(parsed.username)))
    ) {
      throw new Error("Git 地址格式无效；请使用不含密码、查询参数或片段的仓库地址。");
    }
    path = decodeURIComponent(parsed.pathname);
  }
  const name = moduleFolderName(basename(path.replace(/\/+$/u, "")).replace(/\.git$/iu, ""));
  return { url, name };
}

async function cloneRepository(url: string, destination: string): Promise<void> {
  try {
    await runGit(
      "git",
      [
        "-c",
        "core.hooksPath=",
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--no-local",
        "--template=",
        "--",
        url,
        destination,
      ],
      {
        cwd: dirname(destination),
        timeout: 5 * 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
          GCM_INTERACTIVE: "never",
        },
      },
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === "ENOENT") throw new Error("未找到 Git，请安装 Git 并重启应用后重试。");
    if (failure.killed) throw new Error("Git 下载超时，请检查网络后重试。");
    const detail = failure.stderr?.trim().slice(-1500);
    throw new Error(`Git 下载失败，请检查仓库地址、网络和访问权限。${detail ? `\n${detail}` : ""}`);
  }
}

export class ExistingGitModuleError extends Error {
  constructor(readonly path: string) {
    super("该仓库已导入。替换会丢弃现有模组的本地修改，已有冒险存档不受影响。");
  }
}

function repositoryIdentity(url: string): string {
  return githubRepository(url) ?? url.replace(/\/+$/u, "");
}

export async function findImportedRepository(
  directory: string,
  url: string,
): Promise<string | undefined> {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    try {
      const config = join(path, ".git", "config");
      if (!(await lstat(join(path, ".git"))).isDirectory() || !(await lstat(config)).isFile())
        continue;
      const { stdout } = await runGit(
        "git",
        ["config", "--file", config, "--get", "remote.origin.url"],
        { timeout: 5000, windowsHide: true },
      );
      if (repositoryIdentity(stdout.trim()) === repositoryIdentity(url)) return path;
    } catch (error) {
      // 普通本地模组没有 Git 来源；读取错误不能成为覆盖它的理由。
      if (!isMissingFile(error) && (error as { killed?: boolean }).killed)
        throw new Error("读取已有模组来源超时，请重试。");
    }
  }
  return undefined;
}

export async function importGitModule(
  directory: string,
  input: ImportGitModuleInput,
): Promise<{ path: string; name: string; revision: string }> {
  const { url, name } = repositoryAddress(input.url);
  return withFileMutation(join(directory, ".git-import"), async () => {
    const existing = await findImportedRepository(directory, url);
    if (existing && input.replacePath !== existing) throw new ExistingGitModuleError(existing);
    if (input.replacePath && existing !== input.replacePath)
      throw new Error("已有模组来源已变化，请重新导入并确认。");
    const identity = githubRepository(url);
    let folderName = existing
      ? basename(existing)
      : identity
        ? moduleFolderName(identity.replace("/", "--"))
        : name;
    if (!existing) {
      const base = folderName;
      for (let index = 2; ; index++) {
        try {
          await lstat(join(directory, folderName));
          const suffix = `-${index}`;
          folderName = `${base.slice(0, 100 - suffix.length)}${suffix}`;
        } catch (error) {
          if (isMissingFile(error)) break;
          throw error;
        }
      }
    }
    let revision = "";
    const result = await publishModule(
      directory,
      folderName,
      async (staging) => {
        const repository = join(staging, "repository");
        await cloneRepository(url, repository);
        await assertNoSymlinks(repository);
        const module = await resolveModuleRoot(repository);
        if (module !== join(repository, "module"))
          throw new Error("Git 仓库必须把模组内容放在固定的 module/ 目录中。");
        revision = (
          await runGit("git", ["-C", repository, "rev-parse", "HEAD"], {
            timeout: 5000,
            windowsHide: true,
          })
        ).stdout.trim();
        return repository;
      },
      { replace: Boolean(existing) },
    );
    return { ...result, revision };
  });
}
