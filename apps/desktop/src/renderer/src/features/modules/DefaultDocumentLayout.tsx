import { defaultDocumentFields, type PresetLayout } from "@tarp/module/document-templates";
import { shouldHideEmptyField } from "@tarp/module/public-document-field";
import { Suspense } from "react";

import { DocumentMarkdown, documentMarkdownPlugins } from "./document-markdown";
import { DocumentCover } from "./DocumentCover";
import { DocumentFieldView } from "./DocumentFieldView";
import { documentMarkdownComponents } from "./DocumentReferences";
import { DocumentValue } from "./DocumentValue";
import { FieldCalculationError } from "./FieldCalculationError";
import { readLayoutCell, type LayoutContext } from "./layout-values";

/** 无模板时的平台默认详情；作者模板不依赖这套字段排版。 */
export function DefaultDocumentLayout({
  layout,
  context,
}: {
  layout: PresetLayout;
  context: LayoutContext;
}) {
  const type = context.documentType;
  const simple = type?.layout?.type === "handlebars" ? undefined : type?.layout;
  const name = readLayoutCell(context, "name");
  const description = readLayoutCell(context, "description");
  const image = readLayoutCell(context, "image");
  const body = readLayoutCell(context, "body");
  const title = name ? (
    <h2 className="text-2xl font-semibold">{name.error ? "计算失败" : String(name.value ?? "")}</h2>
  ) : null;
  const cover =
    image?.value && !image.error ? (
      <DocumentCover
        preview
        src={String(image.value)}
        path={context.imagePath ?? context.document.path}
        title={String(name?.value ?? "")}
        imageAspect={simple?.type === "split" ? simple.imageAspect : "landscape"}
        className="w-full rounded-xl bg-transparent!"
      />
    ) : null;
  const fields = (paths: readonly string[]) => (
    <div
      className={`grid min-w-0 items-start gap-4 ${layout.mode === "sheet" ? "grid-cols-1" : { 1: "grid-cols-1", 2: "grid-cols-1 @min-[216px]:grid-cols-2", 3: "grid-cols-1 @min-[216px]:grid-cols-2 @min-[332px]:grid-cols-3", 4: "grid-cols-1 @min-[216px]:grid-cols-2 @min-[332px]:grid-cols-3 @min-[448px]:grid-cols-4" }[simple?.columns ?? 2]}`}
    >
      {paths.map((path) => {
        const cell = readLayoutCell(context, path);
        if (!cell || (!cell.error && shouldHideEmptyField(cell.field, cell.value))) return null;
        const view = simple?.fieldViews?.[path];
        return (
          <div key={path} className="min-w-0 space-y-1.5">
            <div className="text-muted-foreground text-xs">
              {cell.field.label}
              {Array.isArray(cell.value) &&
              view?.type !== "ReferenceCollection" &&
              !(view?.type === "FieldTable" && view.collapsedGroup) ? (
                <span className="ml-2">{cell.value.length} 项</span>
              ) : null}
            </div>
            {cell.error ? (
              <FieldCalculationError error={cell.error} />
            ) : view ? (
              <DocumentFieldView
                field={cell.field}
                value={cell.value}
                path={path}
                config={view}
                fieldErrors={context.document.fieldErrors}
              />
            ) : (
              <DocumentValue
                value={cell.value}
                definition={cell.field}
                path={path}
                fieldErrors={context.document.fieldErrors}
              />
            )}
          </div>
        );
      })}
    </div>
  );
  const desc =
    description?.value && !description.error ? (
      <p className="text-muted-foreground text-sm leading-6 whitespace-pre-wrap">
        {String(description.value)}
      </p>
    ) : null;
  const markdown =
    body?.value && !body.error ? (
      <Suspense fallback={<p>正在加载正文…</p>}>
        <DocumentMarkdown
          skipHtml
          components={documentMarkdownComponents}
          remarkPlugins={documentMarkdownPlugins}
        >
          {String(body.value)}
        </DocumentMarkdown>
      </Suspense>
    ) : null;
  const primary = (
    <div className="space-y-6" aria-label="基础资料">
      {cover}
      {title}
      {fields(simple?.fields ?? [])}
    </div>
  );
  const secondary = (
    <div className="space-y-6" aria-label="详细内容">
      {(simple?.order ?? ["fields", "description", "body"]).map((section) => (
        <div key={section}>
          {section === "fields"
            ? fields(simple?.type === "split" ? simple.contentFields : defaultDocumentFields(type))
            : section === "description"
              ? desc
              : markdown}
        </div>
      ))}
    </div>
  );
  return (
    <div className="@container min-w-0">
      {layout.mode === "sheet" ? (
        <div className="space-y-6">
          {title}
          {desc}
          {fields(defaultDocumentFields(type))}
          {markdown}
        </div>
      ) : simple?.type === "split" ? (
        layout.part === "primary" ? (
          primary
        ) : layout.part === "content" ? (
          secondary
        ) : (
          <div className="grid gap-8 @min-[640px]:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]">
            {primary}
            {secondary}
          </div>
        )
      ) : (
        <div className="space-y-6">
          {cover}
          {title}
          {secondary}
        </div>
      )}
    </div>
  );
}
