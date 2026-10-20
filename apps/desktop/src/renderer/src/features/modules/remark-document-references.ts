interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, string> };
}

const ignoredParents = new Set(["code", "inlineCode", "link", "linkReference", "html", "image"]);
const wikiReference = /(?<!!)\[\[([^\]\n]+)\]\]/gu;

function referenceNodes(value: string): MarkdownNode[] | undefined {
  const nodes: MarkdownNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(wikiReference)) {
    const path = match[1].trim();
    if (!path) continue;
    const index = match.index;
    if (index > offset) nodes.push({ type: "text", value: value.slice(offset, index) });
    nodes.push({
      type: "link",
      url: path,
      children: [{ type: "text", value: path }],
      data: { hProperties: { "data-document-reference": "wiki" } },
    });
    offset = index + match[0].length;
  }
  if (!nodes.length) return undefined;
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

function transform(node: MarkdownNode): void {
  if (!node.children || ignoredParents.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || child.value === undefined) {
      transform(child);
      return child;
    }
    return referenceNodes(child.value) ?? child;
  });
}

/** 把正文中的 [[文档路径]] 转成普通文档链接，交给统一引用组件渲染。 */
export function remarkDocumentReferences() {
  return (tree: unknown) => transform(tree as MarkdownNode);
}
