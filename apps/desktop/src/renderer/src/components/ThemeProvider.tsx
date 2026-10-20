import { appThemeStorageKey, appThemes, defaultAppTheme, type AppTheme } from "@shared/app-config";
import { ThemeProvider as NextThemeProvider, useTheme as useNextTheme } from "next-themes";
import { useEffect, useRef, type ReactNode } from "react";

import { desktopRpc } from "../desktop-rpc";

interface ThemeProviderProps {
  readonly children: ReactNode;
  readonly initialTheme?: AppTheme;
}

function isAppTheme(value: string): value is AppTheme {
  return (appThemes as readonly string[]).includes(value);
}

function PersistTheme({ initialTheme }: { readonly initialTheme: AppTheme }) {
  const { theme } = useNextTheme();
  const lastRequestedTheme = useRef(initialTheme);

  useEffect(() => {
    if (!theme || theme === lastRequestedTheme.current || !isAppTheme(theme)) return;
    // 切回启动主题也需要同步，保持配置文件与页面选择一致。
    lastRequestedTheme.current = theme;
    void desktopRpc.config.update({ theme }).catch((error: unknown) => {
      console.error("保存主题配置失败", error);
    });
  }, [theme]);

  return null;
}

/** 统一 next-themes 配置，主题同步到 ~/.tarp/settings.json。 */
export function ThemeProvider({ children, initialTheme = defaultAppTheme }: ThemeProviderProps) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme={initialTheme}
      enableColorScheme
      enableSystem
      storageKey={appThemeStorageKey}
    >
      <PersistTheme initialTheme={initialTheme} />
      {children}
    </NextThemeProvider>
  );
}

export function useTheme() {
  return useNextTheme();
}
