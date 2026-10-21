import { mkdir } from "node:fs/promises";

import { ORPCError } from "@orpc/server";
import type { ModulesDirectory, OpenModuleLibraryResult } from "@shared/desktop-api";
import { loadDocumentTypes } from "@tarp/module/node/document-types";
import { loadModuleLibraryDocuments } from "@tarp/module/node/module-documents";
import { loadModuleMetadata } from "@tarp/module/node/module-metadata";
import { loadModulePages } from "@tarp/module/node/module-pages";
import { z } from "zod";

import {
  assertAbsolutePath,
  readAppConfig,
  resolveDefaultModulesPath,
  resolveModulesPath,
  updateAppConfig,
} from "../config/app-config";
import { desktopProcedure as procedure } from "../desktop-rpc-context";
import { allowDocumentMediaRoots } from "../media-path";
import { documentsPath, showPathPicker } from "../native-dialog";
import { importGitModule } from "./import-git-module";
import { importLocalModule } from "./import-local-module";
import { listModules } from "./list-modules";

async function readModulesDirectory(configFilePath: string): Promise<ModulesDirectory> {
  const documentsDir = documentsPath();
  const config = await readAppConfig(configFilePath);
  return {
    path: resolveModulesPath(config, { documentsDir }),
    defaultPath: resolveDefaultModulesPath(documentsDir),
  };
}

async function persistModulesPath(configFilePath: string, path: string): Promise<ModulesDirectory> {
  const absolute = assertAbsolutePath(path);
  await mkdir(absolute, { recursive: true });
  await updateAppConfig(configFilePath, { modulesPath: absolute });
  return readModulesDirectory(configFilePath);
}

async function loadLibraryFromPath(path: string): Promise<OpenModuleLibraryResult> {
  try {
    const documentTypes = await loadDocumentTypes(path);
    allowDocumentMediaRoots(`module:${path}`, [path]);
    const metadata = await loadModuleMetadata(path);
    const documents = await loadModuleLibraryDocuments(path, documentTypes);
    const pages = await loadModulePages(path, metadata.pages);
    return { status: "success", path, metadata, documentTypes, documents, pages };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const moduleRouter = {
  importLocal: procedure
    .input(z.object({ kind: z.enum(["zip", "folder"]) }))
    .handler(async ({ context, input }) => {
      try {
        const selection = await showPathPicker({
          title: input.kind === "zip" ? "选择模组 ZIP 文件" : "选择模组文件夹",
          properties: [input.kind === "zip" ? "openFile" : "openDirectory"],
          ...(input.kind === "zip"
            ? { filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }] }
            : {}),
        });
        if (selection.canceled || !selection.filePaths[0]) return null;
        const directory = await readModulesDirectory(context.configFilePath);
        return await importLocalModule(directory.path, selection.filePaths[0], input.kind);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : "导入模组失败，请重试。",
        });
      }
    }),
  importGit: procedure
    .input(
      z.object({
        url: z.string().trim().min(1).max(2048),
        ref: z.string().trim().max(255).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const directory = await readModulesDirectory(context.configFilePath);
        return await importGitModule(directory.path, input);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message: error instanceof Error ? error.message : "导入模组失败，请重试。",
        });
      }
    }),
  getDirectory: procedure.handler(({ context }) => readModulesDirectory(context.configFilePath)),
  pickPath: procedure.handler(async ({ context }) => {
    try {
      const current = await readModulesDirectory(context.configFilePath);
      await mkdir(current.path, { recursive: true });
      const selection = await showPathPicker({
        title: "选择模组保存路径",
        defaultPath: current.path,
        properties: ["openDirectory", "createDirectory"],
      });
      if (selection.canceled || !selection.filePaths[0]) return { status: "cancelled" as const };
      const next = await persistModulesPath(context.configFilePath, selection.filePaths[0]);
      return { status: "success" as const, path: next.path };
    } catch (error) {
      return {
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }),
  resetPath: procedure.handler(({ context }) => {
    const defaultPath = resolveDefaultModulesPath(documentsPath());
    return persistModulesPath(context.configFilePath, defaultPath);
  }),
  list: procedure.handler(async ({ context }) => {
    try {
      const modules = await readModulesDirectory(context.configFilePath);
      return {
        status: "success" as const,
        directory: modules.path,
        modules: await listModules(modules.path),
      };
    } catch (error) {
      return {
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }),
  load: procedure.input(z.object({ path: z.string().min(1) })).handler(async ({ input }) => {
    try {
      return await loadLibraryFromPath(assertAbsolutePath(input.path));
    } catch (error) {
      return {
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }),
};
