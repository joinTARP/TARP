import { join } from "node:path";

import type { DocumentType } from "@jointarp/module/document-type";
import { launchConfigSchema, validateLaunch, type LaunchConfig } from "@jointarp/module/flow";
import type { RawModuleDocument } from "@jointarp/module/module-document";
import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { loadModuleDocuments } from "@jointarp/module/node/module-documents";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";

import type { SessionDatabase } from "../storage/session-database";
import { roomDirectoryForDatabase } from "./session-paths";

export interface FrozenModule {
  readonly types: readonly DocumentType[];
  readonly documents: readonly RawModuleDocument[];
  readonly launch?: LaunchConfig;
}

const modules = new WeakMap<SessionDatabase, FrozenModule>();
const cached = new Map<string, Promise<FrozenModule>>();
const connections = new Map<string, Set<SessionDatabase>>();

export function setFrozenModule(db: SessionDatabase, module: FrozenModule): void {
  if (!modules.has(db)) {
    const directory = roomDirectoryForDatabase(db);
    let owners = connections.get(directory);
    if (!owners) connections.set(directory, (owners = new Set()));
    owners.add(db);
    db.onClose(() => {
      modules.delete(db);
      owners.delete(db);
      if (!owners.size) connections.delete(directory);
    });
  }
  modules.set(db, module);
}

/** 发布新副本后同时更新已经打开的连接，避免继续使用旧类型定义。 */
export function refreshFrozenModule(directory: string, module: FrozenModule): void {
  cached.set(join(directory, "module"), Promise.resolve(module));
  for (const db of connections.get(directory) ?? []) modules.set(db, module);
}

export function frozenModule(db: SessionDatabase): FrozenModule {
  const module = modules.get(db);
  if (!module) throw new Error("数据库未关联房间模组副本");
  return module;
}

export function forgetFrozenModule(directory: string): void {
  cached.delete(directory);
}

export function loadFrozenModule(directory: string): Promise<FrozenModule> {
  let pending = cached.get(directory);
  if (!pending) {
    pending = (async () => {
      const metadata = await loadModuleMetadata(directory);
      const types = await loadDocumentTypes(directory);
      const documents = await loadModuleDocuments(directory, types, { raw: true });
      const launch = metadata.gameStarts
        ? launchConfigSchema.parse({
            preludeFlow: metadata.preludeFlow,
            gameStarts: metadata.gameStarts,
          })
        : undefined;
      if (launch) validateLaunch(launch, types, documents);
      return { types, documents, launch };
    })();
    cached.set(directory, pending);
    void pending.catch(() => {
      if (cached.get(directory) === pending) cached.delete(directory);
    });
  }
  return pending;
}
