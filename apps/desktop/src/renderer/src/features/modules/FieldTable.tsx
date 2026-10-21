import type { DocumentField } from "@tarp/module/document-type";
import { validateFieldTableRows, type FieldTableLayout } from "@tarp/module/field-table";
import {
  fieldErrorAtPath,
  getPublicDocumentField,
  shouldHideEmptyField,
} from "@tarp/module/public-document-field";
import { useState } from "react";

import { Input } from "../../components/ui/input";
import { DocumentValue } from "./DocumentValue";
import { SimpleTable } from "./SimpleTable";

/** 公开字段组成的紧凑表格；分组依据模组计算结果，不在界面中判断游戏规则。 */
export function FieldTable({
  value,
  field,
  config,
  fieldErrors,
  path = field.key,
}: {
  readonly value: unknown;
  readonly field: DocumentField;
  readonly config: FieldTableLayout;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly path?: string;
}) {
  const [query, setQuery] = useState("");
  try {
    validateFieldTableRows(value, config);
  } catch (error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {field.label}数据无效：{error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  const rows = Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          row !== null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
  const columns = config.columns.flatMap((column) => {
    const definition = getPublicDocumentField(field.item?.fields ?? [], column.field);
    return definition ? [{ ...column, definition }] : [];
  });
  const definitions = new Map(columns.map((column) => [column.field, column.definition]));
  const tableColumns = columns.map((column) => ({
    key: column.field,
    label: column.label ?? column.definition.label,
    numeric: column.definition.type === "number",
  }));
  const group = config.collapsedGroup;
  const groupField = group && getPublicDocumentField(field.item?.fields ?? [], group.field);
  const groupKey =
    groupField?.visibility === "public" && groupField.type === "boolean" ? group?.field : undefined;
  const needle = config.searchable ? query.trim().toLocaleLowerCase() : "";
  const visible = needle
    ? rows.filter((row) =>
        columns.some(
          (column) =>
            !shouldHideEmptyField(column.definition, row[column.field]) &&
            String(row[column.field] ?? "")
              .toLocaleLowerCase()
              .includes(needle),
        ),
      )
    : rows;
  const primary = groupKey ? visible.filter((row) => row[groupKey] !== false) : visible;
  const collapsed = groupKey ? visible.filter((row) => row[groupKey] === false) : [];
  const table = (entries: readonly Record<string, unknown>[], label: string) => (
    <SimpleTable
      label={label}
      columns={tableColumns}
      rows={entries}
      rowKey={(row) => String(row[config.rowKey]).trim()}
      renderCell={(row, column) => {
        const value = row[column.key];
        const definition = definitions.get(column.key);
        const fieldPath = `${path}[${rows.indexOf(row)}].${column.key}`;
        if (!fieldErrorAtPath(fieldErrors, fieldPath) && shouldHideEmptyField(definition, value))
          return null;
        return value === undefined && !fieldErrorAtPath(fieldErrors, fieldPath) ? (
          "—"
        ) : (
          <DocumentValue
            value={value}
            definition={definition}
            fieldErrors={fieldErrors}
            path={fieldPath}
          />
        );
      }}
    />
  );
  return (
    <div className="space-y-3">
      {config.searchable ? (
        <Input
          type="search"
          aria-label={`搜索${field.label}`}
          placeholder={`搜索${field.label}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {primary.length ? (
        table(primary, field.label)
      ) : collapsed.length ? null : (
        <p className="text-muted-foreground text-xs">暂无{field.label}</p>
      )}
      {collapsed.length && group ? (
        <details className="group" open={needle ? true : undefined}>
          <summary className="text-muted-foreground hover:text-foreground focus-visible:outline-ring cursor-default py-2 text-xs focus-visible:outline-2">
            {group.label} · {collapsed.length} 项
          </summary>
          <div className="pt-2">{table(collapsed, group.label)}</div>
        </details>
      ) : null}
    </div>
  );
}
