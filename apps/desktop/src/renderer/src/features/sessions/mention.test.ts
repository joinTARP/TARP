import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { parseMentionRefs, resolveMentionRefs } from "@jointarp/core/shared/mentions";

import {
  mentionDraftSchema,
  draftText,
  draftMarkdown,
  resolveDraft,
  textDraft,
  trimDraft,
  filterMentions,
  mentionQuery,
  placeMentionMenu,
  type MentionDraft,
} from "./mention";

const people = [
  { id: "a", name: "陆川" },
  { id: "b", name: "阿洛" },
];

test("未完成的 @ 查询、筛选和选择衔接，完成的提及及邮箱不触发菜单", () => {
  assert.deepEqual(mentionQuery(textDraft("看看 @陆"), 6), { start: 3, query: "陆" });
  assert.equal(mentionQuery(textDraft("看看 @陆川 "), 7), null);
  assert.equal(mentionQuery(textDraft("邮箱 a@b"), 5), null);
  assert.deepEqual(mentionQuery(textDraft("@"), 1), { start: 0, query: "" });
  assert.deepEqual(
    filterMentions(people, "").map((item) => item.name),
    ["陆川", "阿洛"],
  );
  assert.deepEqual(
    filterMentions(people, "陆").map((item) => item.name),
    ["陆川"],
  );
});

test("提及菜单贴着光标，贴边时收回输入框内", () => {
  assert.deepEqual(
    placeMentionMenu({ left: 120, top: 32, height: 28 }, { width: 224, height: 80 }, 400, 240),
    {
      left: 120,
      top: 32,
      above: true,
    },
  );
  assert.deepEqual(
    placeMentionMenu({ left: 300, top: 4, height: 28 }, { width: 224, height: 160 }, 400, 12),
    {
      left: 176,
      top: 32,
      above: false,
    },
  );
});

test("编辑器标签和手写身份链接使用同一解析；重名与失效目标不混淆身份", () => {
  const id = "AbCdEfGhIjKlMn_1";
  const target = { id, kind: "player" as const, nickname: "昵称", label: "陆川（昵称）" };
  const ordinary = textDraft(`@陆川 @昵称 mail@${id} @${id}`);
  assert.deepEqual(parseMentionRefs(draftMarkdown(ordinary)), []);
  assert.deepEqual(resolveMentionRefs(undefined, [target]), []);
  assert.deepEqual(resolveMentionRefs([], [target]), []);
  const draft: MentionDraft = [{ type: "mention", id, label: "旧称" }, ...textDraft(" 小心")];
  assert.deepEqual(mentionDraftSchema.parse(draft), draft);
  assert.deepEqual(resolveMentionRefs([{ id: id.toUpperCase() }], [target]), []);
  const resolved = resolveDraft(draft, [{ id, name: target.label }]);
  assert.equal(draftText(resolved), "@陆川（昵称） 小心");
  assert.equal(draftMarkdown(resolved), `[@陆川（昵称）](#mention/${id}) 小心`);
  assert.deepEqual(parseMentionRefs(draftMarkdown(resolved)), [{ id }]);
  assert.deepEqual(parseMentionRefs(`[@任意显示文字](#mention/${id})`), [{ id }]);
  assert.equal(mentionQuery(resolved, "@陆川（昵称）".length), null);
  assert.equal(draftText(resolveDraft(draft, [])), "@旧称 小心");
  assert.deepEqual(parseMentionRefs(draftMarkdown(resolveDraft(draft, []))), []);
  const otherId = id.toLowerCase();
  assert.deepEqual(
    resolveMentionRefs(
      [{ id: id.toUpperCase() }, { id }, { id: otherId }, { id: id.slice(0, 12) }],
      [target, { ...target, id: otherId }],
    ),
    [
      { id, label: target.label },
      { id: otherId, label: target.label },
    ],
  );
  assert.deepEqual(trimDraft([...textDraft(" \n"), ...draft, ...textDraft(" \n")]), draft);
  assert(
    draftMarkdown([{ type: "mention", id, label: "[昵称](恶意链接)" }]).includes("\\[昵称\\]"),
  );
});

test("身份链接仅在有效正文中点名，代码、引用、图片、半截和非法链接不触发", () => {
  const valid = "[@阿洛](#mention/ai-id)";
  assert.deepEqual(parseMentionRefs(`${valid} ${valid} [@同名](#mention/AI-ID)`), [
    { id: "ai-id" },
    { id: "AI-ID" },
  ]);
  for (const source of [
    "@阿洛 @ai-id",
    `\`${valid}\``,
    `> ${valid}`,
    `\`\`\`md\n${valid}\n\`\`\``,
    `    ${valid}`,
    `!${valid}`,
    "[@阿洛](#mention/ai-id",
    "[@阿洛](#mention/)",
    "[@阿洛](#mention/ai/id)",
    "[@阿洛](https://example.com/#mention/ai-id)",
    "<!-- [@阿洛](#mention/ai-id) -->",
  ])
    assert.deepEqual(parseMentionRefs(source), [], source);
  assert.deepEqual(parseMentionRefs(`> ${valid}\n\n[@艾琳](#mention/second)`), [{ id: "second" }]);
});
