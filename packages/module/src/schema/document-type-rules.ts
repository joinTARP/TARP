import type { DocumentField, DocumentType } from "./document-type";

/** 类型定义和单文档有效定义共用实例原始状态约束。 */
export function validateDocumentTypeRules(type: DocumentType): void {
  const assertRawBindings = (fields: readonly DocumentField[], computedAncestor = false) => {
    for (const field of fields) {
      const computed = computedAncestor || field.compute !== undefined;
      if (field.item?.instance && computed)
        throw new Error(
          field.key + ".item.instance：实例绑定必须位于原始状态中，不能由父字段公式生成",
        );
      assertRawBindings(field.fields ?? field.item?.fields ?? [], computed);
    }
  };
  assertRawBindings(type.fields);
}
