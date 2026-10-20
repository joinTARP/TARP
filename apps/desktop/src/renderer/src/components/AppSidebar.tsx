import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Compass, History, Library, Settings, type LucideIcon } from "lucide-react";

import { NavigationHighlight, NavigationMotion } from "./NavigationMotion";
import { SplashLogoTarget } from "./SplashScreen";
import { Button } from "./ui/button";
import { useSettingsOverlay } from "./useSettingsOverlay";

export type AppSection = "home" | "history" | "modules";

interface AppSidebarProps {
  readonly activeSection: AppSection;
}

/** 应用级导航；窗口操作与业务内容保持分离。 */
export function AppSidebar({ activeSection }: AppSidebarProps) {
  const { openSettings } = useSettingsOverlay();
  const navigate = useNavigate();

  function selectSection(section: AppSection, to: "/" | "/history" | "/modules") {
    if (section === activeSection) return;
    void navigate({ to });
  }

  return (
    <aside className="border-border/60 bg-sidebar text-sidebar-foreground flex w-60 shrink-0 flex-col border-r px-3 pt-16 pb-4">
      <div className="mb-8 flex justify-center px-3 pt-2">
        <SplashLogoTarget className="w-45" />
      </div>
      <NavigationMotion>
        <nav className="space-y-1" aria-label="主导航">
          <SidebarNavItem
            active={activeSection === "home"}
            icon={Compass}
            label="首页"
            onClick={() => selectSection("home", "/")}
          />
          <SidebarNavItem
            active={activeSection === "history"}
            icon={History}
            label="历史冒险"
            onClick={() => selectSection("history", "/history")}
          />
          <SidebarNavItem
            active={activeSection === "modules"}
            icon={Library}
            label="模组库"
            onClick={() => selectSection("modules", "/modules")}
          />
        </nav>
      </NavigationMotion>

      <div className="mt-auto px-2 pt-6">
        <Button
          className="text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground w-full justify-start gap-3 px-3"
          variant="ghost"
          aria-label="设置"
          onClick={openSettings}
        >
          <Settings className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
          设置
        </Button>
      </div>
    </aside>
  );
}

interface SidebarNavItemProps {
  readonly active: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick: () => void;
}

function SidebarNavItem({ active, icon: Icon, label, onClick }: SidebarNavItemProps) {
  return (
    <button
      className={cn(
        "relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-200 focus-visible:outline-1 focus-visible:outline-ring focus-visible:outline-offset-2 outline-none motion-reduce:transition-none",
        active
          ? "text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <NavigationHighlight active={active} />
      <Icon
        className="relative size-[18px] shrink-0"
        strokeWidth={active ? 2.2 : 1.8}
        aria-hidden="true"
      />
      <span className="relative flex-1 text-left">{label}</span>
    </button>
  );
}
