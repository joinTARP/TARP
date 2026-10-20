import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { compactionSettingsSchema, resolveCompaction } from "./compaction-settings";

test("压缩阈值支持自动与自定义，并给小窗口和近期记录留出空间", () => {
  const automatic = resolveCompaction({ thresholdTokens: null }, 32768);
  assert.equal(automatic.thresholdTokens, 24576);
  assert.equal(automatic.reserveTokens, 8192);
  assert.equal(automatic.keepRecentTokens, 12000);
  const custom = resolveCompaction({ thresholdTokens: 8000 }, 128000);
  assert.equal(128000 - custom.reserveTokens, 8000);
  assert.ok(custom.keepRecentTokens < custom.thresholdTokens);
  const capped = resolveCompaction({ thresholdTokens: 100000 }, 32768);
  assert.equal(capped.thresholdTokens, 24576);
  const small = resolveCompaction({ thresholdTokens: null }, 4096);
  assert.ok(small.thresholdTokens > 0 && small.thresholdTokens < 4096);
  assert.ok(small.keepRecentTokens < small.thresholdTokens);
});

test("压缩阈值拒绝非法输入，允许恢复自动", () => {
  for (const thresholdTokens of [-1, 0, 1023, 8000.5, 2000001, Infinity, "8000"])
    assert.equal(compactionSettingsSchema.safeParse({ thresholdTokens }).success, false);
  assert.equal(compactionSettingsSchema.safeParse({ thresholdTokens: null }).success, true);
});
