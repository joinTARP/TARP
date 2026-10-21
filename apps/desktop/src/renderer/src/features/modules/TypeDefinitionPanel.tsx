import { typeFormatLabel } from "@jointarp/module/document-path";
import {
  defaultDocumentCard,
  defaultDocumentHover,
  defaultDocumentReference,
  type DocumentLayoutSection,
  type DocumentType,
} from "@jointarp/module/document-type";
import { imageAspectRatio } from "@jointarp/module/image-aspect";
import type { ModuleDocument } from "@shared/desktop-api";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { buttonVariants } from "../../components/ui/button";

function fieldHint(field: DocumentType["fields"][number]): string {
  if (field.type === "enum" && field.options) return field.options.join(" / ");
  if (field.type === "reference" && field.targets) return `引用 ${field.targets.join("、")}`;
  if (field.type === "list" && field.item) return `列表 · ${field.item.type}`;
  if (field.type === "object" && field.fields) return `对象 · ${field.fields.length} 项`;
  return field.type;
}

const layoutSectionLabels: Record<DocumentLayoutSection, string> = {
  fields: "字段",
  description: "简介",
  body: "正文",
};

export function TypeDefinitionPanel({
  documentType,
  modulePath,
  documents = [],
}: {
  readonly documentType: DocumentType;
  readonly modulePath?: string;
  readonly documents?: readonly ModuleDocument[];
}) {
  const format = typeFormatLabel(documentType.id, documents);
  const layout = documentType.layout;
  const card = layout?.card ?? defaultDocumentCard;
  const hover = layout?.hover ?? defaultDocumentHover;
  const reference = layout?.reference ?? defaultDocumentReference;
  const creationSteps = documentType.creationFlow?.workbench.stages.length ?? 0;
  return (
    <div className="space-y-12">
      {documentType.designation === "character" ? (
        <div className="border-border bg-card rounded-xl border p-4 text-sm">
          <p className="font-medium">角色类型</p>
          <p className="text-muted-foreground mt-2 leading-6">
            开局后作为独立角色保存，可用于选角或创建玩家角色。每位玩家在本局只能绑定一个角色。
          </p>
          <p className="text-muted-foreground mt-3 text-xs leading-5">
            {creationSteps > 0 ? "创建时按模组规则分阶段完成。" : "此类型未配置建卡工作台。"}
          </p>
          {modulePath && creationSteps > 0 ? (
            <Link
              data-ui-control
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mt-3 -ml-2")}
              to="/module"
              search={{ path: modulePath, page: "creation", define: documentType.id }}
              replace
            >
              查看创建流程
            </Link>
          ) : null}
        </div>
      ) : null}
      <section aria-labelledby="type-display-heading">
        <h2 id="type-display-heading" className="text-base font-semibold">
          展示
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          分别配置详情、列表卡片、行内引用和悬浮预览，不改字段本身。
        </p>
        {documentType.displayWhen !== undefined ? (
          <div className="border-border bg-card mt-5 rounded-xl border p-4 text-sm">
            <p className="font-medium">文档显示条件</p>
            <pre className="text-muted-foreground mt-2 overflow-x-auto text-xs">
              <code>{documentType.displayWhen}</code>
            </pre>
          </div>
        ) : null}
        <div className="border-border bg-card mt-5 rounded-xl border p-4 text-sm">
          {layout ? (
            <dl className="space-y-3">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">布局</dt>
                <dd>
                  {layout.type === "handlebars"
                    ? "Handlebars 模板"
                    : layout.type === "split"
                      ? `左右双栏 · 左栏 ${layout.columns} 列属性`
                      : `${layout.columns} 列网格`}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">字段区</dt>
                <dd>{layout.fields.join("、")}</dd>
              </div>
              {layout.type === "split" ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">详情图片比例</dt>
                  <dd>{imageAspectRatio(layout.imageAspect).replace(" / ", ":")}</dd>
                </div>
              ) : null}
              {layout.type === "split" ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">右栏字段</dt>
                  <dd>{layout.contentFields.join("、") || "无"}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">顺序</dt>
                <dd>{layout.order.map((section) => layoutSectionLabels[section]).join(" → ")}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">正文来源</dt>
                <dd>公共 body</dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">还没有布局文件，字段会按声明顺序展开。</p>
          )}
        </div>
        <dl className="border-border bg-card mt-3 space-y-3 rounded-xl border p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">列表卡片</dt>
            <dd>
              {card.content
                ? "Handlebars 模板"
                : card.image === "cover"
                  ? `封面 ${imageAspectRatio(card.imageAspect).replace(" / ", ":")}`
                  : "无图"}{" "}
              {!card.content ? ` · 简介 ${card.descriptionLines} 行` : ""}
              {!card.content && card.fields.length ? ` · ${card.fields.join("、")}` : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">行内引用</dt>
            <dd>{reference.style === "badge" ? "标签" : "链接"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">悬浮预览</dt>
            <dd>
              {hover.enabled
                ? hover.content
                  ? `${hover.width} · Handlebars 模板`
                  : `${hover.width} · ${hover.columns} 列 · 简介 ${hover.descriptionLines} 行${hover.image !== "none" ? ` · 图片 ${imageAspectRatio(hover.imageAspect).replace(" / ", ":")}` : ""}`
                : "关闭"}
            </dd>
          </div>
          {hover.enabled && !hover.content ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">预览字段</dt>
              <dd>{hover.fields.join("、") || "仅元数据"}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <section aria-labelledby="type-fields-heading">
        <h2 id="type-fields-heading" className="text-base font-semibold">
          字段
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {format ? `${format} 文档` : "文档"}会带上这些字段。
        </p>
        {documentType.fields.length === 0 ? (
          <p className="text-muted-foreground mt-5 text-sm">还没有字段定义。</p>
        ) : (
          <div className="border-border bg-card mt-5 divide-y rounded-xl border">
            {documentType.fields.map((field) => (
              <div className="flex items-baseline justify-between gap-4 px-4 py-3" key={field.key}>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{field.label}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">{fieldHint(field)}</p>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {field.required ? "必填" : "可选"}
                  {field.hideWhenEmpty ? " · 空值隐藏" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
