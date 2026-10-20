import { roomDisplaySettingsSchema } from "../../shared/agent-details";
import { readRoomSettings, updateRoomSettings } from "./room-settings";
import { readRoomState } from "./session-store";

export async function roomDisplaySettings(
  root: string,
  roomId: string,
  patch?: Partial<{ showReasoning: boolean; showAllDocuments: boolean }>,
) {
  const { directory } = await readRoomState(root, roomId);
  if (patch === undefined) return readRoomSettings(directory).display;
  return updateRoomSettings(directory, (settings) => ({
    ...settings,
    display: roomDisplaySettingsSchema.parse({
      showReasoning: patch.showReasoning ?? settings.display.showReasoning,
      showAllDocuments: patch.showAllDocuments ?? settings.display.showAllDocuments,
    }),
  })).display;
}
