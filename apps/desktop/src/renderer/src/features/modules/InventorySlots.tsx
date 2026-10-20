import { CircleQuestionMark } from "lucide-react";

import { Tooltip } from "../../components/ui/tooltip";
import { DocumentCover } from "./DocumentCover";
import { DocumentReference } from "./DocumentReferences";
import type { ReferenceCollectionRow } from "./reference-collection";
import { ReferenceItemDocument } from "./ReferenceItemDocument";
import { useSlotGrid } from "./use-slot-grid";

/** 一个条目占一个展示格；容量不参与规则计算，超出时保留全部物品。 */
export function InventorySlots({
  rows,
  label,
  slotCount,
  filtered,
}: {
  readonly rows: readonly ReferenceCollectionRow[];
  readonly label: string;
  readonly slotCount: number;
  readonly filtered: boolean;
}) {
  const grid = useSlotGrid();
  const emptyCount = filtered ? 0 : Math.max(0, slotCount - rows.length);
  return (
    <ul {...grid} aria-label={label} data-inventory-slots className="grid gap-1">
      {rows.map((entry) => (
        <ReferenceItemDocument key={entry.key} row={entry}>
          {(row) => {
            const description = [
              row.title,
              ...row.metadata.map((entry) => `${entry.label}：${entry.text}`),
              ...(row.unavailable ? ["资料暂不可用"] : []),
            ].join(" · ");
            const content = (
              <Tooltip content={row.reference ? undefined : description}>
                <div
                  className="relative aspect-square overflow-hidden rounded-sm"
                  tabIndex={row.reference ? undefined : 0}
                >
                  <span className="sr-only">{description}</span>
                  <div className="relative aspect-square">
                    {row.image ? (
                      <DocumentCover
                        src={row.image}
                        path={row.path ?? row.reference}
                        title={row.title}
                        className="absolute inset-0 size-full bg-transparent [&_img]:p-0.5"
                      />
                    ) : (
                      <CircleQuestionMark
                        aria-hidden="true"
                        className="text-muted-foreground/35 absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2"
                      />
                    )}
                  </div>
                  <div className="from-muted via-muted/90 absolute inset-x-0 bottom-0 min-w-0 bg-gradient-to-t to-transparent px-1 pt-3 pb-0.5 dark:from-black/85 dark:via-black/40">
                    <span className="text-foreground block truncate text-[9px] leading-3 dark:text-white dark:[text-shadow:0_1px_2px_black]">
                      {row.title}
                    </span>
                  </div>
                  {row.quantity !== undefined ? (
                    <span
                      aria-label={`数量 ${row.quantity}`}
                      className="bg-background/90 text-foreground absolute top-0.5 right-0.5 max-w-full truncate rounded-sm px-0.5 text-[10px] leading-3 font-semibold tabular-nums dark:bg-black/60 dark:text-white"
                    >
                      {row.quantity}
                    </span>
                  ) : null}
                  {row.unavailable ? (
                    <span
                      aria-hidden="true"
                      className="bg-background/90 text-muted-foreground absolute top-1 left-1 rounded px-1 text-[10px]"
                    >
                      暂不可用
                    </span>
                  ) : null}
                </div>
              </Tooltip>
            );
            return (
              <li
                key={row.key}
                className="border-border bg-muted hover:border-input relative min-w-0 overflow-hidden rounded-sm border transition-colors dark:border-white/15 dark:bg-zinc-900 dark:shadow-[inset_0_0_6px_#000] dark:hover:border-amber-200/50"
              >
                {row.reference ? (
                  <DocumentReference
                    value={row.reference}
                    variant="card"
                    hoverContent={
                      row.metadata.length > 0 ? (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                          {row.metadata.map((entry) => (
                            <div key={entry.key} className="min-w-0">
                              <dt className="text-muted-foreground mb-1">{entry.label}</dt>
                              <dd className="leading-5 [overflow-wrap:anywhere] tabular-nums">
                                {entry.text}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : undefined
                    }
                  >
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
      {Array.from({ length: emptyCount }, (_, index) => (
        <li
          key={`empty-${index}`}
          aria-label={`空物品槽 ${index + 1}`}
          className="border-border bg-secondary relative aspect-square min-w-0 rounded-sm border dark:border-white/10 dark:bg-zinc-950/90 dark:shadow-[inset_0_1px_5px_#000]"
        ></li>
      ))}
    </ul>
  );
}
