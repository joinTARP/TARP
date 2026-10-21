import { describe, it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createSession } from "@tarp/core/node/sessions/session-store";
import { loadDocumentTypes } from "@tarp/module/node/document-types";
import {
  loadModuleDocuments,
  loadModuleLibraryDocuments,
} from "@tarp/module/node/module-documents";
import { loadModuleMetadata } from "@tarp/module/node/module-metadata";
import { loadModulePages } from "@tarp/module/node/module-pages";
import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { documentMediaUrl } from "../../shared/document-media";
import { resolveMediaRequestFile } from "../media-path";
import { importGitModule } from "./import-git-module";
import { importLocalModule } from "./import-local-module";
import { listModules } from "./list-modules";

async function runGit(directory: string, ...args: string[]) {
  return (
    await promisify(execFile)(
      "git",
      [
        "-c",
        "user.name=测试",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=",
        ...args,
      ],
      { cwd: directory },
    )
  ).stdout.trim();
}

async function gitFixture(contentDirectory = "module") {
  const root = await mkdtemp(join(tmpdir(), "tarp-git-import-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "测试仓库");
  const directory = join(root, "模组库");
  const module = join(repository, contentDirectory);
  await mkdir(join(module, ".types"), { recursive: true });
  await writeFile(
    join(module, "module.toml"),
    'name = "Git 测试模组"\ndescription = "从 Git 导入的资料"\ncover = "封面.svg"\npages = ["导读.md"]\n',
  );
  await writeFile(join(module, ".types", "地点.fields.json"), '{"fields":{}}');
  await writeFile(join(module, "地点/入口.json"), '{"name":"旧入口"}');
  await writeFile(join(module, "封面.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  await writeFile(join(module, "导读.md"), "# 导读\n测试阅读页。");
  await writeFile(join(repository, "README.md"), "# 仓库说明\n模组内容放在 module/。");
  const git = (...args: string[]) => runGit(repository, ...args);
  await git("init", "--initial-branch=main", "--template=");
  await git("add", ".");
  await git("commit", "-m", "初始模组");
  await git("tag", "v1");
  await writeFile(join(module, "地点/入口.json"), '{"name":"新入口"}');
  await git("add", ".");
  await git("commit", "-m", "更新入口");
  return { root, repository, directory, module, git, url: pathToFileURL(repository).href };
}

describe("列出模组目录", () => {
  it("扫描内容目录，忽略隐藏文件夹，损坏的模组带 error", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarp-modules-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const valid = join(root, "灰港模组");
    await mkdir(join(valid, ".types"), { recursive: true });
    await writeFile(
      join(valid, ".types", "人物.fields.json"),
      JSON.stringify({ name: "人物", fields: {} }),
      "utf8",
    );
    await writeFile(
      join(valid, "module.json"),
      JSON.stringify({ name: "灰港模组", description: "测试模组", cover: "封面.svg" }),
      "utf8",
    );
    await writeFile(join(valid, "封面.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    await mkdir(join(root, ".hidden"), { recursive: true });
    await mkdir(join(root, "空文件夹"), { recursive: true });

    const modules = await listModules(root);
    assert.equal(modules.length, 2);
    assert.equal(modules[0]?.name, "灰港模组");
    assert.equal(modules[0]?.path, valid);
    assert.equal(modules[0]?.error, undefined);
    assert.equal(modules[0]?.cover, "封面.svg");
    assert.equal(
      await resolveMediaRequestFile(documentMediaUrl(`module:${valid}`, "", modules[0]?.cover)!),
      await realpath(join(valid, "封面.svg")),
    );
    assert.equal(modules[1]?.name, "空文件夹");
    assert.match(modules[1]?.error ?? "", /缺少 module/);
  });

  it("直接放入仓库或外层快捷方式只列出 module/，拒绝双层清单和内部链接", async () => {
    const f = await gitFixture();
    await mkdir(f.directory);
    const entry = join(f.directory, "本地仓库");
    await symlink(f.repository, entry, "dir");
    const modules = await listModules(f.directory);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]?.path, join(entry, "module"));
    assert.equal(modules[0]?.error, undefined);
    await writeFile(join(f.repository, "module.json"), '{"name":"外层清单"}');
    assert.match((await listModules(f.directory))[0]?.error ?? "", /目录结构冲突/);
    await rm(join(f.repository, "module.json"));
    await rename(f.module, join(f.root, "外部内容"));
    await symlink(join(f.root, "外部内容"), f.module, "dir");
    assert.match((await listModules(f.directory))[0]?.error ?? "", /符号链接/);
  });

  it("列表只读元数据，类型与文档问题留到打开后处理，公式不在列表执行", async () => {
    const f = await gitFixture();
    const marker = join(f.root, "公式执行记录.log");
    const record = `process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(marker)}, '执行\\n')`;
    await writeFile(
      join(f.module, ".types", "地点.fields.json"),
      JSON.stringify({
        displayWhen: `(${record}, true)`,
        fields: {
          cost: { type: "number", required: true },
          doubled: { type: "number", compute: `(${record}, $self.cost * 2)` },
        },
      }),
    );
    await writeFile(
      join(f.module, ".types", "地点.layout.json"),
      JSON.stringify({
        displayFields: {
          summary: {
            type: "text",
            label: "摘要",
            compute: `(values) => { ${record}; return String(values.doubled); }`,
          },
        },
      }),
    );
    await writeFile(join(f.module, "地点/入口.json"), '{"cost":1}');
    await writeFile(join(f.module, "地点/分组/出口.toml"), "cost = 2");
    await writeFile(join(f.module, "地点/损坏.json"), '{"cost":"错误类型"}');

    const [module] = await listModules(f.root);
    assert.equal(module?.error, undefined);
    assert.equal(module?.name, "Git 测试模组");
    await assert.rejects(readFile(marker), { code: "ENOENT" });

    const types = await loadDocumentTypes(f.module);
    const documents = await loadModuleLibraryDocuments(f.module, types);
    const opened = documents.find((document) => document.path === "地点/入口.json");
    assert.equal(opened?.values?.doubled, 2);
    assert.equal(opened?.displayValues?.summary, "2");
    assert.equal(documents.find((document) => document.path === "地点/损坏.json")?.valid, false);
    const executed = await readFile(marker, "utf8");
    assert.ok(executed.includes("执行"));

    await writeFile(join(f.module, ".types", "地点.fields.json"), "{invalid}");
    await writeFile(join(f.module, "地点/入口.json"), "{invalid}");
    assert.deepEqual(await listModules(f.root), [module]);
    assert.equal(await readFile(marker, "utf8"), executed);
    await assert.rejects(loadDocumentTypes(f.module), /地点.fields.json/);
  });

  it("模组预览采用计算后的图片引用，媒体协议能读取图片，未披露时保持隐藏", async () => {
    const f = await gitFixture();
    await writeFile(
      join(f.module, ".types", "地点.fields.json"),
      JSON.stringify({
        fields: {
          discovered: { type: "boolean" },
          sourceImage: { type: "text", visibility: "gm" },
          image: { type: "text", compute: "$self.discovered ? $self.sourceImage : null" },
        },
      }),
    );
    await writeFile(
      join(f.module, "地点/入口.json"),
      JSON.stringify({ name: "入口", discovered: true, sourceImage: "封面.svg" }),
    );
    const [module] = await listModules(f.root);
    assert.equal(module?.path, f.module);
    const types = await loadDocumentTypes(f.module);
    const [document] = await loadModuleDocuments(f.module, types, { view: "public" });
    assert.equal(document?.image, "封面.svg");
    assert.equal(
      await resolveMediaRequestFile(
        documentMediaUrl(`module:${f.module}`, document!.path, document?.image)!,
      ),
      await realpath(join(f.module, "封面.svg")),
    );
    await writeFile(
      join(f.module, "地点/入口.json"),
      JSON.stringify({ name: "入口", discovered: false, sourceImage: "封面.svg" }),
    );
    const [hidden] = await loadModuleDocuments(f.module, types, { view: "public" });
    assert.equal(hidden?.valid, true);
    assert.equal(hidden?.image, undefined);
    assert.equal(documentMediaUrl(`module:${f.module}`, hidden!.path, hidden?.image), undefined);
  });
});

describe("从 Git 导入模组", () => {
  it("导入完整浅克隆，列表、预览加载器、阅读页和封面都使用 module/", async () => {
    const f = await gitFixture();
    const imported = await importGitModule(f.directory, { url: ` ${f.url} ` });
    const repository = join(f.directory, "测试仓库");
    assert.equal(imported.path, join(repository, "module"));
    assert.equal(imported.name, "Git 测试模组");
    const modules = await listModules(f.directory);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]?.path, imported.path);
    assert.equal(modules[0]?.error, undefined);
    const metadata = await loadModuleMetadata(imported.path);
    const types = await loadDocumentTypes(imported.path);
    const documents = await loadModuleDocuments(imported.path, types);
    const pages = await loadModulePages(imported.path, metadata.pages);
    assert.equal(documents[0]?.title, "新入口");
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.error, undefined);
    assert.equal(
      await readFile(join(repository, "README.md"), "utf8"),
      await readFile(join(f.repository, "README.md"), "utf8"),
    );
    assert.equal(
      await readFile(join(repository, ".git", "shallow"), "utf8"),
      `${await f.git("rev-parse", "HEAD")}\n`,
    );
    assert.equal(await runGit(repository, "remote", "get-url", "origin"), f.url);
    assert.equal(
      await runGit(repository, "rev-parse", "--abbrev-ref", "@{upstream}"),
      "origin/main",
    );
    assert.equal(await runGit(repository, "status", "--porcelain"), "");
    assert.equal(
      await resolveMediaRequestFile(
        documentMediaUrl(`module:${imported.path}`, "", modules[0]?.cover)!,
      ),
      await realpath(join(imported.path, "封面.svg")),
    );
    assert.deepEqual(await readdir(f.directory), ["测试仓库"]);
  });

  it("手动拉取更新后列表与新冒险使用新内容，已有冒险副本不变", async () => {
    const f = await gitFixture();
    const imported = await importGitModule(f.directory, { url: f.url, ref: "main" });
    const repository = dirname(imported.path);
    const sessions = join(f.root, "冒险");
    const before = await createSession(sessions, imported.path, "更新前");
    await writeFile(join(f.module, "地点/入口.json"), '{"name":"更新后的入口"}');
    await f.git("add", ".");
    await f.git("commit", "-m", "发布更新");
    await runGit(repository, "pull", "--ff-only");
    assert.equal(await runGit(repository, "rev-parse", "HEAD"), await f.git("rev-parse", "HEAD"));
    const modules = await listModules(f.directory);
    assert.equal(modules[0]?.path, imported.path);
    assert.equal(modules[0]?.error, undefined);
    const types = await loadDocumentTypes(modules[0]!.path);
    assert.equal((await loadModuleDocuments(modules[0]!.path, types))[0]?.title, "更新后的入口");
    const after = await createSession(sessions, modules[0]!.path, "更新后");
    const content = async (id: string) =>
      JSON.parse(await readFile(join(sessions, id, "module", "地点/入口.json"), "utf8")).name;
    assert.equal(await content(before.id), "新入口");
    assert.equal(await content(after.id), "更新后的入口");
    assert.ok(!(await readdir(join(sessions, after.id, "module"))).includes(".git"));
  });

  it("标签导入保留仓库及固定版本，并发重复导入保留已有文件", async () => {
    const f = await gitFixture();
    const input = { url: f.url, ref: "v1" };
    const results = await Promise.allSettled([
      importGitModule(f.directory, input),
      importGitModule(f.directory, input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && /已存在/.test(rejected.reason.message));
    const repository = join(f.directory, "测试仓库");
    assert.equal(
      JSON.parse(await readFile(join(repository, "module", "地点/入口.json"), "utf8")).name,
      "旧入口",
    );
    assert.ok((await readdir(repository)).includes(".git"));
    assert.equal(await runGit(repository, "rev-parse", "HEAD"), await f.git("rev-parse", "v1"));
    assert.equal(await runGit(repository, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal((await listModules(f.directory))[0]?.path, join(repository, "module"));
    assert.deepEqual(await readdir(f.directory), ["测试仓库"]);
  });

  it("下载和配置失败清理半成品，修复后可以重试", async () => {
    const f = await gitFixture();
    await assert.rejects(
      importGitModule(f.directory, { url: f.url, ref: "不存在的分支" }),
      /Git 下载失败/,
    );
    await writeFile(join(f.module, ".types", "地点.fields.json"), "{invalid}");
    await f.git("add", ".");
    await f.git("commit", "-m", "损坏类型配置");
    await assert.rejects(importGitModule(f.directory, { url: f.url }), /地点.fields.json/);
    assert.deepEqual(await readdir(f.directory), []);
    await importGitModule(f.directory, { url: f.url, ref: "v1" });
    assert.equal((await listModules(f.directory)).length, 1);
  });

  it("Git 仓库必须提供固定 module/，拒绝根目录清单和双层清单", async () => {
    const f = await gitFixture("");
    await assert.rejects(importGitModule(f.directory, { url: f.url }), /固定的 module/);
    const files = ["module.toml", ".types", "地点", "封面.svg", "导读.md"];
    await mkdir(join(f.repository, "module"));
    for (const file of files)
      await rename(join(f.repository, file), join(f.repository, "module", file));
    await writeFile(join(f.repository, "module.json"), '{"name":"外层清单"}');
    await f.git("add", ".");
    await f.git("commit", "-m", "双层清单");
    await assert.rejects(importGitModule(f.directory, { url: f.url }), /目录结构冲突/);
    await rm(join(f.repository, "module.json"));
    await rm(join(f.repository, "module"), { recursive: true });
    await f.git("add", ".");
    await f.git("commit", "-m", "移除模组内容");
    await assert.rejects(importGitModule(f.directory, { url: f.url }), /缺少 module/);
    assert.deepEqual(await readdir(f.directory), []);
  });

  it("拒绝命令选项和仓库符号链接，保护本机文件", async () => {
    const f = await gitFixture();
    await assert.rejects(
      importGitModule(f.directory, { url: "--upload-pack=恶意命令" }),
      /仓库地址/,
    );
    await assert.rejects(
      importGitModule(f.directory, { url: "ext::恶意命令" }),
      /请输入有效的 Git 仓库地址/,
    );
    await assert.rejects(
      importGitModule(f.directory, { url: "ssh://-option/repo.git" }),
      /格式无效/,
    );
    await assert.rejects(
      importGitModule(f.directory, { url: f.url, ref: "--upload-pack=恶意命令" }),
      /格式无效/,
    );
    const outside = join(f.root, "本机秘密.txt");
    await writeFile(outside, "本机资料");
    await symlink(outside, join(f.module, "外部.txt"));
    await f.git("add", ".");
    await f.git("commit", "-m", "外部链接");
    await assert.rejects(importGitModule(f.directory, { url: f.url }), /符号链接/);
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(await readFile(outside, "utf8"), "本机资料");
  });
});

describe("从文件夹与 ZIP 导入模组", () => {
  it("内容文件夹和仓库外层只复制模组内容，源仓库保持不变", async () => {
    const f = await gitFixture();
    for (const source of [f.module, f.repository]) {
      const imported = await importLocalModule(f.directory, source, "folder");
      assert.equal(dirname(imported.path), f.directory);
      assert.equal(
        JSON.parse(await readFile(join(imported.path, "地点/入口.json"), "utf8")).name,
        "新入口",
      );
      const files = await readdir(imported.path);
      assert.ok(!files.includes(".git"));
      assert.ok(!files.includes("README.md"));
    }
    const modules = await listModules(f.directory);
    assert.equal(modules.length, 2);
    assert.ok(
      modules.every((module) => module.error === undefined && module.name === "Git 测试模组"),
    );
    assert.equal(await f.git("status", "--porcelain"), "");
    await writeFile(join(f.repository, "module.json"), '{"name":"外层清单"}');
    await assert.rejects(
      importLocalModule(join(f.root, "冲突导入"), f.repository, "folder"),
      /目录结构冲突/,
    );
    assert.deepEqual(await readdir(join(f.root, "冲突导入")), []);
  });

  it("ZIP 仍识别外层目录和唯一模组，多个候选失败时清理", async () => {
    const f = await gitFixture();
    const archive = join(f.root, "模组.zip");
    await f.git("archive", "--format=zip", `--output=${archive}`, "HEAD");
    const imported = await importLocalModule(f.directory, archive, "zip");
    assert.equal(imported.path, join(f.directory, "模组"));
    assert.equal((await listModules(f.directory))[0]?.path, imported.path);
    assert.ok(!(await readdir(imported.path)).includes(".git"));
    await mkdir(join(f.repository, "其他模组"));
    await writeFile(join(f.repository, "其他模组", "module.json"), '{"name":"其他模组"}');
    await f.git("add", ".");
    await f.git("commit", "-m", "另一个模组");
    const multiple = join(f.root, "多个模组.zip");
    await f.git("archive", "--format=zip", `--output=${multiple}`, "HEAD");
    await assert.rejects(importLocalModule(f.directory, multiple, "zip"), /包含多个模组/);
    assert.deepEqual(await readdir(f.directory), ["模组"]);
  });
});
