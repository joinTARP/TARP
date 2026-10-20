import { createContext, useContext, type ReactNode } from "react";

export const LibraryContext = createContext(false);

/** 模组库允许展示主持字段和隐藏资料；游戏资料不挂载此作用域。 */
export function DocumentLibraryScope({ children }: { children: ReactNode }) {
  return <LibraryContext.Provider value={true}>{children}</LibraryContext.Provider>;
}

export function useDocumentLibrary() {
  return useContext(LibraryContext);
}
