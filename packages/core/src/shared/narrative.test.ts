import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { parseNarrative } from "./narrative";

const scene =
  '<message narrator>\n门开了。\n</message>\n<message npc path="角色/卫兵" name="卫兵">\n北门失守了！\n</message>\n<message narrator>\n他看向你。\n</message>\n';

test("旁白与 NPC 按顺序切换，使用公开身份", () => {
  assert.deepEqual(
    parseNarrative(scene).map(({ kind, path, name, text }) => ({ kind, path, name, text })),
    [
      { kind: "narrator", path: undefined, name: "主持人", text: "门开了。" },
      { kind: "npc", path: "角色/卫兵", name: "卫兵", text: "北门失守了！" },
      { kind: "narrator", path: undefined, name: "主持人", text: "他看向你。" },
    ],
  );
});

test("逐字符接收时隐藏所有半截标记，正文首字立即出现且段落键稳定", () => {
  const keys = new Map<string, number>();
  for (let end = 1; end <= scene.length; end++) {
    const parts = parseNarrative(scene.slice(0, end));
    for (const part of parts) {
      assert.doesNotMatch(part.text, /<message|<\/message|id=|guard/u);
      const identity = part.text[0];
      if (keys.has(identity)) assert.equal(part.key, keys.get(identity));
      keys.set(identity, part.key);
    }
  }
  const firstWord = scene.indexOf("北") + 1;
  assert.equal(parseNarrative(scene.slice(0, firstWord)).at(-1)?.text, "北");
  assert.equal(parseNarrative(scene.slice(0, firstWord)).at(-1)?.name, "卫兵");
});

test("任意切片重连与最终快照得到同一演绎，停止在标记中也保留前文", () => {
  for (let split = 0; split < scene.length; split++) {
    const saved = scene.slice(0, split);
    assert.deepEqual(parseNarrative(saved + scene.slice(split)), parseNarrative(scene));
  }
  assert.equal(
    parseNarrative('<message narrator>\n门开了。\n<message npc path="角色/卫兵"').at(-1)?.text,
    "门开了。",
  );
  assert.deepEqual(parseNarrative('<message npc path="角色/卫兵"'), []);
});

test("闭合标签不是显示条件，省略闭合时下一段仍能切换", () => {
  const open = '<message npc path="角色/卫兵" name="卫兵">\n北';
  assert.equal(parseNarrative(open).at(-1)?.text, "北");
  assert.equal(parseNarrative(open).at(-1)?.name, "卫兵");
  assert.deepEqual(
    parseNarrative(
      '<message narrator>\n门开了。\n<message npc path="角色/卫兵" name="卫兵">\n北门失守了！',
    ).map(({ kind, text }) => ({ kind, text })),
    [
      { kind: "narrator", text: "门开了。" },
      { kind: "npc", text: "北门失守了！" },
    ],
  );
});

test("无标记正文、代码块与 CRLF 保持原样，损坏的 NPC 标签回退旁白", () => {
  assert.equal(parseNarrative("老板说：‘请进。’")[0].kind, "narrator");
  const code =
    '```text\n<message narrator>\n<message npc path="角色/示例" name="示例">\n</message>\n```';
  assert.equal(parseNarrative(code)[0].text, code);
  assert.equal(parseNarrative(scene.replaceAll("\n", "\r\n"))[1].name, "卫兵");
  assert.deepEqual(
    parseNarrative('<message npc name="卫兵">\n他看向你。').map(({ kind, text }) => ({
      kind,
      text,
    })),
    [{ kind: "narrator", text: "他看向你。" }],
  );
  assert.equal(
    parseNarrative('<message npc name="卫兵" path="角色/卫兵">\n北').at(-1)?.path,
    "角色/卫兵",
  );
});

test("玩家角色和 AI 队友即使被主持标成 NPC，展示时仍归入主持旁白", () => {
  const [segment] = parseNarrative(
    '<message npc path="角色/苏棠" name="苏棠">\n抓住我的手。',
    new Set(["陆川", "苏棠"]),
  );
  assert.deepEqual(
    { kind: segment.kind, path: segment.path, name: segment.name, text: segment.text },
    { kind: "narrator", path: undefined, name: "主持人", text: "抓住我的手。" },
  );
});

test("文档路径统一格式，公开称呼可省略；玩家路径不能通过别名伪装成 NPC", () => {
  const [speaker] = parseNarrative('<message npc path="人物/卫兵.toml">\n站住。');
  assert.equal(speaker.path, "人物/卫兵");
  assert.equal(speaker.name, "");
  assert.equal(
    parseNarrative(
      '<message npc path="人物/卫兵" name="陌生人">\n站住。',
      new Set(),
      new Set(["人物/卫兵"]),
    )[0].kind,
    "narrator",
  );
  for (const path of ["../秘密", "/秘密", "file:secret", "人物//卫兵", "人物/../卫兵"])
    assert.equal(parseNarrative(`<message npc path="${path}">\n站住。`)[0].kind, "narrator");
  assert.equal(parseNarrative('<message npc id="guard" name="卫兵">\n站住。')[0].kind, "narrator");
  assert.deepEqual(
    parseNarrative('<message npc path="人物/秘密"\n站住。').map(({ kind, text }) => ({
      kind,
      text,
    })),
    [{ kind: "narrator", text: "站住。" }],
  );
});
