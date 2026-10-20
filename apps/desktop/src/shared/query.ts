/**
 * 通用内存查询原语：编辑器各页共用，避免散落手写 find/filter 循环。
 * 纯函数、零环境依赖，供桌面端页面共用。
 */

/** 按 id 建索引；重复 id 保留后者。 */
export function indexById<T extends { readonly id: string }>(
  items: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(items.map((item): [string, T] => [item.id, item]));
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase("zh-CN");
}

/** 多字段模糊搜索：字段拼接后做大小写不敏感包含匹配；空查询返回原数组。 */
export function searchItems<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => readonly (string | null | undefined)[],
): readonly T[] {
  const keyword = normalizeSearchQuery(query);
  if (!keyword) return items;
  return items.filter((item) =>
    fieldsOf(item)
      .filter((field): field is string => Boolean(field))
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(keyword),
  );
}
