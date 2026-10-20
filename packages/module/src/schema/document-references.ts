import { documentIdentity } from "./document-path";
import type { DocumentField } from "./document-type";
import { resolveInstanceDefinition, type InstanceResolver } from "./instance-state";

export type DeclaredReferences = ReadonlyMap<string, ReadonlySet<string>>;
export type DocumentReferenceIndex = ReadonlyMap<string, DeclaredReferences>;

/** 仅收集类型定义中声明过的 reference 值，包括对象和对象列表中的引用。 */
export function collectReferences(
  fields: readonly DocumentField[],
  values: Record<string, unknown>,
  resolveInstance?: InstanceResolver,
): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  const collect = (field: DocumentField, value: unknown): void => {
    const add = (reference: unknown, targets: readonly string[] | undefined): void => {
      if (typeof reference !== "string") return;
      const identity = documentIdentity(reference);
      const known = references.get(identity) ?? new Set<string>();
      for (const target of targets ?? []) known.add(target);
      references.set(identity, known);
    };
    if (field.type === "reference") add(value, field.targets);
    if (field.type === "list" && Array.isArray(value)) {
      if (field.item?.type === "reference") {
        for (const item of value) add(item, field.item.targets);
      } else if (field.item?.type === "object") {
        for (const item of value) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            for (const child of field.item.fields ?? []) {
              collect(child, (item as Record<string, unknown>)[child.key]);
            }
            if (field.item.instance && resolveInstance) {
              try {
                const definition = resolveInstanceDefinition(
                  field,
                  item as Record<string, unknown>,
                  resolveInstance,
                );
                const state = (item as Record<string, unknown>)[field.item.instance.stateField];
                if (state && typeof state === "object")
                  for (const child of definition.fields)
                    collect(child, (state as Record<string, unknown>)[child.key]);
              } catch {
                /* 错误由实例校验报告，仍保留物品定义引用边。 */
              }
            }
          }
        }
      }
    }
    if (field.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const child of field.fields ?? [])
        collect(child, (value as Record<string, unknown>)[child.key]);
    }
  };
  for (const field of fields) collect(field, values[field.key]);
  return references;
}

/** 保存直接声明引用；缺失目标也保留边，使之后新增目标能使旧结果失效。 */
export class DocumentReferenceGraph {
  private references = new Map<string, DeclaredReferences>();
  private snapshot?: DocumentReferenceIndex;
  private dependents = new Map<string, Set<string>>();

  get index(): DocumentReferenceIndex {
    return (this.snapshot ??= new Map(this.references));
  }

  set(identity: string, references: DeclaredReferences): void {
    this.remove(identity);
    this.references.set(identity, references);
    for (const reference of references.keys()) {
      const target = documentIdentity(reference);
      let owners = this.dependents.get(target);
      if (!owners) this.dependents.set(target, (owners = new Set()));
      owners.add(identity);
    }
  }

  remove(identity: string): void {
    this.snapshot = undefined;
    for (const reference of this.references.get(identity)?.keys() ?? []) {
      const target = documentIdentity(reference);
      const owners = this.dependents.get(target);
      owners?.delete(identity);
      if (!owners?.size) this.dependents.delete(target);
    }
    this.references.delete(identity);
  }

  affected(identities: Iterable<string>): Set<string> {
    const affected = new Set(identities);
    for (const identity of affected) {
      for (const owner of this.dependents.get(identity) ?? []) affected.add(owner);
    }
    return affected;
  }
}
