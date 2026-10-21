import type { DocumentType } from "@jointarp/module/document-type";
import type {
  ModuleDocument,
  ModuleMetadata,
  ModulePageDocument,
} from "@jointarp/module/module-document";

export type {
  ModuleDocument,
  ModuleMetadata,
  ModulePageDocument,
} from "@jointarp/module/module-document";

export interface ModuleSummary {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly cover?: string;
  readonly system?: string;
  readonly author?: string;
  readonly version?: string;
  readonly tags?: readonly string[];
  readonly error?: string;
}

export type ListModulesResult =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "success";
      readonly directory: string;
      readonly modules: readonly ModuleSummary[];
    };

export interface ModulesDirectory {
  readonly path: string;
  readonly defaultPath: string;
}

export type OpenModuleLibraryResult =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "success";
      readonly path: string;
      readonly metadata: ModuleMetadata;
      readonly documentTypes: readonly DocumentType[];
      readonly documents: readonly ModuleDocument[];
      readonly pages: readonly ModulePageDocument[];
    };
