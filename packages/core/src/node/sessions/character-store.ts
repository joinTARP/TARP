import {
  characterDraftSchema,
  type Character,
  type CharacterDraft,
} from "@jointarp/module/character";
import {
  resolveDocumentComputations,
  documentSourceValues,
} from "@jointarp/module/document-computations";
import { resolveModuleDocuments } from "@jointarp/module/document-evaluator";
import { documentFormat, documentIdentity } from "@jointarp/module/document-path";
import { validateDocumentValues, type DocumentField } from "@jointarp/module/document-type";
import {
  resolveInstanceDefinition,
  validateInstanceBindings,
  type InstanceResolver,
} from "@jointarp/module/instance-state";
import type { ModuleDocument } from "@jointarp/module/module-document";

import type { SessionDatabase } from "../storage/session-database";
import { readCharacters, storedTypes } from "./character-db";
import { gameInstanceResolver, readGameDocumentSnapshot, materializeCharacter } from "./game-state";
import { gameDirectoryForDatabase, openSessionDatabase } from "./session-store";
import { withStateLock } from "./state-lock";

export async function withCharacters<T>(
  root: string,
  roomId: string,
  fn: (db: SessionDatabase) => T | Promise<T>,
): Promise<T> {
  const db = await openSessionDatabase(root, roomId);
  try {
    return await withStateLock(gameDirectoryForDatabase(db), async () => fn(db));
  } finally {
    db.close();
  }
}
function rejectPrivateOrUnknown(
  fields: readonly DocumentField[],
  values: Record<string, unknown>,
  resolve: InstanceResolver,
) {
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((f) => f.key === key);
    if (!field || field.visibility !== "public" || field.compute !== undefined)
      throw new Error(`不能填写字段：${key}`);
    if (field.fields && value && typeof value === "object" && !Array.isArray(value))
      rejectPrivateOrUnknown(field.fields, value as Record<string, unknown>, resolve);
    if (field.item?.fields && Array.isArray(value))
      for (const item of value)
        if (item && typeof item === "object") {
          const definition = field.item.instance
            ? resolveInstanceDefinition(field, item, resolve)
            : undefined;
          const children = definition
            ? field.item.fields.map((child) =>
                child.key === field.item!.instance!.stateField
                  ? { ...child, fields: definition.fields }
                  : child,
              )
            : field.item.fields;
          rejectPrivateOrUnknown(children, item, resolve);
        }
  }
}
export function validateCharacterDraft(
  db: SessionDatabase,
  input: CharacterDraft,
  playerInput = true,
): CharacterDraft {
  const draft = characterDraftSchema.parse(input);
  if (Object.hasOwn(draft.values, "computed"))
    throw new Error("角色业务值不能包含 computed 配置，请使用独立配置字段");
  const baseType = storedTypes(db).find(
    (t) => t.id === draft.typeId && t.designation === "character",
  );
  if (!baseType) throw new Error("请选择有效的角色类型");
  if (playerInput && draft.computed !== undefined)
    throw new Error("玩家不能填写 computed 公式配置");
  const type = resolveDocumentComputations(baseType, draft.computed);
  const name = draft.name.trim();
  if (!name && !type.fields.some((field) => field.key === "name" && field.compute !== undefined))
    throw new Error("请填写角色姓名");
  if (JSON.stringify(documentSourceValues(draft)).length > 100_000) throw new Error("角色属性过大");
  const resolveInstance = gameInstanceResolver(db, gameDirectoryForDatabase(db));
  if (playerInput) rejectPrivateOrUnknown(type.fields, draft.values, resolveInstance);
  validateInstanceBindings(type.fields, draft.values, resolveInstance);
  const metadata: Record<string, unknown> = {
    name,
    ...(draft.description ? { description: draft.description } : {}),
  };
  for (const field of type.fields) {
    if (field.compute !== undefined) delete metadata[field.key];
  }
  validateDocumentValues(type, { ...metadata, ...documentSourceValues(draft) });
  return { ...draft, name };
}

/** 用角色当前值覆盖同身份资料后统一解析引用与计算字段；数据库不保存派生值。 */
export async function characterViews(
  db: SessionDatabase,
  override?: Character,
): Promise<Character[]> {
  return (await characterSnapshot(db, override, override ? { requestedIds: [override.id] } : {}))
    .characters;
}

/** 角色与引用资料共用一次计算结果，保留完整属性供服务端校验，公开投影由调用方执行。 */
export async function characterSnapshot(
  db: SessionDatabase,
  override?: Character,
  options: { raw?: boolean; requestedIds?: readonly string[] } = {},
): Promise<{ characters: Character[]; documents: readonly ModuleDocument[] }> {
  const types = storedTypes(db);
  for (const character of readCharacters(db))
    if (
      !character.sourcePath &&
      (!options.requestedIds || options.requestedIds.includes(character.id))
    )
      await materializeCharacter(db, gameDirectoryForDatabase(db), character);
  const characters = readCharacters(db).filter(
    (character) => !options.requestedIds || options.requestedIds.includes(character.id),
  );
  if (override) {
    const index = characters.findIndex((c) => c.id === override.id);
    if (index < 0) characters.push(override);
    else characters[index] = override;
  }
  const documents = [...(await readGameDocumentSnapshot(db, gameDirectoryForDatabase(db)))];
  const sourcePaths = new Set(documents.map((item) => item.document.path));
  const characterPath = (c: Character) => c.sourcePath ?? `${c.typeId}/${c.id}.json`;
  if (override) {
    const current = documents.findIndex((item) => item.document.path === characterPath(override));
    if (current >= 0) documents.splice(current, 1);
    documents.push({
      identity: documentIdentity(characterPath(override)),
      documentType: types.find((type) => type.id === override.typeId)!,
      values: override.values,
      computed: override.computed,
      document: {
        path: characterPath(override),
        title: override.name,
        description: override.description,
        body: override.body,
        docType: override.typeId,
        contentType: documentFormat(characterPath(override)),
        valid: true,
      },
    });
  }
  const resolved = options.raw
    ? documents.map((item) => ({ ...item.document, values: item.values, computed: item.computed }))
    : await resolveModuleDocuments(documents, {
        view: "public",
        ...(options.requestedIds
          ? {
              identities: new Set(
                characters.map((character) => documentIdentity(characterPath(character))),
              ),
            }
          : {}),
      });
  const views = characters.map((character) => {
    const document = resolved.find((item) => item.path === characterPath(character));
    if (!document?.valid)
      throw new Error(`角色 ${character.name}：${document?.error ?? "角色文档不存在"}`);
    return {
      ...character,
      name: document.title,
      description: document.description ?? "",
      body: document.body,
      image: document.image,
      avatar: document.avatar,
      values: { ...document.values },
    };
  });
  return {
    characters: views,
    documents: resolved.filter((document) => sourcePaths.has(document.path)),
  };
}
