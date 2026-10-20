import { useMemo } from "react";
import type { Components } from "react-markdown";
import { Streamdown } from "streamdown";

import { documentMarkdownPlugins } from "../modules/document-markdown";
import { documentMarkdownComponents } from "../modules/DocumentReferences";
import { remarkChatEmphasis } from "./chat-markdown";

const plugins = [remarkChatEmphasis, ...documentMarkdownPlugins];
// 与原渲染器相同：跳过原始 HTML，保留 remark 生成的资料引用属性。
const rehypePlugins: [] = [];
const typography: Components = {
  p: "p",
  strong: "strong",
  pre: "pre",
  code: "code",
  blockquote: "blockquote",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  ul: "ul",
  ol: "ol",
  li: "li",
};

/** 历史和实时消息复用分块结构，结束时只关闭未完成语法补全，避免切换渲染器。 */
export function ChatMarkdown({
  children,
  streaming = false,
  components = documentMarkdownComponents,
}: {
  children: string;
  streaming?: boolean;
  components?: Components;
}) {
  const renderers = useMemo(() => ({ ...typography, ...components }), [components]);
  return (
    <Streamdown
      mode="streaming"
      skipHtml
      components={renderers}
      remarkPlugins={plugins}
      rehypePlugins={rehypePlugins}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      controls={false}
      className="space-y-3"
    >
      {children}
    </Streamdown>
  );
}
