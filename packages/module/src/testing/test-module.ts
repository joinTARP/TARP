import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 包内固定测试模组的字段类型，仅用于验证平台功能。 */
export interface TestAbilityRecord {
  document: string;
  bonus?: number;
  growth?: number;
  override?: number;
}
export interface TestCharacterValues {
  stats: { vigor: number; agility: number; insight: number };
  hp: number;
  reserve: number;
  settlements: string[];
  effects: string[];
  ability_records?: TestAbilityRecord[];
}
export interface TestAbility {
  document: string;
  name: string;
  base: number;
  value: number;
}
export interface TestComputedCharacter extends TestCharacterValues {
  capacity: number;
  abilities: TestAbility[];
}

const sourceModulePath = fileURLToPath(new URL("../../test-fixtures/platform/", import.meta.url));

/** 复制包内测试模组，为每次测试提供可独立修改和清理的模组与存档目录。 */
export async function createTestModule() {
  const root = await mkdtemp(join(tmpdir(), "tarp-module-fixture-"));
  const modulePath = join(root, "module");
  const sessions = join(root, "sessions");
  try {
    await cp(sourceModulePath, modulePath, { recursive: true });
    return {
      root,
      modulePath,
      sessions,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
