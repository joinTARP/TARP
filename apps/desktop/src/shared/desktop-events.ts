export interface DesktopEvents {
  claimStartupAnimation(): Promise<boolean>;
  setGamePage(active: boolean): void;
  onRequestLeaveRoom(listener: () => void): () => void;
  onOpenSettings(listener: () => void): () => void;
}
