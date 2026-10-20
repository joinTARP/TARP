import { parseDocument, stringify } from "yaml";

import { documentFormat } from "../schema/document-path";
import { parseConfig, stringifyConfig } from "./config-file";

export function parseMarkdown(source: string): { metadata: unknown; body: string } {
  const text = source.replace(/^\uFEFF/u, "");
  if (!/^---[ \t]*\r?\n/u.test(text)) return { metadata: {}, body: text };
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu);
  if (!match) throw new Error("YAML frontmatter 缺少结束分隔线 ---");
  const parsed = parseDocument(match[1], { uniqueKeys: true });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
  return { metadata: parsed.toJS() ?? {}, body: text.slice(match[0].length) };
}

export function parseStructuredDocument(source: string, path: string): unknown {
  return path.toLowerCase().endsWith(".toml") ? parseConfig(source, path) : JSON.parse(source);
}

/** 三种文档格式共用字段模型；Markdown 正文统一放入 body。 */
export function parseDocumentContent(source: string, path: string): unknown {
  if (documentFormat(path) !== "markdown") return parseStructuredDocument(source, path);
  const { metadata, body } = parseMarkdown(source);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Markdown frontmatter 必须是对象");
  return { ...metadata, ...(body.length ? { body } : {}) };
}

/** TOML 不支持 null；文档不能像设置文件一样省略空值，避免改变游戏事实。 */
function assertTomlValue(value: unknown): void {
  if (value === null || value === undefined)
    throw new Error("TOML 文档不能保存 null 或 undefined，请移除可选字段或使用 JSON 文档");
  if (typeof value === "object") for (const child of Object.values(value)) assertTomlValue(child);
}

export function stringifyStructuredDocument(value: Record<string, unknown>, path: string): string {
  if (path.toLowerCase().endsWith(".toml")) assertTomlValue(value);
  return stringifyConfig(value, path);
}

export function stringifyDocumentContent(value: Record<string, unknown>, path: string): string {
  if (documentFormat(path) !== "markdown") return stringifyStructuredDocument(value, path);
  const { body, ...metadata } = value;
  if (body !== undefined && typeof body !== "string") throw new Error("文档 body 必须是字符串");
  return `---\n${stringify(metadata)}---\n${body ?? ""}`;
}
