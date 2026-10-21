import type { DocumentField, DocumentType } from "@jointarp/module/document-type";

export function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") throw new Error("更新路径必须是 JSON Pointer");
  if (/~(?:[^01]|$)/u.test(pointer)) throw new Error("更新路径包含无效 JSON Pointer 转义");
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part)))
    throw new Error("更新路径包含保留字段");
  return parts;
}

export function assertMutablePointer(
  type: DocumentType,
  pointer: string,
  publicOnly = false,
  operation: "set" | "remove" = "set",
): void {
  const parts = pointerParts(pointer);
  let fields: readonly DocumentField[] = type.fields;
  let field: DocumentField | undefined;
  for (let index = 0; index < parts.length; index++) {
    const key = parts[index]!;
    field = fields.find((candidate) => candidate.key === key);
    if (!field) throw new Error(`更新路径不是 Schema 字段：${pointer}`);
    if (publicOnly && field.visibility !== "public")
      throw new Error(`玩家不能修改非公开字段：${pointer}`);
    if (index === parts.length - 1) {
      if (!field.mutable) throw new Error(`字段未标记为运行时可修改：${pointer}`);
      if (publicOnly && operation === "set" && (field.type === "object" || field.type === "list"))
        throw new Error(`玩家不能整体覆盖结构化字段：${pointer}`);
      return;
    }
    if (field.type === "object") {
      fields = field.fields ?? [];
      continue;
    }
    if (field.type === "list") {
      const itemIndex = parts[++index];
      if (itemIndex === undefined || !/^\d+$/u.test(itemIndex))
        throw new Error(`列表更新路径无效：${pointer}`);
      if (index === parts.length - 1) {
        if (!field.mutable) throw new Error(`字段未标记为运行时可修改：${pointer}`);
        if (publicOnly && operation === "set" && field.item?.type === "object")
          throw new Error(`玩家不能整体覆盖对象列表项：${pointer}`);
        return;
      }
      if (field.item?.type !== "object") throw new Error(`更新路径不是对象列表字段：${pointer}`);
      fields = field.item.fields ?? [];
      continue;
    }
    throw new Error(`更新路径不能进入标量字段：${pointer}`);
  }
  throw new Error(`更新路径不是 Schema 字段：${pointer}`);
}

export function applyPointer(
  target: Record<string, unknown>,
  pointer: string,
  operation: "set" | "remove",
  value?: unknown,
): void {
  const parts = pointerParts(pointer);
  let current: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!current || typeof current !== "object") throw new Error(`更新路径不存在：${pointer}`);
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  if (!current || typeof current !== "object") throw new Error(`更新路径不存在：${pointer}`);
  const key = parts.at(-1)!;
  if (Array.isArray(current)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= current.length)
      throw new Error(`数组下标无效：${pointer}`);
    if (operation === "remove") current.splice(index, 1);
    else current[index] = value;
  } else if (operation === "remove") delete (current as Record<string, unknown>)[key];
  else (current as Record<string, unknown>)[key] = value;
}
