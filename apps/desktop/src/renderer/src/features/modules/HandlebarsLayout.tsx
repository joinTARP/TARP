import { publicValues } from "@jointarp/module/character";
import {
  renderHandlebarsTemplate,
  type TemplateHtmlNode,
} from "@jointarp/module/handlebars-template";
import { fieldErrorAtPath, publicFieldErrors } from "@jointarp/module/public-document-field";
import {
  templateComponentSchema,
  templateComponentNode,
  validateTemplateComponent,
  type TemplateLayout,
} from "@jointarp/module/template-layout";
import { attributesToProps } from "html-react-parser";
import { createElement, type ReactNode } from "react";

import { useDocumentImage } from "./document-image";
import { FieldCalculationError } from "./FieldCalculationError";
import { layoutText, readLayoutCell, type LayoutContext } from "./layout-values";
import { TemplateComponentView } from "./TemplateComponentView";

function TemplateImage({
  attributes,
  context,
}: {
  attributes: Record<string, string>;
  context: LayoutContext;
}) {
  const src = useDocumentImage(context.imagePath ?? context.document.path, attributes.src);
  const props = attributesToProps(attributes);
  return <img {...props} src={src} alt={attributes.alt ?? ""} />;
}

function templateData(context: LayoutContext): Record<string, unknown> {
  const { document, documentType, library } = context;
  const errors = library
    ? document.fieldErrors
    : publicFieldErrors(documentType?.fields ?? [], document.fieldErrors);
  const clean = (value: unknown, path: string): unknown => {
    if (fieldErrorAtPath(errors, path)) return null;
    if (Array.isArray(value)) return value.map((child, index) => clean(child, `${path}[${index}]`));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          clean(child, path ? `${path}.${key}` : key),
        ]),
      );
    return value;
  };
  const values = library
    ? (document.values ?? {})
    : publicValues(documentType?.fields ?? [], { ...document.values });
  const metadata: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = { ...errors };
  for (const key of ["name", "description", "body", "image", "avatar"]) {
    const cell = readLayoutCell(context, key);
    if (cell) metadata[key] = cell.error ? null : cell.value;
    if (cell?.error)
      fieldErrors[key] = library ? cell.error : "当前字段计算失败，请重试或联系模组作者。";
  }
  return {
    ...metadata,
    values: clean(values, ""),
    display: Object.fromEntries(
      Object.keys(documentType?.layout?.displayFields ?? {}).map((key) => [
        key,
        document.displayErrors?.[key] ? null : document.displayValues?.[key],
      ]),
    ),
    errors: fieldErrors,
    displayErrors: document.displayErrors ?? {},
  };
}

export function HandlebarsContent({
  node,
  context,
}: {
  node: TemplateLayout;
  context: LayoutContext;
}) {
  try {
    const nodes = renderHandlebarsTemplate(
      node.template!,
      templateData(context),
      node.partials,
      (path) => {
        const cell = readLayoutCell(context, path);
        return cell ? (cell.error ? "计算失败" : layoutText(cell.value)) : "";
      },
    );
    const render = (html: TemplateHtmlNode, key: number): ReactNode => {
      if (html.type === "text") return html.data;
      if (html.type !== "tag" && html.type !== "style") return null;
      if (html.name.startsWith("tarp-")) {
        try {
          const component = templateComponentNode(html.name, html.attribs);
          if (!component) throw new Error(`未定义模板组件：${html.attribs.name ?? html.name}`);
          const parsed = templateComponentSchema.parse(component);
          if (context.documentType)
            validateTemplateComponent(
              context.documentType,
              parsed,
              context.documentType.layout?.displayFields,
            );
          return createElement(
            html.name,
            {
              ...Object.fromEntries(
                Object.entries(html.attribs).filter(
                  ([key]) =>
                    ["class", "id", "title", "field", "variant"].includes(key) ||
                    key.startsWith("data-") ||
                    key.startsWith("aria-"),
                ),
              ),
              key,
              style: attributesToProps(html.attribs).style,
            },
            <TemplateComponentView component={parsed} context={context} />,
          );
        } catch (error) {
          return (
            <FieldCalculationError
              key={key}
              error={error instanceof Error ? error.message : String(error)}
            />
          );
        }
      }
      if (html.name === "img")
        return <TemplateImage key={key} attributes={html.attribs} context={context} />;
      const props = attributesToProps(html.attribs);
      if (html.name === "a") {
        if (/^https?:\/\//i.test(html.attribs.href ?? "")) {
          props.target = "_blank";
          props.rel = "noopener noreferrer";
        } else if (!(html.attribs.href ?? "").startsWith("#")) delete props.href;
      }
      if (html.name === "input") props.readOnly = true;
      if (html.name === "button") props.type = "button";
      const children = html.children.map(render);
      return createElement(html.name, { ...props, key }, ...(children.length ? children : []));
    };
    return (
      <>
        <style>{`:host { display: block; min-width: 0; } img { max-width: 100%; } tarp-item-grid, tarp-image, tarp-markdown { display: block; min-width: 0; } ${node.css ?? ""}`}</style>
        {Object.entries(context.document.displayErrors ?? {})
          .filter(([key]) => Object.hasOwn(context.documentType?.layout?.displayFields ?? {}, key))
          .map(([key, error]) => (
            <FieldCalculationError key={key} error={context.library ? error : "展示计算失败"} />
          ))}
        {nodes.map(render)}
      </>
    );
  } catch (error) {
    return (
      <FieldCalculationError
        error={`模板渲染失败：${error instanceof Error ? error.message : String(error)}`}
      />
    );
  }
}
