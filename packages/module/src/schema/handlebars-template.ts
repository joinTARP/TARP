import Handlebars from "handlebars";
import { parseDocument } from "htmlparser2";

export type TemplateHtmlNode = ReturnType<typeof parseDocument>["children"][number];
const cache = new Map<string, Handlebars.TemplateDelegate>();
const componentTags = new Set(["tarp-reference", "tarp-item-grid", "tarp-image", "tarp-markdown"]);
const forbiddenTags = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "form",
  "svg",
  "math",
]);

/** 每份模板拥有独立 partial 注册表，不向宿主的 Handlebars 全局注册内容。 */
function compiledTemplate(source: string, partials: Record<string, string> = {}) {
  const key = JSON.stringify([source, partials]);
  const cached = cache.get(key);
  if (cached) return cached;
  const engine = Handlebars.create();
  const options = { knownHelpersOnly: true, knownHelpers: { eq: true, field: true, log: false } };
  engine.precompile(source, options);
  for (const [name, partial] of Object.entries(partials)) {
    engine.precompile(partial, options);
    engine.registerPartial(name, partial);
  }
  const template = engine.compile(source, options);
  cache.set(key, template);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return template;
}

export function parseTemplateHtml(html: string): TemplateHtmlNode[] {
  const nodes = parseDocument(html, { decodeEntities: true }).children;
  const visit = (node: TemplateHtmlNode) => {
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      if (
        forbiddenTags.has(node.name) ||
        (node.name.includes("-") && !componentTags.has(node.name))
      )
        throw new Error(`模板不支持 <${node.name}>`);
      for (const [key, value] of Object.entries(node.attribs)) {
        if (/^on/i.test(key) || ["srcdoc", "is", "formaction", "action", "srcset"].includes(key))
          throw new Error(`模板不支持属性 ${key}`);
        if (
          ["href", "src", "poster", "xlink:href"].includes(key) &&
          /^\s*(?:javascript|vbscript|data|file):/i.test(value)
        )
          throw new Error(`模板不支持该 ${key} 地址`);
      }
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return nodes;
}

export function validateHandlebarsTemplate(
  source: string,
  partials?: Record<string, string>,
): void {
  compiledTemplate(source, partials);
  parseTemplateHtml(source);
  Object.values(partials ?? {}).forEach(parseTemplateHtml);
}

export function renderHandlebarsTemplate(
  source: string,
  data: Record<string, unknown>,
  partials?: Record<string, string>,
  field?: (path: string) => unknown,
): TemplateHtmlNode[] {
  const html = compiledTemplate(source, partials)(data, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
    helpers: {
      eq: (left: unknown, right: unknown) => left === right,
      field: (path: string) => field?.(path) ?? "",
    },
  });
  return parseTemplateHtml(html);
}
