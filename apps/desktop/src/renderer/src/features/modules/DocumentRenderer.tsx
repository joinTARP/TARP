import type { DocumentPresentation } from "@jointarp/module/document-templates";
import { createElement, useLayoutEffect, useRef } from "react";

import {
  documentRendererTags,
  registerDocumentRenderers,
  renderDocumentRendererStatic,
  documentRendererActionEvent,
  type DocumentRendererAction,
  type DocumentRendererElement,
} from "./document-renderer-element";
import { useDocumentRendererRuntime } from "./document-renderer-runtime";
import type { LayoutContext } from "./layout-values";

/** 页面仅负责选择宿主、推送最新快照；内部 DOM 由自定义元素持有。 */
export function DocumentRenderer({
  layout,
  context,
  onAction,
}: {
  layout: DocumentPresentation;
  context: LayoutContext;
  onAction?: (action: DocumentRendererAction) => void;
}) {
  const ref = useRef<DocumentRendererElement>(null);
  const runtime = useDocumentRendererRuntime();
  useLayoutEffect(() => {
    registerDocumentRenderers();
    ref.current!.input = { layout, context, runtime };
  });
  useLayoutEffect(() => {
    const element = ref.current!;
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.type !== "string") return;
      // 嵌套卡片由最近的宿主处理，避免同一次操作重复执行。
      event.stopPropagation();
      onAction?.(event.detail);
    };
    element.addEventListener(documentRendererActionEvent, listener);
    return () => element.removeEventListener(documentRendererActionEvent, listener);
  }, [onAction]);
  const tag = documentRendererTags[layout.type];
  // 静态导出保留可读内容；浏览器始终由自定义元素拥有独立渲染根。
  if (typeof window === "undefined")
    return renderDocumentRendererStatic({ layout, context, runtime });
  return createElement(tag, { ref, "data-document-renderer": layout.type, class: "block min-w-0" });
}
