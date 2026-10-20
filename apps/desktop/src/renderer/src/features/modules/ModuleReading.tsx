import type { ModulePageDocument } from "@shared/desktop-api";
import { TriangleAlert } from "lucide-react";
import { Suspense } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { LoadingIndicator } from "../../components/ui/loading-indicator";
import { DocumentMarkdown, documentMarkdownPlugins } from "./document-markdown";
import { documentMarkdownComponents } from "./DocumentReferences";

export function ModuleReading({ page }: { readonly page: ModulePageDocument }) {
  return (
    <>
      <PageToolbarHeader widthClassName="max-w-5xl" title={page.title} resetKey={page.path} />
      <div className="mx-auto w-full max-w-5xl px-9">
        {page.error ? (
          <div
            className="border-destructive/30 bg-destructive/5 mt-10 flex gap-3 rounded-xl border p-4 text-sm"
            role="alert"
          >
            <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {page.path}：{page.error}
            </span>
          </div>
        ) : (
          <div className="prose prose-sm prose-zinc dark:prose-invert mt-8 max-w-none font-sans">
            <Suspense
              fallback={
                <div className="flex min-h-32 items-center justify-center">
                  <LoadingIndicator label="正在加载正文…" />
                </div>
              }
            >
              <DocumentMarkdown
                skipHtml
                components={documentMarkdownComponents}
                remarkPlugins={documentMarkdownPlugins}
              >
                {page.body ?? ""}
              </DocumentMarkdown>
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}
