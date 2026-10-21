import type { DocumentField } from "@tarp/module/document-type";
import type { ReferenceCollectionLayout } from "@tarp/module/reference-collection";
import { LayoutGrid, List, PanelsTopLeft, Search } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useRoomDocumentId } from "../sessions/room-document";
import { DocumentCover } from "./DocumentCover";
import { DocumentReference, useDocumentReferenceIndex } from "./DocumentReferences";
import { InventorySlots } from "./InventorySlots";
import type { ReferenceCollectionRow } from "./reference-collection";
import {
  buildReferenceCollectionRows,
  filterReferenceCollectionRows,
} from "./reference-collection";
import { ComputedReferenceItems, ReferenceItemDocument } from "./ReferenceItemDocument";
import { ReferenceSheet } from "./ReferenceSheet";
import { computedCollectionRows, roomCollectionCandidates } from "./room-collection-rows";

const RoomCollectionLoader = lazy(() => import("../sessions/room-collection-loader"));

/** 搜索、筛选和视图切换仅存在于组件内，不修改文档或存档。 */
export function ReferenceCollection({
  value,
  field,
  config,
}: {
  readonly value: unknown;
  readonly field: DocumentField;
  readonly config: ReferenceCollectionLayout;
}) {
  const documents = useDocumentReferenceIndex();
  const roomId = useRoomDocumentId();
  const rows = useMemo(
    () => buildReferenceCollectionRows(value, field, config, documents, !roomId),
    [value, field, config, documents, roomId],
  );
  const candidates = useMemo(() => roomCollectionCandidates(rows, documents), [rows, documents]);
  if (!roomId) return <ReferenceCollectionView rows={rows} field={field} config={config} />;
  return (
    <Suspense
      fallback={
        <ComputedReferenceItems>
          <ReferenceCollectionView
            rows={computedCollectionRows(rows, [])}
            field={field}
            config={config}
          />
        </ComputedReferenceItems>
      }
    >
      <RoomCollectionLoader roomId={roomId} documents={candidates} rows={rows}>
        {(computed) => <ReferenceCollectionView rows={computed} field={field} config={config} />}
      </RoomCollectionLoader>
    </Suspense>
  );
}

function ReferenceCollectionView({
  rows,
  field,
  config,
}: {
  rows: ReferenceCollectionRow[];
  field: DocumentField;
  config: ReferenceCollectionLayout;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [displayOverride, setDisplay] = useState<ReferenceCollectionLayout["display"]>();
  const gridDisplay = config.display === "list" ? "cards" : config.display;
  const display = config.switchable ? (displayOverride ?? config.display) : config.display;
  const categories = [...new Set(rows.flatMap((row) => (row.category ? [row.category] : [])))];
  const activeCategory =
    config.filterField && category && categories.includes(category) ? category : undefined;
  const visible = filterReferenceCollectionRows(
    rows,
    config.searchable ? query : "",
    activeCategory,
  );
  const filtered = Boolean((config.searchable && query.trim()) || activeCategory);
  const slotCount = config.slotCount ?? 20;
  return (
    <div className="@container/collection min-w-0 space-y-3" data-reference-collection={field.key}>
      {config.searchable || config.switchable ? (
        <div className="flex min-w-0 items-center gap-2">
          {config.searchable ? (
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5"
              />
              <Input
                type="search"
                aria-label={`搜索${field.label}`}
                placeholder={`搜索${field.label}…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
          ) : (
            <span className="flex-1" />
          )}
          {config.switchable ? (
            <div
              role="group"
              aria-label={`${field.label}展示方式`}
              className="border-border flex shrink-0 rounded-lg border p-0.5"
            >
              <Button
                size="icon-sm"
                variant={display === gridDisplay ? "secondary" : "ghost"}
                aria-label={
                  gridDisplay === "slots"
                    ? "物品格视图"
                    : gridDisplay === "sheets"
                      ? "文档卡片视图"
                      : "卡片视图"
                }
                aria-pressed={display === gridDisplay}
                onClick={() => setDisplay(gridDisplay)}
              >
                {gridDisplay === "sheets" ? <PanelsTopLeft /> : <LayoutGrid />}
              </Button>
              <Button
                size="icon-sm"
                variant={display === "list" ? "secondary" : "ghost"}
                aria-label="列表视图"
                aria-pressed={display === "list"}
                onClick={() => setDisplay("list")}
              >
                <List />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {config.filterField && categories.length > 1 ? (
        <div role="group" aria-label={`${field.label}分类`} className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant={!activeCategory ? "secondary" : "ghost"}
            aria-pressed={!activeCategory}
            onClick={() => setCategory(undefined)}
          >
            全部 {rows.length}
          </Button>
          {categories.map((item) => (
            <Button
              key={item}
              size="xs"
              variant={activeCategory === item ? "secondary" : "ghost"}
              aria-pressed={activeCategory === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      ) : null}
      <p role="status" className="text-muted-foreground text-[11px] tabular-nums">
        {display === "slots" && !filtered
          ? `${rows.length} / ${slotCount} 格${rows.length > slotCount ? " · 超出展示容量" : ""}`
          : `${visible.length} / ${rows.length} 项`}
      </p>
      {display === "slots" && (visible.length > 0 || !filtered) ? (
        <InventorySlots
          rows={visible}
          label={field.label}
          slotCount={slotCount}
          filtered={filtered}
        />
      ) : display === "sheets" && visible.length ? (
        <ul aria-label={field.label} className="space-y-3">
          {visible.map((row) => (
            <li key={row.key} className="border-border/60 bg-card min-w-0 rounded-xl border p-3">
              <ReferenceSheet reference={row.reference} />
            </li>
          ))}
        </ul>
      ) : visible.length ? (
        <ul
          aria-label={field.label}
          className={
            display === "cards"
              ? "grid grid-cols-1 gap-3 @xs/collection:grid-cols-2 @xl/collection:grid-cols-3"
              : "space-y-2"
          }
        >
          {visible.map((entry) => (
            <ReferenceItemDocument key={entry.key} row={entry}>
              {(row) => {
                const content = (
                  <div className={display === "list" ? "flex items-center gap-3 p-2" : "h-full"}>
                    <DocumentCover
                      src={row.image}
                      path={row.path ?? row.reference}
                      title={row.title}
                      imageAspect={display === "cards" ? config.imageAspect : undefined}
                      className={
                        display === "list"
                          ? "size-14 shrink-0 rounded-md"
                          : "border-border/50 w-full border-b"
                      }
                    />
                    <div
                      className={
                        display === "list" ? "min-w-0 flex-1 py-1 pr-1" : "min-w-0 space-y-2 p-3"
                      }
                    >
                      <div className="text-foreground text-sm leading-5 font-medium [overflow-wrap:anywhere]">
                        {row.title}
                      </div>
                      {row.metadata.length ? (
                        <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-5">
                          {row.metadata.map((entry) => (
                            <div key={entry.key} className="flex min-w-0 gap-1">
                              <dt className="text-muted-foreground">{entry.label}</dt>
                              <dd className="text-foreground/85 [overflow-wrap:anywhere] tabular-nums">
                                {entry.text}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {row.unavailable ? (
                        <p className="text-muted-foreground mt-1 text-xs">资料暂不可用</p>
                      ) : null}
                    </div>
                  </div>
                );
                return (
                  <li
                    key={row.key}
                    className="border-border/70 bg-card hover:border-ring/40 min-w-0 overflow-hidden rounded-xl border transition-colors"
                  >
                    {row.reference ? (
                      <DocumentReference value={row.reference} variant="card">
                        {content}
                      </DocumentReference>
                    ) : (
                      content
                    )}
                  </li>
                );
              }}
            </ReferenceItemDocument>
          ))}
        </ul>
      ) : (
        <div className="border-border/60 rounded-xl border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">
            {rows.length ? "没有符合条件的条目" : `暂无${field.label}`}
          </p>
          {rows.length ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                setQuery("");
                setCategory(undefined);
              }}
            >
              清除筛选
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
