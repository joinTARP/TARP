import { createHash } from "node:crypto";

/** 只在生产构建注入；允许固定内联脚本的哈希，禁止任意内联及远程脚本。 */
export function rendererCsp(html: string): string {
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
    .filter(([tag, source]) => !/\bsrc\s*=/iu.test(tag.split(">", 1)[0]) && source.trim())
    .map(([, source]) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`);
  return [
    "default-src 'none'",
    // SES 在计算 Worker 内动态编译公式；页面只加载同源静态 Worker。
    `script-src 'self' 'unsafe-eval' ${hashes.join(" ")}`.trim(),
    // React 和动画组件依赖内联样式，脚本仍禁止 unsafe-inline。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' tarp: http: https: data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    "connect-src ws://127.0.0.1:*",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
