import { cn } from "cn";
import {
  ArrowLeft,
  Bell,
  CodeXml,
  Keyboard,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";

import { NavigationHighlight, NavigationMotion } from "../../components/NavigationMotion";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "../../components/ui/scroll-area";

const NavigationViewport = motion.create(ScrollAreaViewport);

export interface SettingsNavItem {
  readonly enabled: boolean;
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
}
export interface SettingsNavGroup {
  readonly items: readonly SettingsNavItem[];
  readonly label: string;
}
export const settingsNavGroups: readonly SettingsNavGroup[] = [
  {
    label: "个人",
    items: [
      { id: "general", label: "常规", icon: Settings, enabled: true },
      { id: "appearance", label: "外观", icon: Sun, enabled: true },
      { id: "profile", label: "个人资料", icon: UserRound, enabled: false },
    ],
  },
  {
    label: "应用",
    items: [
      { id: "ai", label: "模型配置", icon: Sparkles, enabled: true },
      { id: "game-defaults", label: "冒险默认设置", icon: SlidersHorizontal, enabled: true },
      { id: "tts", label: "语音供应商", icon: Volume2, enabled: true },
      { id: "developer", label: "开发者工具", icon: CodeXml, enabled: true },
      { id: "shortcuts", label: "键盘快捷键", icon: Keyboard, enabled: false },
      { id: "notifications", label: "通知", icon: Bell, enabled: false },
    ],
  },
] as const;
interface SettingsNavigationProps {
  readonly visibleGroups: readonly SettingsNavGroup[];
  readonly searchQuery: string;
  readonly activeSection: string;
  readonly onSearchChange: (value: string) => void;
  readonly onBack: () => void;
  readonly onSelect: (id: string) => void;
}
export function SettingsNavigation({
  visibleGroups,
  searchQuery,
  activeSection,
  onSearchChange,
  onBack,
  onSelect,
}: SettingsNavigationProps) {
  return (
    <aside className="border-border/60 bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col border-r px-3 pt-16 pb-4">
      <Button
        className="text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground mb-4 w-full justify-start gap-2 px-2.5 [-webkit-app-region:no-drag]"
        variant="ghost"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        返回应用
      </Button>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          className="bg-sidebar-accent/60 placeholder:text-muted-foreground/70 focus-visible:bg-sidebar-accent h-9 border-transparent pl-9"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索设置…"
          aria-label="搜索设置"
        />
      </div>
      <nav className="mt-7 min-h-0 flex-1" aria-label="设置导航">
        <NavigationMotion>
          <ScrollArea className="h-full">
            <NavigationViewport layoutScroll>
              <ScrollAreaContent className="space-y-6">
                {visibleGroups.map((group) => (
                  <div key={group.label}>
                    <p className="text-muted-foreground mb-2 px-2 text-xs font-medium">
                      {group.label}
                    </p>
                    <div className="space-y-1">
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.id === activeSection;
                        return (
                          <Button
                            className={cn(
                              "relative h-9 w-full justify-start gap-3 px-2.5 text-sm transition-colors duration-200 motion-reduce:transition-none",
                              isActive
                                ? "text-sidebar-accent-foreground hover:bg-transparent hover:text-sidebar-accent-foreground dark:hover:bg-transparent"
                                : item.enabled
                                  ? "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                                  : "cursor-default text-muted-foreground/45",
                            )}
                            key={item.id}
                            variant="ghost"
                            disabled={!item.enabled}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => onSelect(item.id)}
                          >
                            <NavigationHighlight active={isActive} />
                            <Icon
                              className="relative size-4"
                              strokeWidth={isActive ? 2 : 1.8}
                              aria-hidden="true"
                            />
                            <span className="relative">{item.label}</span>
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </ScrollAreaContent>
            </NavigationViewport>
            <ScrollAreaScrollbar>
              <ScrollAreaThumb />
            </ScrollAreaScrollbar>
          </ScrollArea>
        </NavigationMotion>
      </nav>
    </aside>
  );
}
