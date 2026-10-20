import type { ListModulesResult, ModuleSummary } from "@shared/desktop-api";
import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen, TriangleAlert } from "lucide-react";

import { Tooltip } from "../../components/ui/tooltip";
import { CreateRoomButton } from "../sessions/CreateRoomButton";
import { DocumentCover } from "./DocumentCover";
import { ImportModuleButton } from "./ImportModuleButton";

interface ModuleCardListProps {
  readonly catalog: ListModulesResult | null;
  readonly loading: boolean;
  readonly title?: string;
}

const gridClassName =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,232px),1fr))] gap-x-5 gap-y-8";

export function ModuleCardList({ catalog, loading, title }: ModuleCardListProps) {
  const openingPath = useRouterState({
    select: (state) => (state.isLoading ? (state.location.search as { path?: string }).path : null),
  });
  return (
    <section aria-labelledby={title ? "modules-title" : undefined}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {title ? (
          <SectionHeading
            id="modules-title"
            title={title}
            count={catalog?.status === "success" ? catalog.modules.length : undefined}
          />
        ) : (
          <span className="text-muted-foreground text-xs">
            {catalog?.status === "success" ? `${catalog.modules.length} 个模组` : "模组"}
          </span>
        )}
        <ImportModuleButton
          directory={catalog?.status === "success" ? catalog.directory : undefined}
        />
      </div>
      {catalog?.status === "error" ? (
        <p
          role="alert"
          className="border-destructive/30 text-destructive rounded-xl border p-5 text-sm [overflow-wrap:anywhere]"
        >
          {catalog.message}
        </p>
      ) : null}
      {loading ? <HomeCatalogSkeleton /> : null}
      {catalog?.status === "success" && !loading && !catalog.modules.length ? (
        <div className="border-border text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-sm">
          <BookOpen className="size-6" strokeWidth={1.6} />
          导入 ZIP、文件夹或 Git 模组，开始你的冒险
        </div>
      ) : null}
      {catalog?.status === "success" && catalog.modules.length > 0 ? (
        <ul className={gridClassName}>
          {catalog.modules.map((module) => (
            <li key={module.path} className="min-w-0">
              <ModuleCard module={module} opening={openingPath === module.path} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SectionHeading({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <div className="mb-4 flex items-baseline gap-2">
      <h2 id={id} className="text-[15px] font-semibold tracking-tight">
        {title}
      </h2>
      {count ? <span className="text-muted-foreground text-xs tabular-nums">{count}</span> : null}
    </div>
  );
}

function ModuleCard({ module, opening }: { module: ModuleSummary; opening: boolean }) {
  const broken = Boolean(module.error);
  return (
    <article
      aria-busy={opening}
      className={`group relative flex h-full flex-col transition-opacity ${opening ? "opacity-60" : ""}`}
    >
      <div className="bg-muted ring-foreground/5 relative aspect-[4/3] overflow-hidden rounded-xl ring-1 ring-inset">
        <DocumentCover
          src={module.cover}
          scope={`module:${module.path}`}
          title={module.name}
          className="absolute inset-0 size-full [&_img]:!object-cover [&_img]:transition-transform [&_img]:duration-500 group-hover:[&_img]:scale-[1.04]"
        />
        {!module.cover ? (
          <span
            aria-hidden="true"
            className="text-foreground/10 absolute inset-0 grid place-items-center text-6xl font-semibold select-none"
          >
            {module.name.slice(0, 1)}
          </span>
        ) : null}
        {module.system ? (
          <span className="absolute top-3 left-3 rounded-md bg-black/45 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white/90 backdrop-blur-md">
            {module.system}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Tooltip content={module.name} overflowOnly>
            <h3 className="truncate text-sm font-medium">
              {broken ? (
                module.name
              ) : (
                <Link
                  data-ui-control
                  to="/module"
                  search={{ path: module.path }}
                  className="focus-visible:outline-ring rounded-sm outline-offset-4 after:absolute after:inset-0 focus-visible:outline-2"
                >
                  {module.name}
                </Link>
              )}
            </h3>
          </Tooltip>
          {module.description ? (
            <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
              {module.description}
            </p>
          ) : null}
        </div>
        <CreateRoomButton
          className="relative z-10"
          modulePath={module.path}
          moduleName={module.name}
          disabled={broken}
        />
      </div>
      {broken ? (
        <p className="text-destructive mt-2 flex items-start gap-1.5 text-xs leading-5">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{module.error}</span>
        </p>
      ) : null}
    </article>
  );
}

export function HomeCatalogSkeleton() {
  return (
    <div className={gridClassName} aria-label="正在读取模组">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index}>
          <div className="bg-muted/60 aspect-[4/3] animate-pulse rounded-xl" />
          <div className="bg-muted/60 mt-3 h-4 w-2/3 animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}
