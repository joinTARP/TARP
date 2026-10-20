import { test } from "bun:test";
import { strict as assert } from "node:assert";

import {
  externalHttpUrl,
  isRendererPage,
  openHttpLink,
  rendererEntry,
  rendererNavigationRules,
} from "./window-security";

test("原生导航规则只允许打包页面与同页路由，阻断远程页面及查询", () => {
  const entry = rendererEntry();
  assert.equal(entry, "views://main/index.html");
  assert.deepEqual(rendererNavigationRules(), ["^*", entry, `${entry}#*`]);
  assert.ok(isRendererPage(`${entry}#/reference/test`));
  for (const url of [
    "file:///tmp/other.html",
    `${entry}?debug=1`,
    "https://example.com/",
    "views://main/private.html",
    "views://user@main/index.html",
    "about:blank",
    "invalid",
  ])
    assert.equal(isRendererPage(url), false);
});

test("外链仅放行无嵌入凭据的 HTTP(S)，拒绝本地文件及系统协议", () => {
  assert.equal(
    externalHttpUrl("https://example.com/help?q=1#intro"),
    "https://example.com/help?q=1#intro",
  );
  assert.equal(externalHttpUrl("http://localhost:8080/"), "http://localhost:8080/");
  for (const url of [
    "file:///tmp/test",
    "javascript:alert(1)",
    "data:text/html,test",
    "tarp://document/test?path=&image=test.png",
    "mailto:test@example.com",
    "ms-settings:",
    "https://user:secret@example.com/",
    "invalid",
  ])
    assert.equal(externalHttpUrl(url), undefined);
});

test("外链校验发生在调用系统浏览器之前，打开失败返回失败结果", async () => {
  const opened: string[] = [];
  const open = (url: string) => {
    opened.push(url);
    return true;
  };
  assert.equal(await openHttpLink("https://example.com/", open), true);
  assert.equal(await openHttpLink("file:///tmp/private", open), false);
  assert.deepEqual(opened, ["https://example.com/"]);
  assert.equal(await openHttpLink("https://example.com/", () => false), false);
  assert.equal(
    await openHttpLink("https://example.com/", () => {
      throw new Error("fixture");
    }),
    false,
  );
});
