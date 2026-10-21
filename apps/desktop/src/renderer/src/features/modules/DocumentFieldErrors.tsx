import type { DocumentType } from "@tarp/module/document-type";
import { getDocumentField } from "@tarp/module/public-document-field";

import { FieldCalculationError } from "./FieldCalculationError";

const metadataLabels: Readonly<Record<string, string>> = {
  name: "名称",
  description: "简介",
  image: "图片",
  avatar: "头像",
  body: "正文",
};

export function DocumentFieldErrors({
  errors,
  documentType,
  shownPaths = [],
  metadataOnly = false,
}: {
  readonly errors?: Readonly<Record<string, string>>;
  readonly documentType?: DocumentType;
  readonly shownPaths?: readonly string[];
  readonly metadataOnly?: boolean;
}) {
  const entries = Object.entries(errors ?? {}).filter(
    ([path]) =>
      (!metadataOnly || Object.hasOwn(metadataLabels, path)) &&
      !shownPaths.some(
        (shown) =>
          path === shown ||
          path.startsWith(`${shown}.`) ||
          path.startsWith(`${shown}[`) ||
          shown.startsWith(`${path}.`) ||
          shown.startsWith(`${path}[`),
      ),
  );
  if (!entries.length) return null;
  return (
    <div className="space-y-2">
      {entries.map(([path, error]) => {
        const definition = getDocumentField(
          documentType?.fields ?? [],
          path.replace(/\[\d+\]/g, ""),
        );
        const label =
          (Object.hasOwn(metadataLabels, path) ? metadataLabels[path] : undefined) ??
          definition?.label ??
          "字段";
        return (
          <div key={path}>
            <p className="text-muted-foreground text-xs">{label}</p>
            <FieldCalculationError error={error} />
          </div>
        );
      })}
    </div>
  );
}
