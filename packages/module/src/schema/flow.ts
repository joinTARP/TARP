import { z } from "zod";

import { workbenchSchema, validateWorkbench } from "./creation-workbench";
import { documentIdentity, sameDocumentIdentity } from "./document-path";
import type { DocumentType } from "./document-type";
import type { ModuleDocument } from "./module-document";
import { parseNarrative } from "./narrative";

export const flowId = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v), "不能使用保留名称");
export const flowNodeTypes = [
  "introduction",
  "shortText",
  "longText",
  "number",
  "choice",
  "multiChoice",
] as const;
export const flowNodeSchema = z
  .object({
    id: flowId,
    type: z.enum(flowNodeTypes),
    title: z.string().trim().min(1).max(120),
    body: z.string().max(10000).default(""),
    required: z.boolean().default(true),
    next: z.string().optional(),
    options: z
      .array(
        z
          .object({
            id: flowId,
            label: z.string().min(1),
            value: z.union([z.string(), z.number()]),
            next: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    optionTypeId: z.string().optional(),
    optionRoutes: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export const preludeFlowSchema = z
  .object({ steps: z.array(flowNodeSchema).max(100).default([]) })
  .strict();
export const creationFlowSchema = z.object({ workbench: workbenchSchema }).strict();
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type PreludeFlow = z.infer<typeof preludeFlowSchema>;
export type CreationFlow = z.infer<typeof creationFlowSchema>;
export const beatSchema = z.object({ text: z.string().trim().min(1).max(10000) }).strict();
export const gameStartSchema = z
  .object({
    id: flowId,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    characterTypeIds: z.array(z.string().min(1)).min(1),
    playablePaths: z.array(z.string()).default([]),
    /** 模组作者为可玩角色预设的 AI 扮演指令，按文档身份匹配。 */
    aiCompanions: z.record(z.string().min(1), z.string().trim().min(1).max(8000)).optional(),
    allowCreate: z.boolean().default(true),
    opening: z
      .object({
        mode: z.enum(["scripted", "ai"]),
        beats: z.array(beatSchema).max(100).default([]),
        prompt: z.string().max(10000).default(""),
        overrides: z.record(z.string(), z.array(beatSchema).min(1).max(100)).default({}),
        instructions: z.string().max(10000).default(""),
      })
      .strict(),
  })
  .strict();
export type GameStart = z.infer<typeof gameStartSchema>;
export const launchConfigSchema = z
  .object({
    preludeFlow: preludeFlowSchema.optional(),
    gameStarts: z.array(gameStartSchema).min(1).max(30),
  })
  .strict();
export type LaunchConfig = z.infer<typeof launchConfigSchema>;
export type FlowAnswer = string | number | string[];
export const flowAnswerSchema = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.array(z.string()).max(100),
]);
export const flowRunSchema = z.strictObject({
  path: z.array(z.string()),
  answers: z.record(z.string(), flowAnswerSchema),
  done: z.boolean(),
});
export type FlowRun = z.infer<typeof flowRunSchema>;
export const emptyFlowRun = (): FlowRun => ({ path: [], answers: {}, done: false });
export function currentNode(flow: PreludeFlow, run: FlowRun): FlowNode | undefined {
  return run.done ? undefined : (flow.steps.find((s) => s.id === run.path.at(-1)) ?? flow.steps[0]);
}
function followingId(flow: PreludeFlow, node: FlowNode): string | undefined {
  const next = node.next ?? flow.steps[flow.steps.indexOf(node) + 1]?.id;
  return next && next !== "$end" ? next : undefined;
}
/** 从当前介绍步向后连读，直到提问或流程结束。 */
export function preludeNarration(flow: PreludeFlow, run: FlowRun): FlowNode[] {
  const current = currentNode(flow, run);
  if (!current || current.type !== "introduction") return [];
  const prior: FlowNode[] = [];
  const index = run.path.indexOf(current.id);
  const before = index >= 0 ? run.path.slice(0, index) : [];
  for (let i = before.length - 1; i >= 0; i--) {
    const id = before[i];
    const node = flow.steps.find((step) => step.id === id);
    if (!node || node.type !== "introduction") break;
    prior.unshift(node);
  }
  const ahead: FlowNode[] = [];
  const seen = new Set<string>();
  let node: FlowNode | undefined = current;
  while (node?.type === "introduction" && !seen.has(node.id)) {
    seen.add(node.id);
    ahead.push(node);
    const next = followingId(flow, node);
    node = next ? flow.steps.find((step) => step.id === next) : undefined;
  }
  return [...prior, ...ahead];
}
/** 一次听完当前这段介绍，停在其后的第一个非介绍步骤。 */
export function finishIntroductionRun(
  flow: PreludeFlow,
  run: FlowRun,
  documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[],
): FlowRun {
  if (currentNode(flow, run)?.type !== "introduction") return run;
  let next = advanceFlow(flow, run, undefined, documents);
  while (!next.done && currentNode(flow, next)?.type === "introduction")
    next = advanceFlow(flow, next, undefined, documents);
  return next;
}
export function nodeOptions(
  node: FlowNode,
  documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[],
) {
  return node.optionTypeId
    ? documents
        .filter((d) => d.docType === node.optionTypeId)
        .map((d) => ({
          id: d.path,
          label: d.title,
          value: documentIdentity(d.path),
          next: Object.entries(node.optionRoutes ?? {}).find(([path]) =>
            sameDocumentIdentity(path, d.path),
          )?.[1],
        }))
    : node.options;
}
export function validateFlow(flow: PreludeFlow, documents: readonly ModuleDocument[] = []) {
  const ids = flow.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("步骤 ID 重复");
  flow.steps.forEach((node, index) => {
    const targets =
      node.type === "choice"
        ? nodeOptions(node, documents).map((o) => o.next ?? node.next)
        : [node.next];
    if (node.type === "choice" && !node.required) targets.push(node.next);
    if (
      node.optionTypeId &&
      Object.keys(node.optionRoutes ?? {}).some(
        (path) =>
          !documents.some(
            (d) => sameDocumentIdentity(d.path, path) && d.docType === node.optionTypeId,
          ),
      )
    )
      throw new Error(`${node.title}：选项跳转引用了不存在的文档`);
    for (const target of targets)
      if (target && target !== "$end" && ids.indexOf(target) <= index)
        throw new Error(`${node.title}：只能跳转到后续存在的步骤`);
    if (node.optionTypeId && !documents.some((d) => d.docType === node.optionTypeId))
      throw new Error(`${node.title}：选项文档类型没有可用文档`);
    if (["choice", "multiChoice"].includes(node.type) && nodeOptions(node, documents).length < 1)
      throw new Error(`${node.title}：请添加选项`);
    if (new Set((node.options ?? []).map((o) => o.id)).size !== (node.options ?? []).length)
      throw new Error(`${node.title}：选项 ID 重复`);
    if (new Set((node.options ?? []).map((o) => o.value)).size !== (node.options ?? []).length)
      throw new Error(`${node.title}：选项保存值不能重复`);
    if (
      node.type === "multiChoice" &&
      (node.options ?? []).some((o) => typeof o.value !== "string")
    )
      throw new Error(`${node.title}：多选保存值必须是文本`);
  });
}
export function validateLaunch(
  config: LaunchConfig,
  types: readonly DocumentType[],
  documents: readonly ModuleDocument[],
) {
  if (new Set(config.gameStarts.map((s) => s.id)).size !== config.gameStarts.length)
    throw new Error("开局方案 ID 重复");
  if (config.preludeFlow) {
    validateFlow(config.preludeFlow, documents);
    for (const step of config.preludeFlow.steps)
      if (step.type === "introduction")
        validateNarration(step.body || step.title, documents, types, step.title);
  }
  for (const type of types)
    if (type.creationFlow) validateWorkbench(type.creationFlow.workbench, documents, type, types);
  for (const start of config.gameStarts) {
    validateNarration(start.description, documents, types, start.name);
    for (const id of start.characterTypeIds)
      if (!types.some((t) => t.id === id && t.designation === "character"))
        throw new Error(`${start.name}：角色类型无效`);
    for (const path of start.playablePaths)
      if (
        !documents.some(
          (d) =>
            sameDocumentIdentity(d.path, path) && start.characterTypeIds.includes(d.docType ?? ""),
        )
      )
        throw new Error(`${start.name}：预设角色不存在`);
    if (!start.allowCreate && !start.playablePaths.length)
      throw new Error(`${start.name}：没有可选或可创建角色`);
    const companionPaths = Object.keys(start.aiCompanions ?? {});
    for (const [index, path] of companionPaths.entries()) {
      if (!start.playablePaths.some((playable) => sameDocumentIdentity(playable, path)))
        throw new Error(`${start.name}：AI 队友必须来自可玩角色名单`);
      if (companionPaths.slice(0, index).some((other) => sameDocumentIdentity(other, path)))
        throw new Error(`${start.name}：AI 队友角色配置重复`);
    }
    if (
      start.allowCreate &&
      !types.some((type) => start.characterTypeIds.includes(type.id) && type.creationFlow)
    )
      throw new Error(`${start.name}：允许创建角色时至少需要一个建卡工作台`);
    if (start.opening.mode === "scripted" && !start.opening.beats.length)
      throw new Error(`${start.name}：请填写通用开场`);
    if (start.opening.mode === "ai" && !start.opening.prompt.trim())
      throw new Error(`${start.name}：请填写 AI 开场指令`);
    for (const path of Object.keys(start.opening.overrides))
      if (!start.playablePaths.some((playable) => sameDocumentIdentity(playable, path)))
        throw new Error(`${start.name}：专属开场角色不在可选名单`);
    for (const beat of [...start.opening.beats, ...Object.values(start.opening.overrides).flat()])
      validateNarration(beat.text, documents, types, start.name);
  }
}
/** 预写正文与 AI 使用相同说话人协议；配置阶段检查角色关联。 */
export function validateNarration(
  text: string,
  documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[],
  types: readonly DocumentType[],
  context: string,
) {
  for (const segment of parseNarrative(text, new Set(), new Set(), true))
    if (
      segment.kind === "npc" &&
      !documents.some(
        (document) =>
          sameDocumentIdentity(document.path, segment.path!) &&
          types.some((type) => type.id === document.docType && type.designation === "character"),
      )
    )
      throw new Error(`${context}：台词角色不存在或不是角色文档`);
}

export function validateAnswer(
  node: FlowNode,
  answer: FlowAnswer | undefined,
  documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[],
): void {
  if (node.type === "introduction") return;
  if (!node.required && (answer === undefined || answer === "")) return;
  if (["shortText", "longText"].includes(node.type)) {
    if (typeof answer !== "string" || !answer.trim()) throw new Error("请填写回答");
    return;
  }
  if (node.type === "number") {
    if (typeof answer !== "number" || !Number.isFinite(answer)) throw new Error("请填写有效数字");
    return;
  }
  const options = nodeOptions(node, documents);
  if (node.type === "choice") {
    if (!options.some((o) => o.value === answer)) throw new Error("请选择有效选项");
    return;
  }
  if (node.type === "multiChoice") {
    if (
      !Array.isArray(answer) ||
      (node.required && !answer.length) ||
      new Set(answer).size !== answer.length ||
      answer.some((a) => !options.some((o) => o.value === a))
    )
      throw new Error("多选结果无效");
    return;
  }
}
export function advanceFlow(
  flow: PreludeFlow,
  run: FlowRun,
  answer: FlowAnswer | undefined,
  documents: readonly Pick<ModuleDocument, "path" | "title" | "docType">[],
): FlowRun {
  const node = currentNode(flow, run);
  if (!node) return { ...run, done: true };
  validateAnswer(node, answer, documents);
  const path = run.path.length ? [...run.path] : [node.id];
  const answers = { ...run.answers };
  if (answer !== undefined) answers[node.id] = answer;
  const next =
    (node.type === "choice"
      ? nodeOptions(node, documents).find((o) => o.value === answer)?.next
      : undefined) ??
    node.next ??
    flow.steps[flow.steps.indexOf(node) + 1]?.id;
  return {
    path: next && next !== "$end" ? [...path, next] : path,
    answers,
    done: !next || next === "$end",
  };
}
export function backFlow(run: FlowRun): FlowRun {
  const path = [...run.path];
  if (!run.done && path.length > 1) path.pop();
  const answers = Object.fromEntries(
    Object.entries(run.answers).filter(([id]) => path.includes(id)),
  );
  return { path, answers, done: false };
}
