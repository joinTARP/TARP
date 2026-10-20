import { Screen } from "electrobun/main";

import { createDesktopWindow, isWindowOpen, showWindow, type DesktopWindow } from "./native-window";
import { placeReferenceWindow } from "./reference-window-bounds";
import { ReferenceWindowState } from "./reference-window-state";

const windows = new Map<string, DesktopWindow>();
let windowState: ReferenceWindowState | null = null;
let parentWindow: () => DesktopWindow | null = () => null;

export async function configureReferenceWindows(options: {
  readonly boundsFile: string;
  readonly parent: () => DesktopWindow | null;
}): Promise<void> {
  windowState = new ReferenceWindowState(options.boundsFile);
  parentWindow = options.parent;
  await windowState.load();
}

export function openModuleReference(roomId: string): void {
  const existing = windows.get(roomId) ?? null;
  if (isWindowOpen(existing)) {
    showWindow(existing);
    return;
  }
  const parent = parentWindow();
  const parentBounds = isWindowOpen(parent) ? parent.getFrame() : null;
  const displays = Screen.getAllDisplays();
  const display =
    displays.find(
      ({ workArea }) =>
        parentBounds &&
        parentBounds.x >= workArea.x &&
        parentBounds.x < workArea.x + workArea.width,
    ) ?? Screen.getPrimaryDisplay();
  const state = windowState;
  const bounds = placeReferenceWindow(state?.value ?? null, parentBounds, display.workArea);
  const window = createDesktopWindow({ title: "模组设定", frame: bounds }, `/reference/${roomId}`, {
    width: 720,
    height: 560,
  });
  windows.set(roomId, window);
  const remember = () => {
    if (isWindowOpen(window) && state) void state.save(window.getFrame()).catch(() => undefined);
  };
  window.on("move", remember);
  window.on("resize", remember);
  window.on("will-close", remember);
  window.on("close", () => {
    if (windows.get(roomId) === window) windows.delete(roomId);
  });
}
export function closeModuleReference(roomId: string): void {
  const window = windows.get(roomId) ?? null;
  if (isWindowOpen(window)) window.close();
}
export function closeAllModuleReferences(): void {
  for (const id of [...windows.keys()]) closeModuleReference(id);
}
export async function flushReferenceWindowState(): Promise<void> {
  await windowState?.flush();
}
