import { Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { AppSidebar, type AppSection } from "./AppSidebar";
import { SidebarToggle } from "./SidebarToggle";
import { ScrollAreaPane } from "./ui/scroll-area";

const sectionTitles: Record<AppSection, string> = {
  home: "首页",
  history: "历史冒险",
  modules: "模组库",
};

/** 主导航共用持久布局，菜单切换只更新正文并保留侧栏状态。 */
export function AppShell() {
  const section = useRouterState({
    select: (state): AppSection => {
      const path = state.matches.at(-1)?.fullPath;
      return path === "/history" ? "history" : path === "/modules" ? "modules" : "home";
    },
  });
  const [collapsed, setCollapsed] = useState(false);

  return (
    <main className="bg-background text-foreground relative flex h-full min-h-0 w-full overflow-hidden">
      <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
      {!collapsed ? <AppSidebar activeSection={section} /> : null}
      <div className="min-h-0 min-w-0 flex-1" role="region" aria-labelledby="page-title">
        <ScrollAreaPane
          key={section}
          className="h-full"
          viewportClassName="px-8 pt-16 pb-16 lg:px-12"
        >
          <div className="mx-auto w-full max-w-5xl">
            <h1
              id="page-title"
              className={
                section === "home" ? "sr-only" : "mb-8 text-2xl font-semibold tracking-tight"
              }
            >
              {sectionTitles[section]}
            </h1>
            <Outlet />
          </div>
        </ScrollAreaPane>
      </div>
    </main>
  );
}
