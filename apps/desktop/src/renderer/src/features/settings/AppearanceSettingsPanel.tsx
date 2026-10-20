import { productName } from "@shared/brand";
import { cn } from "cn";
import { Check } from "lucide-react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { ThemePreview, type ThemeChoice } from "./ThemePreview";
interface AppearanceSettingsPanelProps {
  readonly theme: ThemeChoice | undefined;
  readonly currentThemeLabel: string;
  readonly themeOptions: readonly {
    readonly id: ThemeChoice;
    readonly label: string;
    readonly description: string;
  }[];
  readonly onThemeChange: (theme: ThemeChoice) => void;
}
export function AppearanceSettingsPanel({
  theme,
  currentThemeLabel,
  themeOptions,
  onThemeChange,
}: AppearanceSettingsPanelProps) {
  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-4xl"
        title="外观"
        description={`调整 ${productName} 的颜色主题，让工作区适合你的创作环境。`}
      />
      <div className="mx-auto w-full max-w-4xl px-9">
        <section className="mt-12" aria-labelledby="theme-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 id="theme-heading" className="text-base font-semibold">
                主题
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">选择应用使用的颜色主题。</p>
            </div>
            <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs">
              当前：{currentThemeLabel}
            </span>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {themeOptions.map((option) => {
              const isSelected = theme === option.id;
              return (
                <button
                  className={cn(
                    "group rounded-xl border p-2 text-left outline-none transition-colors focus-visible:outline-1 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none",
                    isSelected
                      ? "border-ring bg-accent/30"
                      : "border-border bg-card hover:border-ring/60 hover:bg-card/80",
                  )}
                  key={option.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onThemeChange(option.id)}
                >
                  <ThemePreview choice={option.id} />
                  <div className="px-2 pt-3 pb-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{option.label}</p>
                      <span aria-hidden="true" className="flex size-4 items-center justify-center">
                        {isSelected ? <Check className="size-3.5" /> : null}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">{option.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}
