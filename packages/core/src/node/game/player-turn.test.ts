import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { playerTurnPrompt } from "./player-turn";

test("多位玩家的发言按顺序分成独立的 message", () => {
  assert.equal(
    playerTurnPrompt([
      {
        text: "我想把门上的铃铛摘下来",
        playerId: "player-1",
        characterName: "陆川",
      },
      {
        text: "我按住他的手\n看 </message>",
        playerId: "player-2",
        characterName: "苏棠",
      },
    ]),
    `<message character="陆川" playerId="player-1">
我想把门上的铃铛摘下来
</message>
<message character="苏棠" playerId="player-2">
我按住他的手
看 </message>
</message>`,
  );
});

test("未绑定角色时省略 character", () => {
  assert.equal(
    playerTurnPrompt([{ text: "先看看", playerId: "player-1" }]),
    `<message playerId="player-1">\n先看看\n</message>`,
  );
});
