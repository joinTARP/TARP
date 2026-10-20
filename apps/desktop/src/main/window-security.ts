/** 窗口只允许固定应用页面与同页哈希路由；原生导航规则在跳转前同步生效。 */
export function rendererEntry(options: { development?: boolean; devUrl?: string } = {}): string {
  if (options.development && options.devUrl) {
    const url = new URL(options.devUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("开发页面必须是无凭据、查询和片段的本机 HTTP(S) 地址");
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  }
  return "views://main/index.html";
}

export function rendererNavigationRules(entry = rendererEntry()): string[] {
  return ["^*", entry, `${entry}#*`];
}

export function isRendererPage(value: string, entry = rendererEntry()): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search) return false;
    url.hash = "";
    return url.href === entry;
  } catch {
    return false;
  }
}

export function externalHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export async function openHttpLink(
  value: string,
  open: (url: string) => unknown,
): Promise<boolean> {
  const url = externalHttpUrl(value);
  if (!url) return false;
  try {
    return (await open(url)) !== false;
  } catch {
    console.error("无法打开外部链接");
    return false;
  }
}
