import { lazy } from "react";
import remarkGfm from "remark-gfm";

import { remarkDocumentReferences } from "./remark-document-references";

let markdownModule: Promise<typeof import("react-markdown")> | undefined;

function loadMarkdown() {
  markdownModule ??= import("react-markdown").catch((error: unknown) => {
    markdownModule = undefined;
    throw error;
  });
  return markdownModule;
}

export const DocumentMarkdown = lazy(loadMarkdown);
export const documentMarkdownPlugins = [remarkGfm, remarkDocumentReferences];

/** 悬停和空闲预热共享同一个请求；预热失败不阻断卡片操作。 */
export function preloadDocumentMarkdown() {
  void loadMarkdown().catch(() => {});
}
