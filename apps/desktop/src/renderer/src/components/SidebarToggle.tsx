import { PanelLeft } from "lucide-react";

import { Button } from "./ui/button";

interface SidebarToggleProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}

/** macOS 按钮放在交通灯旁；Windows 保留原生标题栏，按钮贴近内容区左侧。 */
export function SidebarToggle({ collapsed, onToggle, className }: SidebarToggleProps) {
  const isWindows = navigator.userAgent.includes("Windows");

  return (
    <>
      {!isWindows ? (
        <div
          className="absolute inset-x-0 top-0 z-50 h-12 [-webkit-app-region:drag]"
          aria-hidden="true"
        />
      ) : null}
      <Button
        className={`text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-4 z-[60] size-8 rounded-lg [-webkit-app-region:no-drag] ${isWindows ? "left-4" : "left-20"} ${className ?? ""}`}
        variant="ghost"
        size="icon"
        onClick={onToggle}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
      >
        <PanelLeft className={collapsed ? "size-4 rotate-180" : "size-4"} aria-hidden="true" />
      </Button>
    </>
  );
}
