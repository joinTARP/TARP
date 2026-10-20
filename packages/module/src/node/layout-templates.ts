import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 模板和样式在冻结模组时读入布局，渲染器不再访问源模组文件。 */
export async function loadLayoutTemplates(modulePath: string, value: unknown): Promise<unknown> {
  const root = await realpath(modulePath);
  const load = async (path: unknown, extensions: RegExp) => {
    if (
      typeof path !== "string" ||
      !extensions.test(path) ||
      isAbsolute(path) ||
      path
        .replaceAll("\\", "/")
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`模板文件必须使用模组内相对路径：${String(path)}`);
    const target = await realpath(resolve(root, path));
    const inside = relative(root, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error(`模板文件不能越出模组目录：${path}`);
    return readFile(target, "utf8");
  };
  const visit = async (item: unknown): Promise<unknown> => {
    if (Array.isArray(item)) return Promise.all(item.map(visit));
    if (!item || typeof item !== "object") return item;
    const result = { ...item } as Record<string, unknown>;
    if (result.type === "handlebars") {
      if (result.templateFile !== undefined) {
        if (result.template !== undefined) throw new Error("template 与 templateFile 只能指定一个");
        result.template = await load(result.templateFile, /\.(?:hbs|handlebars|html)$/i);
        delete result.templateFile;
      }
      if (result.styleFile !== undefined) {
        if (result.css !== undefined) throw new Error("css 与 styleFile 只能指定一个");
        result.css = await load(result.styleFile, /\.css$/i);
        delete result.styleFile;
      }
      if (result.partialFiles !== undefined) {
        if (
          !result.partialFiles ||
          typeof result.partialFiles !== "object" ||
          Array.isArray(result.partialFiles)
        )
          throw new Error("partialFiles 必须是名称与文件路径映射");
        const partials = { ...(result.partials as Record<string, string> | undefined) };
        for (const [name, path] of Object.entries(result.partialFiles)) {
          if (Object.hasOwn(partials, name)) throw new Error(`partial 重复：${name}`);
          partials[name] = await load(path, /\.(?:hbs|handlebars|html)$/i);
        }
        result.partials = partials;
        delete result.partialFiles;
      }
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(result).map(async ([key, child]) => [key, await visit(child)]),
      ),
    );
  };
  return visit(value);
}
