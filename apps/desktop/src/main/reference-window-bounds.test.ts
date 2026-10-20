import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { placeReferenceWindow } from "./reference-window-bounds";

const workArea = { x: 0, y: 25, width: 1440, height: 820 };

test("有空位时参考窗贴在游戏房右侧", () => {
  assert.deepEqual(
    placeReferenceWindow(null, { x: 40, y: 40, width: 400, height: 700 }, workArea),
    { x: 456, y: 40, width: 880, height: 760 },
  );
});

test("右侧放不下时贴着工作区右缘", () => {
  const placed = placeReferenceWindow(null, { x: 700, y: 40, width: 700, height: 700 }, workArea);
  assert.equal(placed.x, 1440 - 880);
  assert.equal(placed.y, 40);
});

test("记住的位置还在屏幕上时沿用", () => {
  const saved = { x: 20, y: 30, width: 900, height: 700 };
  assert.deepEqual(placeReferenceWindow(saved, null, workArea), saved);
});

test("记住的位置离开屏幕时改用工作区", () => {
  const placed = placeReferenceWindow({ x: 4000, y: 30, width: 900, height: 700 }, null, workArea);
  assert.ok(placed.x >= workArea.x);
  assert.ok(placed.x + placed.width <= workArea.x + workArea.width);
});
