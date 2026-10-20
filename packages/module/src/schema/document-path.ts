/** 把文档文件路径转换成不带文件扩展名的领域标识；格式校验由输入边界负责。 */
export function documentIdentity(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\.(json|toml|md)$/iu, "");
}

export function documentFormat(path: string): "json" | "toml" | "markdown" {
  return /\.md$/iu.test(path) ? "markdown" : /\.toml$/iu.test(path) ? "toml" : "json";
}

/** 按实际文档显示该类型使用的全部格式；没有文档时不标格式。 */
export function typeFormatLabel(
  typeId: string,
  documents: readonly {
    readonly docType?: string;
    readonly path: string;
    readonly contentType?: "json" | "toml" | "markdown";
  }[],
): string | undefined {
  const formats = new Set(
    documents
      .filter((document) => document.docType === typeId)
      .map((document) => document.contentType ?? documentFormat(document.path)),
  );
  if (formats.size === 0) return undefined;
  return (["json", "toml", "markdown"] as const)
    .filter((format) => formats.has(format))
    .map((format) => (format === "markdown" ? "Markdown" : format.toUpperCase()))
    .join(" / ");
}

export function sameDocumentIdentity(left: string, right: string): boolean {
  return documentIdentity(left) === documentIdentity(right);
}
/** 游戏文档的一级目录决定类型，任意深度子目录只负责分组。 */
export function documentTypeId(value: string): string | undefined {
  const path = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = path.split("/");
  if (
    parts.length < 2 ||
    parts.some((part) => !part || part.startsWith(".") || part.includes("\0"))
  )
    return undefined;
  return parts[0];
}
