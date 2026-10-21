import type { ModuleDocument } from "@shared/desktop-api";
import { Link } from "@tanstack/react-router";
import { typeFormatLabel } from "@tarp/module/document-path";
import type { DocumentType } from "@tarp/module/document-type";
import { cn } from "cn";
import { FileCode2, FileText, Shapes } from "lucide-react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { buttonVariants } from "../../components/ui/button";
import { TypeDefinitionPanel } from "./TypeDefinitionPanel";

interface DocumentTypesPageProps {
  readonly modulePath: string;
  readonly documentTypes: readonly DocumentType[];
  readonly documents: readonly ModuleDocument[];
  readonly documentCounts: ReadonlyMap<string, number>;
  readonly defineId?: string;
}

export function DocumentTypesPage({
  modulePath,
  documentTypes,
  documents,
  documentCounts,
  defineId,
}: DocumentTypesPageProps) {
  const selected = documentTypes.find((documentType) => documentType.id === defineId);
  if (selected) {
    const format = typeFormatLabel(selected.id, documents);
    return (
      <>
        <PageToolbarHeader
          widthClassName="max-w-5xl"
          title={selected.name}
          description={
            format
              ? `${selected.fields.length} 个字段 · ${format}`
              : `${selected.fields.length} 个字段`
          }
          resetKey={selected.id}
          actions={
            <Link
              data-ui-control
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              to="/module"
              search={{ path: modulePath, page: "types" }}
              replace
            >
              全部类型
            </Link>
          }
        />
        <div className="mx-auto w-full max-w-5xl px-9">
          <div className="mt-10">
            <TypeDefinitionPanel
              documentType={selected}
              modulePath={modulePath}
              documents={documents}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-5xl"
        title="文档类型"
        description={
          documentTypes.length === 0 ? "还没有类型定义" : `${documentTypes.length} 种类型`
        }
        resetKey="types"
      />
      <div className="mx-auto w-full max-w-5xl px-9">
        {documentTypes.length === 0 ? (
          <div className="border-border bg-card/40 mt-10 rounded-2xl border border-dashed px-6 py-16 text-center">
            <Shapes className="text-muted-foreground mx-auto size-8" strokeWidth={1.5} />
            <p className="mt-4 text-sm font-medium">还没有类型</p>
          </div>
        ) : (
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {documentTypes.map((documentType) => {
              const format = typeFormatLabel(documentType.id, documents);
              const Icon = format === "Markdown" ? FileText : FileCode2;
              const count = documentCounts.get(documentType.id) ?? 0;
              const creationSteps = documentType.creationFlow?.workbench.stages.length ?? 0;
              const notes = [
                format,
                documentType.designation === "character" ? "角色" : undefined,
              ].filter((note) => note !== undefined);
              return (
                <li key={documentType.id}>
                  <Link
                    data-ui-control
                    className="border-border bg-card hover:border-ring/50 hover:bg-accent/20 focus-visible:outline-ring focus-visible:border-ring flex h-full w-full flex-col rounded-2xl border p-5 text-left shadow-sm transition-colors outline-none focus-visible:outline-1 focus-visible:-outline-offset-2"
                    to="/module"
                    search={{ path: modulePath, page: "types", define: documentType.id }}
                    replace
                  >
                    <div className="flex items-start gap-3">
                      <div className="bg-accent text-ring grid size-10 shrink-0 place-items-center rounded-xl">
                        <Icon className="size-4" strokeWidth={1.7} aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-base font-semibold">{documentType.name}</h2>
                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                          {documentType.fields.length} 个字段 · {count} 份文档
                          {creationSteps > 0 ? ` · 创建流程 ${creationSteps} 步` : ""}
                        </p>
                      </div>
                    </div>
                    {notes.length > 0 ? (
                      <p className="text-muted-foreground mt-4 text-[11px]">{notes.join(" · ")}</p>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
