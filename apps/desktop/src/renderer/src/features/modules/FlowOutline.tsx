import type { ModuleDocument } from "@shared/desktop-api";
import { documentIdentity, sameDocumentIdentity } from "@tarp/module/document-path";
import { nodeOptions, type CreationFlow, type FlowNode, type PreludeFlow } from "@tarp/module/flow";
import { ArrowRight, BookOpen } from "lucide-react";

import { DocumentReference } from "./DocumentReferences";

const stepLabels: Record<FlowNode["type"], string> = {
  introduction: "介绍",
  shortText: "短文本",
  longText: "长文本",
  number: "数字",
  choice: "单选",
  multiChoice: "多选",
};

export function documentTitle(
  documents: readonly Pick<ModuleDocument, "path" | "title">[],
  path: string,
): string {
  const document = documents.find((item) => sameDocumentIdentity(item.path, path));
  return document?.title ?? documentIdentity(path);
}

function resolveNext(
  flow: PreludeFlow,
  index: number,
  next: string | undefined,
): FlowNode | undefined {
  const target = next ?? flow.steps[index + 1]?.id;
  if (!target || target === "$end") return undefined;
  return flow.steps.find((step) => step.id === target);
}

function StepNote({ node }: { readonly node: FlowNode }) {
  if (node.type === "shortText" || node.type === "longText" || node.type === "number")
    return node.required ? null : (
      <p className="text-muted-foreground mt-3 text-xs leading-5">这一步可以先跳过。</p>
    );
  return null;
}

function StepChoices({
  flow,
  node,
  index,
  documents,
}: {
  readonly flow: PreludeFlow;
  readonly node: FlowNode;
  readonly index: number;
  readonly documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[];
}) {
  if (!["choice", "multiChoice"].includes(node.type)) return null;
  const options = nodeOptions(node, documents);
  const destinations = new Set(
    options.map((option) => option.next ?? node.next ?? flow.steps[index + 1]?.id ?? "$end"),
  );
  const branched = node.type === "choice" && destinations.size > 1;
  return (
    <div className="mt-4 space-y-2">
      {node.optionTypeId ? (
        <p className="text-muted-foreground text-xs">从已有的「{node.optionTypeId}」里选。</p>
      ) : null}
      {node.type === "multiChoice" ? (
        <p className="text-muted-foreground text-xs">可以多选。</p>
      ) : null}
      <ul className="border-border/60 divide-border/60 divide-y rounded-lg border">
        {options.map((option) => {
          const next = resolveNext(flow, index, option.next ?? node.next);
          return (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5 text-sm leading-5"
              key={option.id}
            >
              {node.optionTypeId ? (
                <DocumentReference value={option.id}>{option.label}</DocumentReference>
              ) : (
                <span className="min-w-0 break-words">{option.label}</span>
              )}
              {branched ? (
                <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs leading-5">
                  <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                  {next ? next.title : "结束流程"}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FlowEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="border-border bg-card/40 rounded-2xl border border-dashed px-6 py-16 text-center">
      <BookOpen className="text-muted-foreground mx-auto size-8" strokeWidth={1.5} />
      <p className="mt-4 text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-6">{description}</p>
    </div>
  );
}

export function FlowOutline({
  flow,
  documents,
}: {
  readonly flow?: CreationFlow | PreludeFlow;
  readonly documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[];
}) {
  if (flow && "workbench" in flow)
    return (
      <ol className="divide-border border-border divide-y rounded-xl border">
        {flow.workbench.stages.map((stage, index) => (
          <li key={stage.id} className="space-y-3 p-5">
            <h2 className="font-medium">
              {index + 1}. {stage.title}
            </h2>
            <ul className="text-muted-foreground space-y-2 text-sm">
              {stage.tasks.map((task) => (
                <li key={task.id}>
                  {task.title}
                  {task.optionTypeId
                    ? ` · 引用「${task.optionTypeId}」文档`
                    : task.kind === "document"
                      ? " · 按所选文档展开规则"
                      : task.kind === "roll" || task.kind === "table"
                        ? " · 一键生成并自动记录"
                        : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    );
  if (!flow || !("steps" in flow) || !flow.steps.length) return null;
  return (
    <ol className="border-border bg-card divide-border/60 divide-y rounded-xl border">
      {flow.steps.map((node, index) => (
        <li className="flex gap-3 p-4 sm:gap-4 sm:p-5" key={node.id}>
          <span
            className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-medium tabular-nums"
            aria-hidden="true"
          >
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-sm leading-6 font-medium">{node.title}</h2>
              <span className="text-muted-foreground text-xs">{stepLabels[node.type]}</span>
            </div>
            {node.body ? (
              <p className="text-foreground/90 mt-2 text-sm leading-7 break-words whitespace-pre-wrap">
                {node.body}
              </p>
            ) : null}
            <StepChoices flow={flow} node={node} index={index} documents={documents} />
            <StepNote node={node} />
          </div>
        </li>
      ))}
    </ol>
  );
}
