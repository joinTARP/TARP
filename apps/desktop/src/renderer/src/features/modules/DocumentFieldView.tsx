import type { DocumentFieldViewLayout } from "@tarp/module/document-field-view";
import type { DocumentField } from "@tarp/module/document-type";
import { fieldErrorAtPath, getDocumentField } from "@tarp/module/public-document-field";

import { DocumentValue } from "./DocumentValue";
import { EquipmentSlots } from "./EquipmentSlots";
import { FieldCalculationError } from "./FieldCalculationError";
import { FieldTable } from "./FieldTable";
import { ReferenceCollection } from "./ReferenceCollection";

export function DocumentFieldView({
  value,
  field,
  config,
  fieldErrors,
  path = field.key,
}: {
  readonly value: unknown;
  readonly field: DocumentField;
  readonly config: DocumentFieldViewLayout;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly path?: string;
}) {
  if (value === null || fieldErrorAtPath(fieldErrors, path))
    return <DocumentValue value={value} definition={field} fieldErrors={fieldErrors} path={path} />;
  if (config.type === "FieldTable")
    return (
      <FieldTable
        value={value}
        field={field}
        config={config}
        fieldErrors={fieldErrors}
        path={path}
      />
    );
  const content =
    config.type === "EquipmentSlots" ? (
      <EquipmentSlots value={value} config={config} label={field.label} />
    ) : (
      <ReferenceCollection value={value} field={field} config={config} />
    );
  const errors = Object.entries(fieldErrors ?? {}).filter(
    ([key]) => key.startsWith(`${path}.`) || key.startsWith(`${path}[`),
  );
  return (
    <>
      {content}
      {errors.map(([key, error]) => {
        const child = key
          .slice(path.length)
          .replace(/^\[\d+\]/, "")
          .replace(/^\./, "");
        const definition = getDocumentField(
          field.fields ?? field.item?.fields ?? [],
          child.replace(/\[\d+\]/g, ""),
        );
        const index = key.slice(path.length).match(/^\[(\d+)\]/)?.[1];
        return (
          <div key={key} className="mt-2">
            <p className="text-muted-foreground text-xs">
              {index === undefined ? "" : `第 ${Number(index) + 1} 项 · `}
              {definition?.label ?? field.label}
            </p>
            <FieldCalculationError error={error} />
          </div>
        );
      })}
    </>
  );
}
