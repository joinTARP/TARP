import type { ModuleDocument } from "@shared/desktop-api";
import { documentIdentity } from "@tarp/module/document-path";
import type { DocumentField } from "@tarp/module/document-type";
import { useId } from "react";

import { Button } from "../../components/ui/button";
import { NumberInput } from "../../components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";

type References = readonly Pick<ModuleDocument, "path" | "title" | "docType" | "visible">[];
function initialFieldValue(field: DocumentField): unknown {
  if (field.type === "object")
    return Object.fromEntries(
      (field.fields ?? [])
        .filter((f) => f.required && !f.compute)
        .map((f) => [f.key, initialFieldValue(f)]),
    );
  if (field.type === "list") return [];
  if (field.type === "boolean") return false;
  return "";
}
export function FieldInput({
  field,
  value,
  onChange,
  references,
  allowPrivate = false,
}: {
  field: DocumentField;
  value: unknown;
  onChange: (value: unknown) => void;
  references: References;
  allowPrivate?: boolean;
}) {
  const id = useId();
  if (field.compute || (!allowPrivate && field.visibility !== "public")) return null;
  const selectOptions =
    field.type === "boolean"
      ? [
          { value: "", label: "未填写" },
          { value: "true", label: "是" },
          { value: "false", label: "否" },
        ]
      : field.type === "enum" || field.type === "reference"
        ? [
            { value: "", label: "请选择" },
            ...(field.type === "enum"
              ? (field.options ?? []).map((option) => ({ value: option, label: option }))
              : references
                  .filter(
                    (reference) =>
                      (allowPrivate || reference.visible !== false) &&
                      field.targets?.includes(reference.docType ?? ""),
                  )
                  .map((reference) => ({
                    value: documentIdentity(reference.path),
                    label: reference.title,
                  }))),
          ]
        : undefined;
  return (
    <div
      className={
        field.type === "object" || field.type === "list" ? "col-span-full space-y-2" : "space-y-2"
      }
    >
      <label
        htmlFor={field.type === "object" || field.type === "list" ? undefined : id}
        className="block text-xs font-medium"
      >
        {field.label}
        {field.required ? <span className="text-muted-foreground ml-1">*</span> : null}
      </label>
      {field.type === "object" ? (
        <div className="border-border space-y-3 rounded-xl border p-4">
          {value && typeof value === "object" ? (
            <>
              <CharacterFields
                fields={field.fields ?? []}
                values={value as Record<string, unknown>}
                references={references}
                allowPrivate={allowPrivate}
                onChange={onChange}
              />
              {!field.required ? (
                <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
                  移除此项
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              id={id}
              size="sm"
              variant="outline"
              onClick={() => onChange(initialFieldValue(field))}
            >
              填写{field.label}
            </Button>
          )}
        </div>
      ) : field.type === "list" ? (
        <div className="border-border space-y-3 rounded-xl border p-4">
          {(Array.isArray(value) ? value : []).map((item, index, list) => (
            <div key={index} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <FieldInput
                  field={{
                    key: String(index),
                    label: `${field.label} ${index + 1}`,
                    required: true,
                    mutable: false,
                    visibility: "public",
                    ...field.item!,
                  }}
                  value={item}
                  references={references}
                  allowPrivate={allowPrivate}
                  onChange={(next) => onChange(list.map((v, i) => (i === index ? next : v)))}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`移除${field.label} ${index + 1}`}
                onClick={() => onChange(list.filter((_, i) => i !== index))}
              >
                移除
              </Button>
            </div>
          ))}
          <Button
            id={id}
            size="sm"
            variant="outline"
            onClick={() =>
              onChange([
                ...(Array.isArray(value) ? value : []),
                initialFieldValue({ ...field, ...field.item! }),
              ])
            }
          >
            添加{field.label}
          </Button>
        </div>
      ) : selectOptions ? (
        <Select
          items={selectOptions}
          value={
            field.type === "boolean"
              ? value === undefined || value === null
                ? ""
                : String(value)
              : field.type === "reference" &&
                  !selectOptions.some((option) => option.value === value)
                ? ""
                : typeof value === "string"
                  ? value
                  : ""
          }
          onValueChange={(next) =>
            onChange(!next ? undefined : field.type === "boolean" ? next === "true" : next)
          }
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {selectOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "number" ? (
        <NumberInput
          id={id}
          step="any"
          value={
            typeof value === "number"
              ? value
              : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
                ? Number(value)
                : null
          }
          onValueChange={(next) => onChange(next ?? undefined)}
        />
      ) : (
        <Textarea
          id={id}
          rows={2}
          className="min-h-16"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      )}
    </div>
  );
}
function CharacterFields({
  fields,
  values,
  references,
  onChange,
  allowPrivate = false,
}: {
  fields: readonly DocumentField[];
  values: Record<string, unknown>;
  references: References;
  onChange: (values: Record<string, unknown>) => void;
  allowPrivate?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      {fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key]}
          references={references}
          allowPrivate={allowPrivate}
          onChange={(value) => {
            const next = { ...values };
            if (value === undefined) delete next[field.key];
            else next[field.key] = value;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
