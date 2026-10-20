import { itemGridConfig, type TemplateComponent } from "@jointarp/module/template-layout";
import { Suspense } from "react";

import { DocumentMarkdown, documentMarkdownPlugins } from "./document-markdown";
import { DocumentCover } from "./DocumentCover";
import {
  DocumentReference,
  documentMarkdownComponents,
  useDocumentReferenceIndex,
} from "./DocumentReferences";
import { FieldCalculationError } from "./FieldCalculationError";
import { InventorySlots } from "./InventorySlots";
import { readLayoutCell, type LayoutContext } from "./layout-values";
import { buildReferenceCollectionRows } from "./reference-collection";
import { ReferenceSheet } from "./ReferenceSheet";

/** 模板只借用宿主交互能力，不生成字段标题、统计或工具栏。 */
export function TemplateComponentView({
  component,
  context,
}: {
  component: TemplateComponent;
  context: LayoutContext;
}) {
  const references = useDocumentReferenceIndex();
  const cell = component.field ? readLayoutCell(context, component.field) : undefined;
  if (component.field && !cell) return null;
  if (cell?.error) return <FieldCalculationError error={cell.error} />;
  if (component.type === "reference") {
    const value = component.value ?? cell?.value;
    if (component.display === "sheet")
      return typeof value === "string" && value ? <ReferenceSheet reference={value} /> : null;
    return typeof value === "string" && value ? (
      <DocumentReference value={value}>{component.label}</DocumentReference>
    ) : null;
  }
  if (component.type === "item-grid") {
    const rows = buildReferenceCollectionRows(
      cell?.value,
      cell!.field,
      itemGridConfig(component),
      references,
    );
    return (
      <InventorySlots
        rows={rows}
        label={component.label ?? cell!.field.label}
        slotCount={component.capacity}
        filtered={false}
      />
    );
  }
  if (!cell?.value) return null;
  if (component.type === "image")
    return (
      <DocumentCover
        preview
        src={String(cell.value)}
        title={component.alt ?? ""}
        path={context.imagePath ?? context.document.path}
        imageAspect={component.imageAspect ?? "portrait"}
        className="w-full rounded-xl bg-transparent!"
      />
    );
  return (
    <Suspense fallback={<p>正在加载正文…</p>}>
      <DocumentMarkdown
        skipHtml
        components={documentMarkdownComponents}
        remarkPlugins={documentMarkdownPlugins}
      >
        {String(cell.value)}
      </DocumentMarkdown>
    </Suspense>
  );
}
