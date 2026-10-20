import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { companionInstructions } from "./companion";
import {
  companionInitiativePrompts,
  companionInitiativeSchema,
  companionInitiativeText,
} from "./companion-initiative";
import { companionRoleplayInstructions } from "./companion-roleplay";

test("默认与自定义主动性进入队友提示，替换说明时保留身份和工具规则", () => {
  const defaults = companionInitiativeSchema.parse({});
  assert.equal(defaults.level, "natural");
  assert.equal(defaults.prompt, "");
  assert.equal(companionInitiativeText(defaults), companionInitiativePrompts.natural);
  assert.equal(
    companionInitiativeText({ level: "custom", prompt: "   " }),
    companionInitiativePrompts.natural,
  );
  assert.equal(
    companionInitiativeText({ level: "reserved", prompt: "不会使用这段" }),
    companionInitiativePrompts.reserved,
  );
  assert.equal(
    companionInitiativeText({ level: "custom", prompt: " 只在被点名时开口。 " }),
    "只在被点名时开口。",
  );
  const personality = "谨慎，主动提醒同伴";
  const natural = companionInstructions(personality);
  assert.ok(natural.includes(personality));
  assert.ok(natural.includes(companionRoleplayInstructions));
  assert.ok(natural.indexOf(companionRoleplayInstructions) < natural.indexOf(personality));
  assert.ok(natural.includes(companionInitiativePrompts.natural));
  for (const tool of ["companion_perform", "companion_request_ruling"])
    assert.ok(natural.includes(tool));
  const customPrompt = "只在被点名时开口。";
  const custom = companionInstructions(personality, {
    level: "custom",
    prompt: customPrompt,
  });
  assert.ok(custom.includes(customPrompt));
  assert.ok(!custom.includes(companionInitiativePrompts.natural));
  assert.equal(
    natural.replace(companionInitiativePrompts.natural, "<主动性>"),
    custom.replace(customPrompt, "<主动性>"),
  );
  const customized = companionInstructions(personality, defaults, false, "以角色台词为主。");
  assert.ok(customized.includes("以角色台词为主。"));
  assert.ok(!customized.includes(companionRoleplayInstructions));
  assert.ok(customized.includes("不替真人决定"));
  assert.ok(customized.includes("companion_request_ruling"));
  assert.equal(companionInstructions(personality, defaults, false, null), natural);
});
