import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect } from "react";

import { AutosaveScope } from "../features/settings/AutosaveScope";
import SettingsPage from "../features/settings/SettingsPage";
import { Dialog, DialogPortal, DialogTitle } from "./ui/dialog";
import { useSettingsOverlay } from "./useSettingsOverlay";

export function SettingsLayer() {
  const { isOpen, openSettings, closeSettings } = useSettingsOverlay();
  useEffect(() => window.desktopEvents?.onOpenSettings(openSettings), [openSettings]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogPortal>
        <DialogPrimitive.Popup className="bg-background text-foreground fixed inset-0 z-[100] flex h-dvh w-dvw outline-none">
          <DialogTitle className="sr-only">设置</DialogTitle>
          <AutosaveScope active={isOpen}>
            <SettingsPage />
          </AutosaveScope>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
