import type { DocumentField, DocumentListItem } from "@jointarp/module/document-type";
import {
  fieldErrorAtPath,
  hasFieldErrors,
  shouldHideEmptyField,
} from "@jointarp/module/public-document-field";
import { Suspense } from "react";

import { LoadingIndicator } from "../../components/ui/loading-indicator";
import { DocumentMarkdown, documentMarkdownPlugins } from "./document-markdown";
import { DocumentReference, documentMarkdownComponents } from "./DocumentReferences";
import { FieldCalculationError } from "./FieldCalculationError";

type ValueDefinition =
  | Pick<DocumentField, "type" | "fields" | "item" | "hideWhenEmpty">
  | DocumentListItem;

/** 按字段结构展示公开值，不把嵌套对象作为 JSON 暴露到阅读界面。 */
export function DocumentValue({
  value,
  definition,
  fieldErrors,
  path = "",
}: {
  value: unknown;
  definition?: ValueDefinition;
  fieldErrors?: Readonly<Record<string, string>>;
  path?: string;
}) {
  if (fieldErrorAtPath(fieldErrors, path))
    return <FieldCalculationError error={fieldErrorAtPath(fieldErrors, path)!} />;
  if (
    !hasFieldErrors(fieldErrors, path) &&
    definition &&
    "hideWhenEmpty" in definition &&
    shouldHideEmptyField(definition, value)
  )
    return null;
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground font-normal">暂无数据</span>;
  }

  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground font-normal">暂无数据</span>;
    const item = definition && "item" in definition ? definition.item : undefined;
    const structured = value.some(
      (entry) =>
        (entry !== null && typeof entry === "object") ||
        (typeof entry === "string" && (entry.length > 32 || entry.includes("\n"))),
    );
    return (
      <ul className={structured ? "space-y-2" : "flex flex-wrap gap-1.5"}>
        {value.map((entry, index) => (
          <li
            key={index}
            className={
              structured
                ? "border-border/60 bg-background/70 min-w-0 rounded-lg border p-3"
                : "bg-muted/70 max-w-full rounded-md px-2 py-1 text-xs leading-5"
            }
          >
            <DocumentValue
              value={entry}
              definition={item}
              fieldErrors={fieldErrors}
              path={`${path}[${index}]`}
            />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === "object") {
    const values = value as Record<string, unknown>;
    const fields = definition?.fields;
    const entries = fields
      ? fields
          .filter(
            (field) =>
              (Object.hasOwn(values, field.key) ||
                hasFieldErrors(fieldErrors, path ? `${path}.${field.key}` : field.key)) &&
              (hasFieldErrors(fieldErrors, path ? `${path}.${field.key}` : field.key) ||
                !shouldHideEmptyField(field, values[field.key])),
          )
          .map((field) => ({
            key: field.key,
            label: field.label,
            value: values[field.key],
            definition: field,
          }))
      : Object.entries(values).map(([key, entry]) => ({
          key,
          label: key,
          value: entry,
          definition: undefined,
        }));
    if (!entries.length) return <span className="text-muted-foreground font-normal">暂无数据</span>;
    return (
      <dl className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,110px),1fr))] gap-x-4 gap-y-3">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className={
              typeof entry.value === "object" ||
              (typeof entry.value === "string" && entry.value.length > 32)
                ? "col-span-full min-w-0"
                : "min-w-0"
            }
          >
            <dt className="text-muted-foreground mb-1 text-[11px] leading-4 font-normal">
              {entry.label}
            </dt>
            <dd className="text-sm leading-6 [overflow-wrap:anywhere]">
              <DocumentValue
                value={entry.value}
                definition={entry.definition}
                fieldErrors={fieldErrors}
                path={path ? `${path}.${entry.key}` : entry.key}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span className="bg-muted inline-flex rounded-md px-2 py-0.5 text-xs">
        {value ? "是" : "否"}
      </span>
    );
  }
  if (definition?.type === "reference" && typeof value === "string") {
    return <DocumentReference value={value} />;
  }
  if (definition?.type === "enum") {
    return (
      <span className="bg-secondary text-secondary-foreground inline-block max-w-full rounded-md px-2 py-0.5 text-xs leading-5">
        {String(value)}
      </span>
    );
  }
  if (typeof value === "string") {
    return (
      <div className="[&_a]:text-ring [&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_pre]:bg-muted [&_td]:border-border [&_th]:border-border min-w-0 [overflow-wrap:anywhere] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:text-xs [&_em]:italic [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-w-full [&_img]:rounded-md [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:whitespace-pre-wrap [&_p+p]:mt-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-2 [&_strong]:font-semibold [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
        <Suspense
          fallback={
            value.length > 32 || value.includes("\n") ? (
              <div className="flex min-h-24 items-center justify-center">
                <LoadingIndicator label="正在加载内容…" />
              </div>
            ) : (
              <span className="whitespace-pre-wrap">{value}</span>
            )
          }
        >
          <DocumentMarkdown
            skipHtml
            components={documentMarkdownComponents}
            remarkPlugins={documentMarkdownPlugins}
          >
            {value}
          </DocumentMarkdown>
        </Suspense>
      </div>
    );
  }
  return (
    <span className="[overflow-wrap:anywhere] whitespace-pre-wrap tabular-nums">
      {String(value)}
    </span>
  );
}
