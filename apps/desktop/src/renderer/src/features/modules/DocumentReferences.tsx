import { PreviewCard } from "@base-ui/react/preview-card";
import { documentIdentity } from "@jointarp/module/document-path";
import { defaultDocumentHover, type DocumentType } from "@jointarp/module/document-type";
import { isDocumentVisible } from "@jointarp/module/module-document";
import type { ModuleDocument } from "@shared/desktop-api";
import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import type { Components } from "react-markdown";

import { ImagePreview, ImagePreviewProvider } from "../../components/ImagePreview";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { Tooltip } from "../../components/ui/tooltip";
import { RoomDocument } from "../sessions/room-document";
import { useDocumentImage } from "./document-image";
import { useDocumentLibrary } from "./document-library-context";
import { documentReferencePath } from "./document-preview";
import { DocumentDialog } from "./DocumentDialog";
import { DocumentPreview } from "./DocumentPreview";

export const ReferenceContext = createContext<{
  documents: Map<string, ReferenceDocument>;
  types: Map<string, DocumentType>;
  view: "module" | "game";
  onOpen?: () => void;
} | null>(null);

export type ReferenceDocument = Pick<ModuleDocument, "path" | "title" | "docType"> &
  Partial<Omit<ModuleDocument, "path" | "title" | "docType">>;

/** 集合共享已有公开资料索引，避免逐条请求或重复扫描文档。 */
export function useDocumentReferenceIndex() {
  return useContext(ReferenceContext)?.documents;
}

export function useDocumentReferenceType(typeId: string | undefined): DocumentType | undefined {
  return useContext(ReferenceContext)?.types.get(typeId ?? "");
}

export function useDocumentReferenceDocument(
  value: string | undefined,
): ReferenceDocument | undefined {
  const context = useContext(ReferenceContext);
  return value ? context?.documents.get(documentIdentity(value)) : undefined;
}

export function DocumentReferences({
  documents,
  types,
  view = "module",
  onOpen,
  children,
}: {
  documents: readonly ReferenceDocument[];
  types: readonly DocumentType[];
  view?: "module" | "game";
  onOpen?: () => void;
  children: ReactNode;
}) {
  const context = useMemo(
    () => ({
      documents: new Map(
        documents.map((document) => [documentIdentity(document.path), document] as const),
      ),
      types: new Map(types.map((type) => [type.id, type])),
      view,
      onOpen,
    }),
    [documents, onOpen, types, view],
  );
  return (
    <ImagePreviewProvider>
      <ReferenceContext.Provider value={context}>{children}</ReferenceContext.Provider>
    </ImagePreviewProvider>
  );
}

export function DocumentReference({
  value,
  children,
  hoverContent,
  preserveText = false,
  variant = "inline",
  referenceStyle,
  open: controlledOpen,
  onOpenChange,
}: {
  value: string;
  children?: ReactNode;
  /** 当前引用条目的公开摘要，不修改共用资料或详情。 */
  hoverContent?: ReactNode;
  /** 聊天中已经显示过的文字不随资料刷新消失，资料不可用时保留为普通文本。 */
  preserveText?: boolean;
  variant?: "inline" | "card";
  referenceStyle?: "link" | "badge";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const context = useContext(ReferenceContext);
  const library = useDocumentLibrary();
  const document = context?.documents.get(documentIdentity(value));
  const [label, setLabel] = useState<ReactNode>();
  const fallback = preserveText ? (
    <span className="text-foreground font-medium underline decoration-1 underline-offset-4">
      {label ?? children}
    </span>
  ) : undefined;
  if (!document) {
    if (preserveText && label !== undefined) return fallback;
    return (
      <span className={variant === "card" ? "block w-full" : undefined}>{children ?? value}</span>
    );
  }
  if (document.valid === undefined && context?.view !== "game") {
    if (!library && document.visible === false) return null;
    return (
      <span
        className={
          variant === "card"
            ? "text-foreground block w-full"
            : "text-foreground [overflow-wrap:anywhere]"
        }
      >
        {children ?? document.title}
      </span>
    );
  }
  return (
    <RoomDocument
      document={{ ...document, valid: document.valid ?? true } as ModuleDocument}
      pendingFallback={fallback}
      errorFallback={preserveText ? () => fallback : undefined}
    >
      {(computed) => (
        <ResolvedDocumentReference
          document={computed}
          children={preserveText ? (label ?? children) : children}
          onLabel={preserveText && label === undefined ? setLabel : undefined}
          fallback={fallback}
          hoverContent={hoverContent}
          variant={variant}
          referenceStyle={referenceStyle}
          open={controlledOpen}
          onOpenChange={onOpenChange}
        />
      )}
    </RoomDocument>
  );
}

function ResolvedDocumentReference({
  document: interactiveDocument,
  children,
  hoverContent,
  onLabel,
  fallback,
  variant,
  referenceStyle,
  open: controlledOpen,
  onOpenChange,
}: {
  document: ModuleDocument;
  children?: ReactNode;
  hoverContent?: ReactNode;
  onLabel?: (label: ReactNode) => void;
  fallback?: ReactNode;
  variant: "inline" | "card";
  referenceStyle?: "link" | "badge";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const context = useContext(ReferenceContext);
  const library = useDocumentLibrary();
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const [previewOpen, setPreviewOpen] = useState(false);
  const documentType = interactiveDocument.docType
    ? context?.types.get(interactiveDocument.docType)
    : undefined;
  const hidden = !library && !isDocumentVisible(interactiveDocument, documentType);
  useEffect(() => {
    if (!hidden && interactiveDocument.valid) onLabel?.(children ?? interactiveDocument.title);
  }, [hidden, interactiveDocument.valid, interactiveDocument.title, children, onLabel]);
  useEffect(() => {
    if (!hidden) return;
    setOpen(false);
    setPreviewOpen(false);
    if (controlledOpen) onOpenChange?.(false);
  }, [hidden, controlledOpen, onOpenChange]);
  if (hidden || (fallback !== undefined && !interactiveDocument.valid)) return fallback ?? null;
  const hover = documentType?.layout?.hover ?? defaultDocumentHover;
  const trigger = (
    <Tooltip content={hover.enabled ? undefined : `查看${interactiveDocument.title}`}>
      <button
        type="button"
        data-document-link={variant === "inline" ? "" : undefined}
        disabled={!interactiveDocument.valid && !library}
        className={
          variant === "card"
            ? "group/card focus-visible:outline-ring block w-full rounded-[inherit] text-left focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
            : (referenceStyle ?? documentType?.layout?.reference?.style) === "badge"
              ? "text-foreground decoration-foreground/30 hover:decoration-foreground/70 ring-foreground/15 focus-visible:outline-ring inline rounded px-1.5 py-0.5 text-[0.92em] font-medium underline decoration-1 underline-offset-4 ring-1 transition-colors ring-inset focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
              : "text-foreground decoration-foreground/30 hover:decoration-foreground/70 focus-visible:outline-ring max-w-full rounded-sm text-left font-medium [overflow-wrap:anywhere] underline decoration-1 underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
        }
      >
        {children ?? interactiveDocument.title}
      </button>
    </Tooltip>
  );
  const dialog = (
    <DocumentDialog
      document={interactiveDocument}
      documentType={documentType}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
        if (nextOpen) {
          setPreviewOpen(false);
          if (context?.view === "game") context.onOpen?.();
        }
      }}
      trigger={
        hover.enabled && interactiveDocument.valid ? (
          <PreviewCard.Trigger delay={300} closeDelay={150} render={trigger} />
        ) : (
          trigger
        )
      }
    />
  );
  if (!hover.enabled || !interactiveDocument.valid) return dialog;
  return (
    <PreviewCard.Root open={!open && previewOpen} onOpenChange={setPreviewOpen}>
      {dialog}
      <PreviewCard.Portal>
        <PreviewCard.Positioner sideOffset={8} className="z-[80]">
          <PreviewCard.Popup
            className="bg-popover text-popover-foreground ring-border max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl shadow-xl ring-1 transition-opacity outline-none data-ending-style:opacity-0 data-starting-style:opacity-0"
            style={{ width: { sm: 256, md: 320, lg: 384 }[hover.width] }}
          >
            <ScrollAreaPane className="max-h-[min(28rem,80dvh)]">
              <DocumentPreview document={interactiveDocument} documentType={documentType}>
                {hoverContent}
              </DocumentPreview>
            </ScrollAreaPane>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

const MarkdownDocumentImage: NonNullable<Components["img"]> = ({ src, alt }) => {
  // Markdown 会把图片地址里的中文百分号编码，查找前要还原成图片路径。
  const context = useContext(ReferenceContext);
  const imagePath = typeof src === "string" ? documentReferencePath(src) : undefined;
  const document = imagePath
    ? [...(context?.documents.values() ?? [])].find(
        (candidate) => candidate.image?.replace(/^\.\//u, "") === imagePath,
      )
    : undefined;
  const image =
    document && document.valid !== false && document.visible !== false ? document.image : undefined;
  const url = useDocumentImage(
    document?.path,
    image ?? imagePath ?? (typeof src === "string" ? src : undefined),
  );
  if (!url || document?.visible === false) return null;
  const description = typeof alt === "string" ? alt : "";
  return (
    <ImagePreview src={url} alt={description || document?.title || ""} className="my-2">
      <img src={url} alt={description} className="block max-h-96 max-w-full rounded-xl" />
    </ImagePreview>
  );
};

const MarkdownDocumentLink: NonNullable<Components["a"]> = ({
  href,
  children,
  node,
  title,
  ...props
}) => {
  const context = useContext(ReferenceContext);
  const path = href ? documentReferencePath(href) : undefined;
  const wiki = node?.properties?.["data-document-reference"] === "wiki";
  if (path && (wiki || context?.documents.has(documentIdentity(path))))
    return (
      <DocumentReference value={path} referenceStyle="link">
        {wiki ? undefined : children}
      </DocumentReference>
    );
  const link = (
    <a
      {...props}
      href={href}
      {...(href && /^https?:\/\//iu.test(href)
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {children}
    </a>
  );
  return title ? <Tooltip content={title}>{link}</Tooltip> : link;
};

export const documentMarkdownComponents: Components = {
  a: MarkdownDocumentLink,
  img: MarkdownDocumentImage,
};
