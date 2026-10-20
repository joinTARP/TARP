/// <reference types="vite/client" />

import type { DesktopEvents } from "@shared/desktop-events";

declare global {
  interface Window {
    desktopEvents?: DesktopEvents;
  }
}
