import type { EquipmentSlotsLayout } from "@jointarp/module/equipment-slots";
import { isDocumentVisible } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";
import { CircleQuestionMark, Crown, Footprints, Gem, Hand, Shield, Shirt } from "lucide-react";

import { RoomDocument } from "../sessions/room-document";
import { DocumentCover } from "./DocumentCover";
import {
  DocumentReference,
  useDocumentReferenceDocument,
  useDocumentReferenceType,
} from "./DocumentReferences";
import { useSlotGrid } from "./use-slot-grid";

const icons = {
  head: Crown,
  body: Shirt,
  feet: Footprints,
  hand: Hand,
  shield: Shield,
  accessory: Gem,
};

function EquipmentSlot({
  slot,
  value,
}: {
  readonly slot: EquipmentSlotsLayout["slots"][number];
  readonly value: unknown;
}) {
  const reference = typeof value === "string" && value.trim() ? value : undefined;
  const document = useDocumentReferenceDocument(reference);
  const type = useDocumentReferenceType(document?.docType);
  if (!document) return <EquipmentSlotContent slot={slot} reference={reference} />;
  return (
    <RoomDocument document={{ ...document, valid: document.valid ?? true } as ModuleDocument}>
      {(current) => (
        <EquipmentSlotContent
          slot={slot}
          reference={reference}
          document={current}
          hidden={!isDocumentVisible(current, type)}
        />
      )}
    </RoomDocument>
  );
}

function EquipmentSlotContent({
  slot,
  reference,
  document,
  hidden = false,
}: {
  slot: EquipmentSlotsLayout["slots"][number];
  reference?: string;
  document?: ModuleDocument;
  hidden?: boolean;
}) {
  if (hidden) reference = undefined;
  const Icon = reference ? CircleQuestionMark : icons[slot.icon];
  const title = hidden ? undefined : (document?.title ?? reference?.split("/").at(-1));
  const unavailable = reference && (!document || document.valid === false);
  const content = (
    <div className="relative aspect-square overflow-hidden rounded-sm">
      <div className="relative aspect-square">
        <Icon
          aria-hidden="true"
          className="text-muted-foreground/30 absolute top-1/2 left-1/2 size-7 -translate-x-1/2 -translate-y-1/2"
        />
        {!hidden && document?.valid && document.image ? (
          <DocumentCover
            src={document.image}
            path={document.path}
            title={document.title}
            className="bg-muted absolute inset-0 size-full dark:bg-zinc-900 [&_img]:p-0.5"
          />
        ) : null}
      </div>
      {reference ? (
        <div className="from-muted via-muted/90 text-foreground absolute inset-x-0 bottom-0 bg-gradient-to-t to-transparent px-1 pt-3 pb-0.5 dark:from-black/85 dark:via-black/40 dark:text-white">
          <span className="block truncate text-[9px] leading-3">{title}</span>
          {unavailable ? (
            <span className="text-muted-foreground block text-[9px]">资料暂不可用</span>
          ) : null}
        </div>
      ) : hidden ? null : (
        <span className="text-muted-foreground absolute inset-x-0 bottom-0.5 text-center text-[9px] leading-3 dark:text-white/30">
          未装备
        </span>
      )}
    </div>
  );
  return (
    <li className="min-w-0" aria-label={`${slot.label}：${title ?? (hidden ? "" : "未装备")}`}>
      <div
        className={
          reference
            ? "border-border bg-muted hover:border-input overflow-hidden rounded-sm border transition-colors dark:border-white/15 dark:bg-zinc-900 dark:shadow-[inset_0_0_6px_#000] dark:hover:border-amber-200/50"
            : "border-border bg-secondary overflow-hidden rounded-sm border dark:border-white/10 dark:bg-zinc-950/90 dark:shadow-[inset_0_1px_5px_#000]"
        }
      >
        {reference ? (
          <DocumentReference value={reference} variant="card">
            {content}
          </DocumentReference>
        ) : (
          content
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-center text-[10px]">{slot.label}</p>
    </li>
  );
}

/** 部位由模组定义；空槽仅作展示，不推断穿戴或规则效果。 */
export function EquipmentSlots({
  value,
  config,
  label,
}: {
  readonly value: unknown;
  readonly config: EquipmentSlotsLayout;
  readonly label: string;
}) {
  const grid = useSlotGrid();
  const values =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return (
    <div className="@container/equipment min-w-0" data-equipment-slots>
      <ul {...grid} aria-label={label} className="grid gap-x-1 gap-y-2">
        {config.slots.map((slot) => (
          <EquipmentSlot
            key={slot.field}
            slot={slot}
            value={values && Object.hasOwn(values, slot.field) ? values[slot.field] : undefined}
          />
        ))}
      </ul>
    </div>
  );
}
