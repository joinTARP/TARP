import type { DocumentType } from "@jointarp/module/document-type";
import type { GameStart } from "@jointarp/module/flow";
import { parseNarrative } from "@jointarp/module/narrative";
import type { ModuleDocument, ModuleMetadata } from "@shared/desktop-api";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeft, UserRound } from "lucide-react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { buttonVariants } from "../../components/ui/button";
import { DocumentReference } from "./DocumentReferences";
import { FlowEmptyState, FlowOutline } from "./FlowOutline";

export type LaunchOverviewPageId = "prelude" | "starts" | "creation";

interface LaunchOverviewPageProps {
  readonly modulePath: string;
  readonly page: LaunchOverviewPageId;
  readonly metadata: ModuleMetadata;
  readonly documentTypes: readonly DocumentType[];
  readonly documents: readonly ModuleDocument[];
  readonly defineId?: string;
}

function typeName(types: readonly DocumentType[], id: string): string {
  return types.find((type) => type.id === id)?.name ?? id;
}

function characterSource(start: GameStart): string {
  const preset = start.playablePaths.length;
  if (preset && start.allowCreate) return `可选 ${preset} 个预设，也可创建`;
  if (preset) return `仅可选 ${preset} 个预设角色`;
  return "仅可创建角色";
}

function OpeningBeats({ beats }: { readonly beats: GameStart["opening"]["beats"] }) {
  if (beats.length === 0) return null;
  return (
    <ol className="space-y-4">
      {beats
        .flatMap((beat) => parseNarrative(beat.text))
        .map((beat, index) => (
          <li key={`${beat.path ?? "narration"}:${index}`}>
            <p className="text-muted-foreground text-xs font-medium">
              {beat.path ? (
                <>
                  <DocumentReference value={beat.path} />
                  {beat.name ? `（${beat.name}）` : ""}
                </>
              ) : (
                "旁白"
              )}
            </p>
            <p className="text-foreground/90 mt-1 text-sm leading-7 break-words whitespace-pre-wrap">
              {beat.text}
            </p>
          </li>
        ))}
    </ol>
  );
}

function GameStartCard({
  start,
  types,
}: {
  readonly start: GameStart;
  readonly types: readonly DocumentType[];
}) {
  const opening = start.opening;
  const overrideEntries = Object.entries(opening.overrides);
  return (
    <article className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{start.name}</h2>
          {start.description ? (
            <p className="text-muted-foreground mt-1 text-sm leading-6">{start.description}</p>
          ) : null}
        </div>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-2 py-1 text-[11px] font-medium">
          {opening.mode === "scripted" ? "预写开场" : "AI 开场"}
        </span>
      </div>
      <div className="border-border bg-card divide-border/60 divide-y rounded-xl border">
        <dl className="divide-border/60 divide-y text-sm">
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4 px-4 py-3">
            <dt className="text-muted-foreground">角色类型</dt>
            <dd className="break-words">
              {start.characterTypeIds.map((id) => typeName(types, id)).join("、")}
            </dd>
          </div>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4 px-4 py-3">
            <dt className="text-muted-foreground">选角</dt>
            <dd className="break-words">{characterSource(start)}</dd>
          </div>
          {start.playablePaths.length > 0 ? (
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4 px-4 py-3">
              <dt className="text-muted-foreground">预设角色</dt>
              <dd className="break-words">
                {start.playablePaths.map((path, index) => (
                  <span key={path}>
                    {index > 0 ? "、" : null}
                    <DocumentReference value={path} />
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="space-y-5 p-4">
          {opening.mode === "ai" && opening.prompt.trim() ? (
            <div className="space-y-2">
              <h3 className="text-xs font-medium">开场指令</h3>
              <p className="text-foreground/90 text-sm leading-7 whitespace-pre-wrap">
                {opening.prompt}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <h3 className="text-xs font-medium">通用开场</h3>
              <OpeningBeats beats={opening.beats} />
            </div>
          )}
          {opening.instructions.trim() ? (
            <div className="border-border/60 space-y-2 border-t pt-4">
              <h3 className="text-xs font-medium">初始化指令</h3>
              <p className="text-muted-foreground text-sm leading-6 whitespace-pre-wrap">
                {opening.instructions}
              </p>
            </div>
          ) : null}
          {overrideEntries.map(([path, beats]) => (
            <div className="border-border/60 space-y-3 border-t pt-4" key={path}>
              <h3 className="text-xs font-medium">
                <DocumentReference value={path} /> 的专属开场
              </h3>
              <OpeningBeats beats={beats} />
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function PreludePage({
  metadata,
  documents,
}: {
  readonly metadata: ModuleMetadata;
  readonly documents: readonly ModuleDocument[];
}) {
  const flow = metadata.preludeFlow;
  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-5xl"
        title="开场文案"
        description={
          flow?.steps.length
            ? `${flow.steps.length} 个步骤 · 进入冒险时展示`
            : "进入冒险时展示的介绍与选项"
        }
        resetKey="prelude"
      />
      <div className="mx-auto w-full max-w-5xl px-9">
        <div className="mt-10 space-y-10">
          {flow?.steps.length ? (
            <FlowOutline flow={flow} documents={documents} />
          ) : (
            <FlowEmptyState
              title="还没有开场文案"
              description="没有这一页时，进房后会直接挑选从哪里出发。"
            />
          )}
        </div>
      </div>
    </>
  );
}

function StartsPage({
  metadata,
  documentTypes,
}: {
  readonly metadata: ModuleMetadata;
  readonly documentTypes: readonly DocumentType[];
}) {
  const starts = metadata.gameStarts ?? [];
  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-5xl"
        title="开局方案"
        description={
          starts.length === 0 ? "还没有开局方案" : `${starts.length} 个方案 · 首次确认角色后锁定`
        }
        resetKey="starts"
      />
      <div className="mx-auto w-full max-w-5xl px-9">
        <div className="mt-10 space-y-10">
          {starts.length === 0 ? (
            <FlowEmptyState
              title="还没有开局方案"
              description="开局方案配置背景说明、可选角色和一次性开场。"
            />
          ) : (
            starts.map((start) => (
              <GameStartCard key={start.id} start={start} types={documentTypes} />
            ))
          )}
        </div>
      </div>
    </>
  );
}

function CreationPage({
  modulePath,
  documentTypes,
  documents,
  defineId,
}: {
  readonly modulePath: string;
  readonly documentTypes: readonly DocumentType[];
  readonly documents: readonly ModuleDocument[];
  readonly defineId?: string;
}) {
  const characters = documentTypes.filter((type) => type.designation === "character");
  const selected = characters.find((type) => type.id === defineId);
  if (selected) {
    const steps = selected.creationFlow?.workbench.stages.length ?? 0;
    return (
      <>
        <PageToolbarHeader
          widthClassName="max-w-5xl"
          title={`${selected.name} · 创建流程`}
          description={
            steps === 0 ? "此角色类型未配置建卡工作台。" : `${steps} 个阶段 · 创建角色时依次完成`
          }
          resetKey={selected.id}
          actions={
            <Link
              data-ui-control
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              to="/module"
              search={{ path: modulePath, page: "creation" }}
              replace
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              全部角色类型
            </Link>
          }
        />
        <div className="mx-auto w-full max-w-5xl px-9">
          <div className="mt-10">
            {steps > 0 ? (
              <FlowOutline flow={selected.creationFlow} documents={documents} />
            ) : (
              <FlowEmptyState
                title="还没有创建流程"
                description="请在角色类型中配置 creationFlow.workbench。"
              />
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-5xl"
        title="角色创建流程"
        description={characters.length === 0 ? "没有角色类型" : `${characters.length} 种角色类型`}
        resetKey="creation"
      />
      <div className="mx-auto w-full max-w-5xl px-9">
        {characters.length === 0 ? (
          <div className="mt-10">
            <FlowEmptyState
              title="没有角色类型"
              description="只有标记为角色的类型，才会走到创建这一步。"
            />
          </div>
        ) : (
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {characters.map((type) => {
              const steps = type.creationFlow?.workbench.stages.length ?? 0;
              return (
                <li key={type.id}>
                  <Link
                    data-ui-control
                    className="border-border bg-card hover:border-ring/50 hover:bg-accent/20 focus-visible:outline-ring focus-visible:border-ring flex h-full w-full flex-col rounded-2xl border p-5 text-left shadow-sm transition-colors outline-none focus-visible:outline-1 focus-visible:-outline-offset-2"
                    to="/module"
                    search={{ path: modulePath, page: "creation", define: type.id }}
                    replace
                  >
                    <div className="flex items-start gap-3">
                      <div className="bg-accent text-ring grid size-10 shrink-0 place-items-center rounded-xl">
                        <UserRound className="size-4" strokeWidth={1.7} aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-base font-semibold">{type.name}</h2>
                        <p className="text-muted-foreground mt-1 text-xs leading-5">
                          {steps === 0 ? "未配置建卡" : `${steps} 个创建阶段`}
                        </p>
                      </div>
                    </div>
                    <p className="text-muted-foreground mt-4 line-clamp-2 text-[11px] leading-5">
                      {type.creationFlow?.workbench.stages?.map((step) => step.title).join(" → ") ||
                        "此角色类型未配置建卡工作台。"}
                    </p>
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

export function LaunchOverviewPage({
  modulePath,
  page,
  metadata,
  documentTypes,
  documents,
  defineId,
}: LaunchOverviewPageProps) {
  if (page === "prelude") {
    return <PreludePage metadata={metadata} documents={documents} />;
  }
  if (page === "starts") {
    return <StartsPage metadata={metadata} documentTypes={documentTypes} />;
  }
  return (
    <CreationPage
      modulePath={modulePath}
      documentTypes={documentTypes}
      documents={documents}
      defineId={defineId}
    />
  );
}
