import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import type { ModuleSummary } from "@shared/desktop-api";

import { allowDocumentMediaRoots } from "../media-path";
import { resolveModuleRoot } from "./module-root";

export async function listModules(directory: string): Promise<readonly ModuleSummary[]> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = (
    await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("."))
        .map(async (entry) => {
          if (entry.isDirectory()) return entry;
          if (!entry.isSymbolicLink()) return null;
          try {
            return (await stat(join(directory, entry.name))).isDirectory() ? entry : null;
          } catch {
            return null;
          }
        }),
    )
  )
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  return Promise.all(
    folders.map(async (entry): Promise<ModuleSummary> => {
      let path = join(directory, entry.name);
      try {
        path = await resolveModuleRoot(path);
        allowDocumentMediaRoots(`module:${path}`, [path]);
        const metadata = await loadModuleMetadata(path);
        return { path, ...metadata };
      } catch (error) {
        return {
          path,
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
