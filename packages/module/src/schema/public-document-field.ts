import type { DocumentField } from "./document-type";

function findDocumentField(
  fields: readonly DocumentField[],
  path: string,
  accepts: (field: DocumentField) => boolean,
): DocumentField | undefined {
  let candidates = fields;
  let field: DocumentField | undefined;
  for (const key of path.split(".")) {
    field = candidates.find((candidate) => candidate.key === key);
    if (!field || !accepts(field)) return undefined;
    candidates = field.fields ?? field.item?.fields ?? [];
  }
  return field;
}

/** 沿完整字段路径查找声明字段；可供主持读取非公开字段定义。 */
export function getDocumentField(
  fields: readonly DocumentField[],
  path: string,
): DocumentField | undefined {
  return findDocumentField(fields, path, () => true);
}

/** 沿完整字段路径查找；任一父字段非公开时停止。 */
export function getPublicDocumentField(
  fields: readonly DocumentField[],
  path: string,
): DocumentField | undefined {
  return findDocumentField(fields, path, (field) => field.visibility === "public");
}

/** 仅控制字段展示；false、空对象及包含元素的列表不属于空值。 */
export function shouldHideEmptyField(
  field: Pick<DocumentField, "hideWhenEmpty"> | undefined,
  value: unknown,
): boolean {
  return Boolean(
    field?.hideWhenEmpty &&
    (value === undefined ||
      value === null ||
      value === 0 ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)),
  );
}

/** 错误仅随计算投影展示；玩家不接收主持字段或内部公式诊断。 */
export function publicFieldErrors(
  fields: readonly DocumentField[],
  errors: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!errors) return undefined;
  const entries = Object.keys(errors)
    .filter((path) => getPublicDocumentField(fields, path.replace(/\[\d+\]/g, "")))
    .map((path) => [path, "当前字段计算失败，请重试或联系模组作者。"]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** 容器子字段有错误时，也要保留容器的展示入口。 */
export function hasFieldErrors(
  errors: Readonly<Record<string, string>> | undefined,
  path: string,
): boolean {
  return Boolean(
    errors &&
    Object.keys(errors).some(
      (key) =>
        key === path ||
        key.startsWith(`${path}.`) ||
        key.startsWith(`${path}[`) ||
        path.startsWith(`${key}.`) ||
        path.startsWith(`${key}[`),
    ),
  );
}

/** 父字段失败时，单独布局的子字段也显示同一错误，不读取对象原值。 */
export function fieldErrorAtPath(
  errors: Readonly<Record<string, string>> | undefined,
  path: string,
): string | undefined {
  if (!errors) return undefined;
  if (Object.hasOwn(errors, path)) return errors[path];
  return Object.entries(errors).find(
    ([key]) => path.startsWith(`${key}.`) || path.startsWith(`${key}[`),
  )?.[1];
}
