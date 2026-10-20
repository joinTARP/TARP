import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { assertNoSymlinks, moduleFolderName, publishModule } from "./module-import";
import { resolveModuleRoot } from "./module-root";

const runGit = promisify(execFile);

export interface ImportGitModuleInput {
  readonly url: string;
  readonly ref?: string;
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

async function cloneRepository(url: string, destination: string, ref: string): Promise<void> {
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
        ...(ref ? ["--branch", ref] : []),
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
    throw new Error(`Git 下载失败，请检查仓库地址、分支和访问权限。${detail ? `\n${detail}` : ""}`);
  }
}

export async function importGitModule(
  directory: string,
  input: ImportGitModuleInput,
): Promise<{ path: string; name: string }> {
  const { url, name } = repositoryAddress(input.url);
  const ref = input.ref?.trim() ?? "";
  if (ref.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(ref))
    throw new Error("分支或标签格式无效。");
  return publishModule(directory, name, async (staging) => {
    const repository = join(staging, "repository");
    await cloneRepository(url, repository, ref);
    await assertNoSymlinks(repository);
    const module = await resolveModuleRoot(repository);
    if (module !== join(repository, "module"))
      throw new Error("Git 仓库必须把模组内容放在固定的 module/ 目录中。");
    return repository;
  });
}
