import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { rendererCsp } from "./renderer-csp";

test("生产 CSP 支持本地计算 Worker 与 SES 编译，内联脚本、网络与媒体继续按来源限制", () => {
  const source = "\n  document.documentElement.classList.add('dark');\n";
  const policy = rendererCsp(`<script>${source}</script><script src="./main.js"></script>`);
  const directives = Object.fromEntries(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name, values];
    }),
  );
  assert.deepEqual(directives["script-src"], [
    "'self'",
    "'unsafe-eval'",
    `'sha256-${createHash("sha256").update(source).digest("base64")}'`,
  ]);
  assert.deepEqual(directives["worker-src"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["ws://127.0.0.1:*"]);
  assert.deepEqual(directives["frame-src"], ["'none'"]);
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.ok(directives["img-src"].includes("tarp:"));
  assert.ok(directives["media-src"].includes("blob:"));
  assert.ok(directives["style-src"].includes("'unsafe-inline'"));
});
