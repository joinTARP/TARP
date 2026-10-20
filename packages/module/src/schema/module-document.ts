import type { DisplayProjection } from "./display-fields";
import type { DocumentComputations } from "./document-computations";
import type { DocumentContentType, DocumentType } from "./document-type";
import type { ModuleMetadataFile } from "./module-metadata";

export interface ModulePageDocument {
  readonly path: string;
  readonly title: string;
  readonly body?: string;
  readonly error?: string;
}

export interface ModuleDocument extends DisplayProjection {
  readonly id?: string;
  readonly revision?: number;
  readonly path: string;
  readonly title: string;
  readonly docType?: string;
  readonly contentType?: DocumentContentType;
  readonly description?: string;
  readonly image?: string;
  readonly avatar?: string;
  readonly valid: boolean;
  /** 原始索引尚未求值；计算投影明确提供整份文档的可见性。 */
  readonly visible?: boolean;
  readonly error?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  /** 本次计算的字段错误，以字段路径索引，不进入源数据或存档。 */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** 原始加载与同步模型：公式配置独立于业务 values，计算投影使用 ModuleDocument。 */
export interface RawModuleDocument extends ModuleDocument {
  readonly computed?: DocumentComputations;
}

/** 玩家展示使用定位外壳，内部索引与主持读取仍保留完整计算资料。 */
export function visibleDocumentProjection(document: ModuleDocument): ModuleDocument {
  if (document.visible !== false) return document;
  return {
    id: document.id,
    revision: document.revision,
    path: document.path,
    docType: document.docType,
    contentType: document.contentType,
    title: "未公开资料",
    valid: document.valid,
    visible: false,
  };
}

/** 有显示条件时必须确认本版为 true；没有条件时沿用普通资料的加载占位。 */
export function isDocumentVisible(
  document: Pick<ModuleDocument, "visible">,
  type?: Pick<DocumentType, "displayWhen">,
): boolean {
  return type?.displayWhen === undefined ? document.visible !== false : document.visible === true;
}

export interface ModuleMetadata extends Omit<ModuleMetadataFile, "description"> {
  readonly description?: string;
}
