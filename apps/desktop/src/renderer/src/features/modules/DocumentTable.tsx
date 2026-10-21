import { documentIdentity } from "@jointarp/module/document-path";
import type { DocumentListLayout, DocumentType } from "@jointarp/module/document-type";
import { isDocumentVisible } from "@jointarp/module/module-document";
import {
  fieldErrorAtPath,
  getDocumentField,
  hasFieldErrors,
  getPublicDocumentField,
  shouldHideEmptyField,
} from "@jointarp/module/public-document-field";
import type { ModuleDocument } from "@shared/desktop-api";

import { RoomDocument } from "../sessions/room-document";
import { useDocumentLibrary } from "./document-library-context";
import { getPreviewDescription, getPreviewFields } from "./document-preview";
import { DocumentReference } from "./DocumentReferences";
import { FieldCalculationError } from "./FieldCalculationError";
import { SimpleTable, type SimpleTableColumn } from "./SimpleTable";

/** 文档目录表格：显示公开字段和简介，缺少简介时使用正文摘要。 */
export function DocumentTable({
  documents,
  documentType,
  layout,
  selectedDocumentPath,
  onSelectDocument,
}: {
  readonly documents: readonly ModuleDocument[];
  readonly documentType?: DocumentType;
  readonly layout: DocumentListLayout;
  readonly selectedDocumentPath: string | null;
  readonly onSelectDocument: (path: string | null) => void;
}) {
  const library = useDocumentLibrary();
  const columns = layout.fields.flatMap((path) => {
    const field = (library ? getDocumentField : getPublicDocumentField)(
      documentType?.fields ?? [],
      path,
    );
    return field ? [{ path, field, label: field.label, numeric: field.type === "number" }] : [];
  });
  const paths = columns.map((column) => column.path);
  const tableColumns: SimpleTableColumn[] = [
    { key: "__name", label: "名称", className: "whitespace-nowrap" },
    ...columns.map((column) => ({
      key: `field:${column.path}`,
      label: column.label,
      numeric: column.numeric,
      className: "min-w-20 max-w-56",
    })),
    ...(layout.description
      ? [{ key: "__description", label: "用途与说明", className: "min-w-56" }]
      : []),
  ];
  const createRow = (document: ModuleDocument) => ({
    document,
    hidden: new Set(
      columns
        .filter(({ path, field }) => {
          let value: unknown = document.values;
          for (const key of path.split(".")) {
            value =
              value && typeof value === "object"
                ? (value as Record<string, unknown>)[key]
                : undefined;
          }
          return !hasFieldErrors(document.fieldErrors, path) && shouldHideEmptyField(field, value);
        })
        .map(({ path }) => path),
    ),
    values: new Map(
      getPreviewFields(document, documentType, paths, library).map((entry) => [
        entry.path,
        entry.text,
      ]),
    ),
  });
  const rows = documents.filter((document) => library || document.visible !== false).map(createRow);
  return (
    <SimpleTable
      label={`${documentType?.name ?? "文档"}目录`}
      columns={tableColumns}
      rows={rows}
      rowKey={(row) => row.document.path}
      renderRow={(row, render) => (
        <RoomDocument
          document={row.document}
          errorFallback={(_error, retry) => (
            <tr>
              <td colSpan={tableColumns.length}>
                <span role="alert" className="text-destructive text-sm">
                  资料读取失败{" "}
                  <button type="button" className="underline" onClick={retry}>
                    重试
                  </button>
                </span>
              </td>
            </tr>
          )}
        >
          {(document) =>
            !library && !isDocumentVisible(document, documentType)
              ? null
              : render(createRow(document))
          }
        </RoomDocument>
      )}
      renderCell={({ document, values, hidden }, column) => {
        if (column.key === "__name")
          return (
            <>
              <DocumentReference
                value={documentIdentity(document.path)}
                open={selectedDocumentPath === document.path}
                onOpenChange={(open) => onSelectDocument(open ? document.path : null)}
              />
              {fieldErrorAtPath(document.fieldErrors, "name") ? (
                <FieldCalculationError error={fieldErrorAtPath(document.fieldErrors, "name")!} />
              ) : null}
            </>
          );
        if (column.key === "__description") {
          const error = fieldErrorAtPath(document.fieldErrors, "description");
          if (error) return <FieldCalculationError error={error} />;
          return (
            <span className={document.error ? "text-destructive" : "text-muted-foreground"}>
              {document.error ?? getPreviewDescription(document) ?? "—"}
            </span>
          );
        }
        const path = column.key.slice("field:".length);
        const error =
          fieldErrorAtPath(document.fieldErrors, path) ??
          (hasFieldErrors(document.fieldErrors, path)
            ? Object.entries(document.fieldErrors ?? {}).find(
                ([key]) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`),
              )?.[1]
            : undefined);
        return error ? (
          <FieldCalculationError error={error} />
        ) : hidden.has(path) ? null : (
          (values.get(path) ?? "—")
        );
      }}
    />
  );
}
