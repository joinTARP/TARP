import {
  documentMediaUrl,
  documentMediaVersion,
  subscribeDocumentMedia,
} from "@shared/document-media";
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

export const DocumentImageContext = createContext<string | undefined>(undefined);

export function DocumentImageScope({ scope, children }: { scope: string; children: ReactNode }) {
  return <DocumentImageContext.Provider value={scope}>{children}</DocumentImageContext.Provider>;
}

export function useDocumentImage(
  path: string | null | undefined,
  image: string | undefined,
  scope?: string,
) {
  const context = useContext(DocumentImageContext);
  useSyncExternalStore(
    subscribeDocumentMedia,
    () => documentMediaVersion(scope ?? context),
    () => undefined,
  );
  return documentMediaUrl(scope ?? context, path ?? "", image);
}

/** 专用头像加载失败时回退到封面；失效地址不影响新的图片引用。 */
export function useDocumentPortrait(
  path: string | null | undefined,
  avatar: string | undefined,
  image: string | undefined,
) {
  const preferred = useDocumentImage(path, avatar);
  const fallback = useDocumentImage(path, image);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const src = [preferred, fallback].find((url) => url && !failed.has(url));
  return { src, onError: () => src && setFailed((previous) => new Set([...previous, src])) };
}
