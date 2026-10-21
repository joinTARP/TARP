import type { DocumentPresentation } from "@jointarp/module/document-templates";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DefaultDocumentLayout } from "./DefaultDocumentLayout";
import {
  DocumentRendererEnvironment,
  type DocumentRendererRuntime,
} from "./document-renderer-runtime";
import { HandlebarsContent } from "./HandlebarsLayout";
import type { LayoutContext } from "./layout-values";

export interface DocumentRendererAction {
  type: string;
  payload?: unknown;
}
export const documentRendererActionEvent = "tarp-renderer-action";

export interface DocumentRendererInput {
  layout: DocumentPresentation;
  context: LayoutContext;
  runtime: DocumentRendererRuntime;
}
/** 宿主只交换快照与 DOM 事件，不创建或解析渲染器内部节点。 */
export interface DocumentRendererElement extends HTMLElement {
  input: DocumentRendererInput | undefined;
}
export const documentRendererTags: Readonly<Record<DocumentPresentation["type"], string>> = {
  handlebars: "tarp-hbs-renderer",
  preset: "tarp-default-renderer",
};

function RendererContent({ input }: { input: DocumentRendererInput }) {
  return input.layout.type === "handlebars" ? (
    <HandlebarsContent node={input.layout} context={input.context} />
  ) : (
    <DefaultDocumentLayout layout={input.layout} context={input.context} />
  );
}

/** 静态输出适配也由渲染器维护，页面不解析模板。 */
export function renderDocumentRendererStatic(input: DocumentRendererInput) {
  return createElement(
    documentRendererTags[input.layout.type],
    { "data-document-renderer": input.layout.type },
    <template {...{ shadowrootmode: "open" }}>
      <RendererContent input={input} />
    </template>,
  );
}

/** 延迟注册，保证服务端导入时不访问 HTMLElement 或 customElements。 */
export function registerDocumentRenderers() {
  if (
    customElements.get(documentRendererTags.handlebars) &&
    customElements.get(documentRendererTags.preset)
  )
    return;
  class HandlebarsRenderer extends HTMLElement implements DocumentRendererElement {
    #input: DocumentRendererInput | undefined;
    #root: Root | undefined;
    #observers: MutationObserver[] = [];
    #generation = 0;

    get input() {
      return this.#input;
    }
    set input(value: DocumentRendererInput | undefined) {
      this.#input = value;
      this.#render();
    }
    connectedCallback() {
      this.#generation++;
      if (this.#root) {
        this.#render();
        return;
      }
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const styles = document.createElement("div");
      const target = document.createElement("div");
      target.style.minWidth = "0";
      shadow.replaceChildren(styles, target);
      const copyStyles = () =>
        styles.replaceChildren(
          ...Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'), (node) =>
            node.cloneNode(true),
          ),
        );
      const theme = () =>
        target.classList.toggle("dark", document.documentElement.classList.contains("dark"));
      copyStyles();
      theme();
      const stylesObserver = new MutationObserver(copyStyles);
      stylesObserver.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const themeObserver = new MutationObserver(theme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      this.#observers = [stylesObserver, themeObserver];
      this.#root = createRoot(target);
      this.#render();
    }
    disconnectedCallback() {
      const generation = ++this.#generation;
      // DOM 移动和 StrictMode 重挂载不销毁组件；真正卸载避开父 React 的提交过程。
      queueMicrotask(() => {
        if (this.isConnected || generation !== this.#generation) return;
        this.#observers.forEach((observer) => observer.disconnect());
        this.#observers = [];
        this.#root?.unmount();
        this.#root = undefined;
        this.#input = undefined;
        this.shadowRoot?.replaceChildren();
      });
    }
    #render() {
      if (!this.#root) return;
      const input = this.#input;
      this.#root.render(
        input ? (
          <DocumentRendererEnvironment runtime={input.runtime}>
            <RendererContent input={input} />
          </DocumentRendererEnvironment>
        ) : null,
      );
    }
  }
  if (!customElements.get(documentRendererTags.handlebars))
    customElements.define(documentRendererTags.handlebars, HandlebarsRenderer);
  if (!customElements.get(documentRendererTags.preset))
    customElements.define(documentRendererTags.preset, class extends HandlebarsRenderer {});
}
