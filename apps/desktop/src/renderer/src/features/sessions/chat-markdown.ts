interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** 仅修复仍被标准解析器当作普通文本的中文双星号加粗。 */
function chineseStrongNodes(value: string): MarkdownNode[] | undefined {
  const nodes: MarkdownNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(/\*\*([^*\r\n]+?)\*\*/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    const body = match[1]!;
    // 不接管三连星号或纯英文文本，也不把空标记当作加粗。
    if (value[start - 1] === "*" || value[end] === "*" || !/\p{Script=Han}/u.test(body)) continue;
    const leading = body.match(/^\s*/u)![0];
    const trailing = body.match(/\s*$/u)![0];
    if (start > offset || leading)
      nodes.push({ type: "text", value: value.slice(offset, start) + leading });
    nodes.push({ type: "strong", children: [{ type: "text", value: body.trim() }] });
    if (trailing) nodes.push({ type: "text", value: trailing });
    offset = end;
  }
  if (!nodes.length) return undefined;
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

/** 聊天兼容中文标点和标记内侧空格；只改渲染树，不修改历史正文。 */
export function remarkChatEmphasis() {
  return (tree: unknown, file: { value: unknown }) => {
    const source = String(file.value);
    function transform(node: MarkdownNode): void {
      if (!node.children || ["code", "inlineCode", "html"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || child.value === undefined) {
          transform(child);
          return [child];
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        // 转义或实体解码后的 ** 是字面文本，不能重新解释成 Markdown。
        if (start === undefined || end === undefined || source.slice(start, end) !== child.value)
          return [child];
        return chineseStrongNodes(child.value) ?? [child];
      });
    }
    transform(tree as MarkdownNode);
  };
}
