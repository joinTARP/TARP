import { resolve } from "node:path";

import { plugin } from "bun";

// UI 测试只渲染组件；样式由 Vite 构建与真实 WebView 验收。
plugin({
  name: "test-styles",
  setup(build) {
    build.onResolve({ filter: /^@(?:shared)?\// }, ({ path }) => ({
      path: Bun.resolveSync(
        resolve(
          import.meta.dirname,
          "../apps/desktop/src",
          path.startsWith("@shared/") ? "shared" : "renderer/src",
          path.replace(/^@(?:shared)?\//, ""),
        ),
        import.meta.dirname,
      ),
    }));
    build.onLoad({ filter: /\.(css|less|scss)$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
});
