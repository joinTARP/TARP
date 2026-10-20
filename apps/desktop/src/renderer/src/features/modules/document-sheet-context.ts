import { createContext } from "react";

/** 嵌入卡片共享祖先路径，避免引用环和过深的布局展开。 */
export const DocumentSheetAncestors = createContext<readonly string[]>([]);
