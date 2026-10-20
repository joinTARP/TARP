import { isAbsolute, relative, resolve } from "node:path";

export function isInsideDirectory(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
