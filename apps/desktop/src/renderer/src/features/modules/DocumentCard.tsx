import type { ModuleDocument } from "@shared/desktop-api";
import type { DocumentType } from "@tarp/module/document-type";
import { isDocumentVisible } from "@tarp/module/module-document";
import { cn } from "cn";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, type ReactNode } from "react";

import { RoomDocument } from "../sessions/room-document";
import { useDocumentLibrary } from "./document-library-context";
import { DocumentCardContent } from "./DocumentCardContent";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentDialog } from "./DocumentDialog";
import { DocumentReferences, type ReferenceDocument } from "./DocumentReferences";

/** 文档概要卡片。点击后用文档弹框打开详情，页脚留给调用方。 */
function DocumentCardContents({
  document,
  documentType,
  subtitle,
  open,
  onOpenChange,
  disabled,
  references,
  referenceTypes,
  footer,
  onSelect,
  selected,
}: {
  readonly document: ModuleDocument;
  readonly documentType?: DocumentType;
  readonly subtitle?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly disabled?: boolean;
  readonly references?: readonly ReferenceDocument[];
  readonly referenceTypes?: readonly DocumentType[];
  readonly footer?: ReactNode;
  /** 提供后，点卡片只选择；详情改由单独按钮打开。 */
  readonly onSelect?: () => void;
  readonly selected?: boolean;
}) {
  const library = useDocumentLibrary();
  const unavailable = !document.valid && !library;
  const types = useMemo(() => (documentType ? [documentType] : []), [documentType]);
  if (!library && !isDocumentVisible(document, documentType)) return null;
  const body = references ? (
    <DocumentReferences documents={references} types={referenceTypes ?? types}>
      <DocumentDetail document={document} documentType={documentType} scrollable />
    </DocumentReferences>
  ) : undefined;
  // 选卡请求会短暂禁用整组卡片，保持亮度稳定，避免每次点击都整体闪烁。
  const cardClass = cn(
    "group border-border/60 bg-card hover:border-ring/50 flex h-full w-full cursor-default flex-col overflow-hidden rounded-xl border text-left transition-[border-color,background-color,box-shadow] outline-none hover:shadow-lg focus-visible:outline-1 focus-visible:outline-ring focus-visible:-outline-offset-2 focus-visible:border-ring disabled:cursor-default",
    onSelect && selected && "border-ring bg-accent/30",
    (!onSelect || !document.valid) && "disabled:opacity-60",
  );
  if (!onSelect) {
    return (
      <DocumentDialog
        document={document}
        documentType={documentType}
        open={open}
        onOpenChange={onOpenChange}
        footer={footer}
        body={body}
        trigger={
          <button type="button" disabled={disabled || unavailable} className={cardClass}>
            <DocumentCardContent
              document={document}
              documentType={documentType}
              subtitle={subtitle}
            />
          </button>
        }
      />
    );
  }
  return (
    <motion.div
      className="relative h-full rounded-xl"
      animate={{ scale: selected ? 1.02 : 1 }}
      whileTap={disabled ? undefined : { scale: selected ? 1 : 0.98 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
    >
      <AnimatePresence>
        {selected ? (
          <motion.span
            key="selected"
            aria-hidden="true"
            className="bg-primary text-primary-foreground pointer-events-none absolute top-2 left-2 z-10 flex size-6 items-center justify-center rounded-full shadow-md"
            initial={{ scale: 0, opacity: 0, rotate: -45 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 24 }}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        disabled={disabled || unavailable}
        aria-pressed={selected}
        onClick={onSelect}
        className={cardClass}
      >
        <DocumentCardContent document={document} documentType={documentType} subtitle={subtitle} />
      </button>
      <DocumentDialog
        document={document}
        documentType={documentType}
        open={open}
        onOpenChange={onOpenChange}
        footer={footer}
        body={body}
        trigger={
          <button
            type="button"
            disabled={disabled || unavailable}
            className="bg-background/80 text-foreground hover:bg-background focus-visible:outline-ring absolute top-2 right-2 rounded-md px-2 py-1 text-xs backdrop-blur-sm outline-none focus-visible:outline-1 focus-visible:outline-offset-2"
          >
            详情
          </button>
        }
      />
    </motion.div>
  );
}

export function DocumentCard(props: Parameters<typeof DocumentCardContents>[0]) {
  return (
    <RoomDocument document={props.document}>
      {(document) => <DocumentCardContents {...props} document={document} />}
    </RoomDocument>
  );
}
