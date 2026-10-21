import {
  readCompactionSettingsFile,
  saveCompactionSettingsFile,
} from "@jointarp/core/node/game/compaction-settings";
import { readRoomSettings, updateRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import { readRoomState } from "@jointarp/core/node/sessions/session-store";
import type { CompactionRole, CompactionSettings } from "@jointarp/core/shared/compaction-settings";
import type { AvailableAiModel, RoomAiSettings, ThinkingLevel } from "@jointarp/core/shared/game";
import { ORPCError } from "@orpc/server";

import type { LocalGameSettings } from "./local-settings";

/** 存档仅记录模型和连接引用，凭据始终由本机 pi 认证存储管理。 */
export class RoomAiSettingsStore {
  constructor(
    private root: string,
    private settings: LocalGameSettings,
  ) {}
  private async read(roomId: string): Promise<AvailableAiModel | null> {
    const { directory } = await readRoomState(this.root, roomId);
    return readRoomSettings(directory).ai;
  }
  async get(roomId: string): Promise<RoomAiSettings> {
    const selection = await this.read(roomId);
    if (!selection) return { selection: null, ready: false };
    try {
      await this.settings.credentialsFor(selection);
      return { selection, ready: true };
    } catch {
      return { selection, ready: false };
    }
  }
  async resolve(
    provider: string,
    model: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<AvailableAiModel> {
    const available = await this.settings.availableModels();
    const selection = available.find((item) => item.provider === provider && item.model === model);
    if (!selection)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "此模型当前不可用，请先在应用设置中连接服务商。",
      });
    await this.settings.credentialsFor(selection);
    return { ...selection, thinkingLevel };
  }
  async select(
    roomId: string,
    provider: string,
    model: string,
    thinkingLevel?: ThinkingLevel,
  ): Promise<RoomAiSettings> {
    const selection = await this.resolve(provider, model, thinkingLevel);
    const { directory } = await readRoomState(this.root, roomId);
    updateRoomSettings(directory, (settings) => ({ ...settings, ai: selection }));
    return { selection, ready: true };
  }
  async compaction(roomId: string) {
    const { directory } = await readRoomState(this.root, roomId);
    return readCompactionSettingsFile(directory);
  }
  async saveCompaction(roomId: string, role: CompactionRole, settings: CompactionSettings) {
    const { directory } = await readRoomState(this.root, roomId);
    return saveCompactionSettingsFile(directory, role, settings);
  }
  async credentials(roomId: string, selection?: AvailableAiModel | null) {
    const chosen = selection === undefined ? await this.read(roomId) : selection;
    if (!chosen)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "请先为这段冒险选择 AI 模型，或开启“仅聊天”。",
      });
    return this.settings.credentialsFor(chosen);
  }
}
