import { Fragment, type ReactNode } from "react";

export interface SimpleTableColumn {
  readonly key: string;
  readonly label: string;
  readonly numeric?: boolean;
  readonly className?: string;
}

/** 共用表格结构和样式，数据读取、权限与交互由调用方负责。 */
export function SimpleTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  renderCell,
  renderRow,
}: {
  readonly label: string;
  readonly columns: readonly SimpleTableColumn[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly renderCell: (row: Row, column: SimpleTableColumn) => ReactNode;
  readonly renderRow?: (row: Row, render: (row: Row) => ReactNode) => ReactNode;
}) {
  const cellClass = (column: SimpleTableColumn) =>
    `px-2 py-2 leading-5 first:pl-0 last:pr-0 ${column.numeric ? "text-right whitespace-nowrap tabular-nums" : ""} ${column.className ?? ""}`;
  const rowContent = (row: Row) => (
    <tr className="hover:bg-muted/20 align-top">
      {columns.map((column, index) =>
        index === 0 ? (
          <th key={column.key} scope="row" className={`${cellClass(column)} font-normal`}>
            {renderCell(row, column)}
          </th>
        ) : (
          <td key={column.key} className={cellClass(column)}>
            {renderCell(row, column)}
          </td>
        ),
      )}
    </tr>
  );
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="focus-visible:outline-ring overflow-x-auto outline-none focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">{label}</caption>
        <thead className="border-border/60 text-muted-foreground border-b text-[11px]">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`${cellClass(column)} font-normal whitespace-nowrap`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={rowKey(row)}>
              {renderRow ? renderRow(row, rowContent) : rowContent(row)}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
