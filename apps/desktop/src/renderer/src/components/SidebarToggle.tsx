import { PanelLeft } from "lucide-react";

import { Button } from "./ui/button";

interface SidebarToggleProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}

/** 把窗口操作放在原生交通灯旁，避免再拼出一条独立的自定义标题栏。 */
export function SidebarToggle({ collapsed, onToggle, className }: SidebarToggleProps) {
  return (
    <>
      <div
        className="absolute inset-x-0 top-0 z-50 h-12 [-webkit-app-region:drag]"
        aria-hidden="true"
      />
      <Button
        className={`text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-4 left-20 z-[60] size-8 rounded-lg [-webkit-app-region:no-drag] ${className ?? ""}`}
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
