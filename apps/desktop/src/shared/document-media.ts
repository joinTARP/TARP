const versions = new Map<string, string>();
const listeners = new Set<() => void>();
let mediaBase = "tarp://document/";
export function setDocumentMediaBase(base: string): void {
  mediaBase = base;
}
export function setDocumentMediaVersion(scope: string, version: string): void {
  versions.set(scope, version);
  for (const listener of listeners) listener();
}
export function documentMediaVersion(scope: string | undefined): string | undefined {
  return scope ? versions.get(scope) : undefined;
}
export function subscribeDocumentMedia(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 文档只保存图片引用；展示层生成地址，媒体协议收到请求时再查找本地文件。 */
export function documentMediaUrl(
  scope: string | undefined,
  path: string,
  image: string | undefined,
): string | undefined {
  if (!image) return undefined;
  if (!scope || /^https?:\/\//iu.test(image)) return image;
  const query = new URLSearchParams({ path, image });
  const version = documentMediaVersion(scope);
  if (version) query.set("version", version);
  return `${mediaBase}${encodeURIComponent(scope)}?${query}`;
}
