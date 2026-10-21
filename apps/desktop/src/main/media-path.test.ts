import { describe, it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@tarp/module/testing/files";

import { documentMediaUrl } from "../shared/document-media";
import { allowDocumentMediaRoots, resolveMediaRequestFile } from "./media-path";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tarp-media-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const module = join(root, "module");
  const outside = join(root, "outside");
  await mkdir(module);
  await mkdir(outside);
  return { root, module, outside };
}

async function directoryLink(target: string, path: string) {
  // Windows junction 不要求创建文件符号链接的开发者权限。
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("模组媒体路径", () => {
  it("展示时生成文档媒体地址，请求时解析旁置图片并优先使用本局覆盖", async () => {
    const f = await fixture();
    const game = join(f.root, "game");
    await mkdir(join(game, "人物"), { recursive: true });
    await mkdir(join(f.module, "人物"));
    const original = join(f.module, "人物/向导头像.webp");
    const override = join(game, "人物/向导头像.webp");
    await writeFile(original, "原始头像");
    const scope = `room:${f.root}`;
    allowDocumentMediaRoots(scope, [game, f.module]);
    const url = documentMediaUrl(scope, "人物/向导.json", "向导头像.webp")!;
    for (const image of ["向导头像.webp", "人物/向导头像.webp", original])
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "人物/向导.json", image)!),
        original,
      );
    await writeFile(override, "本局头像");
    assert.equal(await resolveMediaRequestFile(url), override);
    await rm(override);
    assert.equal(await resolveMediaRequestFile(url), original);
    assert.equal(
      documentMediaUrl(scope, "", "https://example.test/头像.webp"),
      "https://example.test/头像.webp",
    );
    assert.equal(
      await resolveMediaRequestFile(documentMediaUrl("未注册", "", "向导头像.webp")!),
      undefined,
    );
    assert.equal(
      await resolveMediaRequestFile(documentMediaUrl(scope, "", "缺失.webp")!),
      undefined,
    );
  });

  it("文档媒体请求拒绝越界，其他来源已注册也不能扩大当前来源权限", async () => {
    const f = await fixture();
    const secret = join(f.outside, "secret.png");
    await writeFile(secret, "其他模组图片");
    allowDocumentMediaRoots(`module:${f.outside}`, [f.outside]);
    const scope = `module:${f.module}`;
    allowDocumentMediaRoots(scope, [f.module]);
    await symlink(secret, join(f.module, "头像.png"));
    for (const image of ["头像.png", "../outside/secret.png", secret])
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "人物/甲.json", image)!),
        undefined,
      );
  });

  it("拒绝文件和目录符号链接指向模组外图片，包括链接链和绝对路径请求", async () => {
    const f = await fixture();
    const outsideImage = join(f.outside, "secret.png");
    await writeFile(outsideImage, "outside fixture");
    await symlink(outsideImage, join(f.module, "cover.png"));
    await symlink(join(f.module, "cover.png"), join(f.module, "chain.png"));
    await directoryLink(f.outside, join(f.module, "图片"));
    const scope = `module:${f.module}`;
    allowDocumentMediaRoots(scope, [f.module]);
    for (const image of ["cover.png", "chain.png", "图片/secret.png", outsideImage])
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "人物/测试.json", image)!),
        undefined,
      );
  });

  it("保留目录内链接及根目录别名，协议返回真实文件路径", async () => {
    const f = await fixture();
    const images = join(f.module, "图片");
    await mkdir(images);
    const image = join(images, "封面.svg");
    await writeFile(image, "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    await symlink(image, join(f.module, "cover.svg"));
    await directoryLink(images, join(f.module, "图库"));
    const alias = join(f.root, "module-alias");
    await directoryLink(f.module, alias);
    for (const [root, path] of [
      [f.module, "cover.svg"],
      [f.module, "图库/封面.svg"],
      [alias, "图片/封面.svg"],
    ]) {
      const scope = `module:${root}`;
      allowDocumentMediaRoots(scope, [root]);
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "人物/测试.json", path)!),
        image,
      );
    }
  });

  it("拒绝不存在的文件、图片后缀目录、伪装的非图片链接和非法 URL", async () => {
    const f = await fixture();
    await mkdir(join(f.module, "directory.png"));
    await writeFile(join(f.module, "notes.txt"), "fixture text");
    await symlink(join(f.module, "notes.txt"), join(f.module, "disguised.png"));
    const scope = `module:${f.module}`;
    allowDocumentMediaRoots(scope, [f.module]);
    for (const image of ["missing.png", "directory.png", "notes.txt", "disguised.png"])
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "人物/测试.json", image)!),
        undefined,
      );
    for (const url of [
      "tarp://document/%?path=&image=cover.png",
      "tarp://other/image.png",
      "tarp://asset/relative.png",
      "file:///image.png",
      `tarp://document/${encodeURIComponent(scope)}?image=cover.png`,
    ])
      assert.equal(await resolveMediaRequestFile(url), undefined);
  });

  it("生成 URL 后链接改为指向目录外文件，协议请求仍拒绝读取", async () => {
    const f = await fixture();
    const inside = join(f.module, "inside.png");
    const outside = join(f.outside, "outside.png");
    const link = join(f.module, "cover.png");
    await writeFile(inside, "inside fixture");
    await writeFile(outside, "outside fixture");
    await symlink(inside, link);
    const scope = `module:${f.module}`;
    allowDocumentMediaRoots(scope, [f.module]);
    const url = documentMediaUrl(scope, "人物/测试.json", "cover.png")!;
    assert.equal(await resolveMediaRequestFile(url), inside);
    await rm(link);
    await symlink(outside, link);
    assert.equal(await resolveMediaRequestFile(url), undefined);
  });

  it("已注册根目录被替换成目录外链接时，不自动扩大授权范围", async () => {
    const f = await fixture();
    const image = join(f.module, "cover.png");
    await writeFile(image, "inside fixture");
    await writeFile(join(f.outside, "cover.png"), "outside fixture");
    const scope = `module:${f.module}`;
    allowDocumentMediaRoots(scope, [f.module]);
    const url = documentMediaUrl(scope, "", "cover.png")!;
    assert.equal(await resolveMediaRequestFile(url), image);
    await rename(f.module, join(f.root, "original-module"));
    await directoryLink(f.outside, f.module);
    assert.equal(await resolveMediaRequestFile(url), undefined);
  });
});
