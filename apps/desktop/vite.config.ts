import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";
import { rendererCsp } from "./scripts/renderer-csp.ts";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  resolve: {
    alias: [
      ...electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")),
      { find: "@shared", replacement: resolve(import.meta.dirname, "src/shared") },
      { find: "@", replacement: resolve(import.meta.dirname, "src/renderer/src") },
    ],
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "renderer-production-csp",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler: (html) => [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: rendererCsp(html) },
            injectTo: "head-prepend",
          },
        ],
      },
    },
  ],
  worker: { format: "es" },
  build: { outDir: "../../out/renderer", emptyOutDir: true, target: "es2022" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
