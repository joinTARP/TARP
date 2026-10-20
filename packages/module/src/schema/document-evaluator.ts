import {
  evaluateComputedFields,
  type ComputedDocumentInput,
  type ExpressionCompiler,
} from "./computed-fields";
import { evaluateDisplayFields } from "./display-fields";
import { resolveDocumentComputations, type DocumentData } from "./document-computations";
import { documentIdentity } from "./document-path";
import {
  collectReferences,
  DocumentReferenceGraph,
  type DocumentReferenceIndex,
  type DeclaredReferences,
} from "./document-references";
import { documentMetadataKeys, isDocumentMetadataKey, type DocumentType } from "./document-type";
import { hasInstanceBindings } from "./instance-state";
import type { ModuleDocument } from "./module-document";
import { publicFieldErrors } from "./public-document-field";

export { collectReferences } from "./document-references";

/** 每个根文档使用独立编译环境；不得跨文档保留公式的全局状态。 */
export interface DocumentComputationCompiler {
  expression: ExpressionCompiler;
  display: (expression: string) => unknown;
}

/** 已完成文件解析和 Zod 校验、等待解析引用与计算字段的文档。 */
export interface ParsedModuleDocument extends DocumentData {
  readonly identity: string;
  readonly documentType: DocumentType;
  readonly document: ModuleDocument;
}

/** 将传输结构中的展示元数据还原为原始字段，供 $raw 与字段计算共同读取。 */
function documentValues(item: ParsedModuleDocument): Record<string, unknown> {
  const source: Record<string, unknown> = {
    name: item.document.title,
    description: item.document.description,
    image: item.document.image,
    avatar: item.document.avatar,
    body: item.document.body,
  };
  for (const key of documentMetadataKeys) {
    if (source[key] === undefined) delete source[key];
  }
  return { ...source, ...structuredClone(item.values) };
}

async function resolveDocument(
  item: ParsedModuleDocument,
  byIdentity: ReadonlyMap<string, ParsedModuleDocument>,
  view: "source" | "public" | "name" | "library",
  strictComputations = view === "source",
  references: DocumentReferenceIndex = new Map(),
  rootReferences?: DeclaredReferences,
  createCompiler?: () => DocumentComputationCompiler,
): Promise<ModuleDocument> {
  const documentType = resolveDocumentComputations(item.documentType, item.computed);
  const nameOnly = (title: string, visible = true): ModuleDocument => ({
    path: item.document.path,
    title,
    visible,
    docType: item.document.docType,
    valid: item.document.valid,
  });
  if (
    view === "name" &&
    item.documentType.displayWhen === undefined &&
    !documentType.fields.some((field) => field.key === "name" && field.compute !== undefined)
  )
    return nameOnly(
      item.documentType.fields.some(
        (field) => field.key === "name" && field.visibility !== "public",
      )
        ? "未公开资料"
        : item.document.title,
    );
  const inputs = new Map<ParsedModuleDocument, ComputedDocumentInput>();
  const declaredReferences = new Map<ComputedDocumentInput, DeclaredReferences>();
  const inputFor = (record: ParsedModuleDocument): ComputedDocumentInput => {
    let input = inputs.get(record);
    if (!input) {
      input = {
        identity: record.document.path,
        documentType:
          record === item
            ? documentType
            : resolveDocumentComputations(record.documentType, record.computed),
        values: documentValues(record),
      };
      inputs.set(record, input);
      declaredReferences.set(
        input,
        (record === item ? rootReferences : undefined) ??
          references.get(record.identity) ??
          new Map(),
      );
    }
    return input;
  };
  try {
    const compiler = createCompiler?.();
    const input = inputFor(item);
    const raw = input.values;
    const result = await evaluateComputedFields(
      input,
      (owner, reference) => {
        const targets = declaredReferences.get(owner)?.get(documentIdentity(reference));
        const target = byIdentity.get(documentIdentity(reference));
        return target && targets?.has(target.documentType.id) ? inputFor(target) : null;
      },
      {
        selectedKeys: view === "name" ? ["name"] : undefined,
        strict: strictComputations,
        checkVisibility: view !== "library",
        compiler: compiler?.expression,
      },
    );
    const evaluated = result.values;
    const visible = result.visible;
    const fieldErrors =
      view === "public" || view === "name"
        ? publicFieldErrors(documentType.fields, result.fieldErrors)
        : result.fieldErrors;
    const metadataValue = (key: string): string | undefined => {
      const field = item.documentType.fields.find((field) => field.key === key);
      if (view !== "library" && field && field.visibility !== "public") return undefined;
      const value = view === "library" && Object.hasOwn(raw, key) ? raw[key] : evaluated[key];
      return typeof value === "string" ? value : undefined;
    };
    const title = metadataValue("name") ?? "未公开资料";
    if (view === "name")
      return { ...nameOnly(title, visible), ...(fieldErrors ? { fieldErrors } : {}) };
    const declared = new Set(item.documentType.fields.map((field) => field.key));
    const values = Object.fromEntries(
      Object.entries(view === "library" ? { ...evaluated, ...raw } : evaluated).filter(
        ([key]) => !isDocumentMetadataKey(key) || declared.has(key),
      ),
    );
    if (view === "source") {
      if (strictComputations) {
        const presentation = await evaluateDisplayFields(
          documentType,
          {
            ...item.document,
            values: evaluated,
            visible,
            fieldErrors: result.fieldErrors,
          },
          compiler?.display,
        );
        if (presentation.displayErrors)
          throw new Error(
            Object.entries(presentation.displayErrors)
              .map(([key, error]) => `$display.${key}：${error}`)
              .join("；"),
          );
      }
      return { ...item.document, values, visible, ...(fieldErrors ? { fieldErrors } : {}) };
    }
    const document: ModuleDocument = {
      ...item.document,
      title,
      visible,
      description: metadataValue("description"),
      image: metadataValue("image"),
      avatar: metadataValue("avatar"),
      body: metadataValue("body"),
      values,
      ...(fieldErrors ? { fieldErrors } : {}),
    };
    return {
      ...document,
      ...(await evaluateDisplayFields(
        documentType,
        {
          ...document,
          values: evaluated,
          fieldErrors: result.fieldErrors,
        },
        compiler?.display,
      )),
    };
  } catch (error) {
    return {
      ...item.document,
      ...(view === "library"
        ? { values: structuredClone(item.values), visible: true }
        : { valid: false, visible: item.documentType.displayWhen === undefined }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 批量入口用于模组校验；实际游戏读取使用 DocumentEvaluator 的目标入口。 */
export async function resolveModuleDocuments(
  items: readonly (ParsedModuleDocument | ModuleDocument)[],
  options: {
    view?: "source" | "public" | "library";
    identities?: ReadonlySet<string>;
    strictComputations?: boolean;
  } = {},
): Promise<readonly ModuleDocument[]> {
  const records = items.filter((item): item is ParsedModuleDocument => "identity" in item);
  const byIdentity = new Map(records.map((record) => [record.identity, record]));
  const references = new Map(
    records.map((record) => [
      record.identity,
      collectReferences(
        record.documentType.fields,
        record.values,
        (reference) => byIdentity.get(documentIdentity(reference)) ?? null,
      ),
    ]),
  );
  return Promise.all(
    items.map((item) => {
      if (!("identity" in item)) return item;
      if (options.identities && !options.identities.has(item.identity)) return item.document;
      return resolveDocument(
        item,
        byIdentity,
        options.view ?? "public",
        options.strictComputations,
        references,
      );
    }),
  );
}

/** 按需求值；声明引用图在输入变化时更新，只使受影响文档的计算缓存失效。 */
export class DocumentEvaluator {
  constructor(private readonly createCompiler?: () => DocumentComputationCompiler) {}
  private revision = -1;
  private graph = new DocumentReferenceGraph();
  private records: ReadonlyMap<string, ParsedModuleDocument> = new Map();
  private documents: ReadonlyMap<string, ModuleDocument> = new Map();
  private pending = new Map<string, Promise<ModuleDocument>>();
  private names = new Map<string, Promise<ModuleDocument>>();
  private temporary = new Map<string, Promise<ModuleDocument>>();

  get documentRevision(): number {
    return this.revision;
  }

  setSnapshot(
    revision: number,
    items: readonly (ParsedModuleDocument | ModuleDocument)[],
    references?: DocumentReferenceIndex,
  ): void {
    const records = new Map<string, ParsedModuleDocument>();
    const documents = new Map<string, ModuleDocument>();
    for (const item of items) {
      const document = "identity" in item ? item.document : item;
      documents.set(documentIdentity(document.path), document);
      if ("identity" in item) records.set(item.identity, item);
    }
    this.graph = new DocumentReferenceGraph();
    for (const record of records.values()) {
      this.graph.set(
        record.identity,
        references?.get(record.identity) ??
          collectReferences(
            record.documentType.fields,
            record.values,
            (reference) => records.get(documentIdentity(reference)) ?? null,
          ),
      );
    }
    for (const record of records.values()) {
      if (hasInstanceBindings(record.documentType.fields))
        this.graph.set(
          record.identity,
          collectReferences(
            record.documentType.fields,
            record.values,
            (reference) => records.get(documentIdentity(reference)) ?? null,
          ),
        );
    }
    this.revision = revision;
    this.records = records;
    this.documents = documents;
    this.pending.clear();
    this.temporary.clear();
    this.names.clear();
  }

  updateSnapshot(
    revision: number,
    items: readonly (ParsedModuleDocument | ModuleDocument)[],
    removedPaths: readonly string[] = [],
    references?: DocumentReferenceIndex,
  ): void {
    const changed = new Set([
      ...removedPaths.map(documentIdentity),
      ...items.map((item) => documentIdentity("identity" in item ? item.document.path : item.path)),
    ]);
    const affected = this.graph.affected(changed);
    const records = new Map(this.records);
    const documents = new Map(this.documents);
    for (const path of removedPaths) {
      const identity = documentIdentity(path);
      records.delete(identity);
      documents.delete(identity);
      this.graph.remove(identity);
    }
    for (const item of items) {
      const document = "identity" in item ? item.document : item;
      const identity = documentIdentity(document.path);
      documents.set(identity, document);
      if ("identity" in item) {
        records.set(identity, item);
        this.graph.set(
          identity,
          references?.get(identity) ?? collectReferences(item.documentType.fields, item.values),
        );
      } else {
        records.delete(identity);
        this.graph.remove(identity);
      }
    }
    for (const record of records.values()) {
      if (hasInstanceBindings(record.documentType.fields))
        this.graph.set(
          record.identity,
          collectReferences(
            record.documentType.fields,
            record.values,
            (reference) => records.get(documentIdentity(reference)) ?? null,
          ),
        );
    }
    this.revision = revision;
    this.records = records;
    this.documents = documents;
    for (const identity of this.graph.affected(changed)) affected.add(identity);
    for (const identity of affected) {
      this.pending.delete(identity);
      this.names.delete(identity);
    }
    // 草稿不加入真实图，输入版本变化时统一清理。
    this.temporary.clear();
  }

  /** 草稿仅作为计算目标，不加入真实文档或引用索引。 */
  evaluateDocument(item: ParsedModuleDocument): Promise<ModuleDocument> {
    const key = JSON.stringify(item);
    const previous = this.temporary.get(key);
    if (previous) return previous;
    const pending = resolveDocument(
      item,
      this.records,
      "public",
      false,
      this.graph.index,
      collectReferences(
        item.documentType.fields,
        item.values,
        (reference) => this.records.get(documentIdentity(reference)) ?? null,
      ),
      this.createCompiler,
    );
    this.temporary.set(key, pending);
    // 连续编辑不会推进文档版本，不能无限保留每次编辑的输入和结果。
    if (this.temporary.size > 128) this.temporary.delete(this.temporary.keys().next().value!);
    return pending;
  }

  /** NPC 名称定位只计算公开名称，不执行图片或正文元数据。 */
  readDocumentName(path: string): Promise<ModuleDocument> {
    const identity = documentIdentity(path);
    const previous = this.pending.get(identity) ?? this.names.get(identity);
    if (previous) return previous;
    const document = this.documents.get(identity);
    if (!document) return Promise.reject(new Error(`文档不存在：${path}`));
    const record = this.records.get(identity);
    const pending = record
      ? resolveDocument(
          record,
          this.records,
          "name",
          false,
          this.graph.index,
          undefined,
          this.createCompiler,
        )
      : Promise.resolve(document);
    this.names.set(identity, pending);
    return pending;
  }

  readDocument(path: string): Promise<ModuleDocument> {
    const identity = documentIdentity(path);
    const previous = this.pending.get(identity);
    if (previous) return previous;
    const document = this.documents.get(identity);
    if (!document) return Promise.reject(new Error(`文档不存在：${path}`));
    const record = this.records.get(identity);
    const pending = record
      ? resolveDocument(
          record,
          this.records,
          "public",
          false,
          this.graph.index,
          undefined,
          this.createCompiler,
        )
      : Promise.resolve(document);
    this.pending.set(identity, pending);
    return pending;
  }
}
