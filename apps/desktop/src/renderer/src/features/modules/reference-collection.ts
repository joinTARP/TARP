import { documentIdentity } from "@tarp/module/document-path";
import type { DocumentField } from "@tarp/module/document-type";
import { shouldHideEmptyField } from "@tarp/module/public-document-field";
import type { ReferenceCollectionLayout } from "@tarp/module/reference-collection";

import type { ReferenceDocument } from "./DocumentReferences";

export interface ReferenceCollectionRow {
  key: string;
  reference?: string;
  title: string;
  image?: string;
  path?: string;
  unavailable: boolean;
  category?: string;
  quantity?: number;
  metadata: { key: string; label: string; text: string }[];
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

export function buildReferenceCollectionRows(
  value: unknown,
  field: DocumentField,
  config: ReferenceCollectionLayout,
  documents?: ReadonlyMap<string, ReferenceDocument>,
  respectVisibility = true,
): ReferenceCollectionRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const object =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    const raw = config.referenceField ? object?.[config.referenceField] : entry;
    const reference = typeof raw === "string" && raw.trim() ? raw : undefined;
    const document = reference ? documents?.get(documentIdentity(reference)) : undefined;
    if (respectVisibility && document?.visible === false) return [];
    const quantity = config.quantityField ? object?.[config.quantityField] : undefined;
    const metadata = config.metadata.flatMap(({ field: key, label }) => {
      const value = object?.[key];
      const text = value === null || value === "" ? "暂无数据" : scalarText(value);
      const definition = field.item?.fields?.find((child) => child.key === key);
      return text === undefined ||
        !definition ||
        definition.visibility !== "public" ||
        shouldHideEmptyField(definition, object?.[key])
        ? []
        : [{ key, label: label ?? definition.label, text }];
    });
    const instance = object?.$instance as
      | { display?: { key: string; label: string; value: unknown; hideWhenEmpty?: boolean }[] }
      | undefined;
    for (const entry of instance?.display ?? []) {
      if (shouldHideEmptyField(entry, entry.value)) continue;
      const text = scalarText(entry.value);
      if (text !== undefined)
        metadata.push({ key: `instance.${entry.key}`, label: entry.label, text });
      else if (!entry.hideWhenEmpty)
        metadata.push({ key: `instance.${entry.key}`, label: entry.label, text: "暂无数据" });
    }
    return [
      {
        // 同一引用可出现多次，索引保证每个列表项都有稳定的渲染键。
        key: `${typeof object?.id === "string" ? object.id : (reference ?? "missing")}-${index}`,
        reference,
        title: document?.title ?? reference?.split("/").at(-1) ?? "未指定引用",
        image: document?.valid === false ? undefined : document?.image,
        path: document?.path,
        unavailable: !document || document.valid === false,
        category: config.filterField ? scalarText(object?.[config.filterField]) : undefined,
        quantity:
          typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0
            ? quantity
            : undefined,
        metadata,
      },
    ];
  });
}

export function filterReferenceCollectionRows(
  rows: readonly ReferenceCollectionRow[],
  query: string,
  category?: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!category || row.category === category) &&
      (!needle ||
        [row.title, ...row.metadata.map((entry) => entry.text)].some((text) =>
          text.toLocaleLowerCase().includes(needle),
        )),
  );
}
