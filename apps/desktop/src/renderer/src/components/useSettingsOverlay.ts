import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

/** 设置是盖在工作区上的一层，用根路由 search 表示开关，不卸载当前页面。 */
export function useSettingsOverlay() {
  const navigate = useNavigate();
  const { overlay } = useSearch({ from: "__root__" });
  const openSettings = useCallback(() => {
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, overlay: "settings" as const }),
    });
  }, [navigate]);
  const closeSettings = useCallback(() => {
    void navigate({ to: ".", search: (previous) => ({ ...previous, overlay: undefined }) });
  }, [navigate]);

  return {
    isOpen: overlay === "settings",
    openSettings,
    closeSettings,
  };
}
