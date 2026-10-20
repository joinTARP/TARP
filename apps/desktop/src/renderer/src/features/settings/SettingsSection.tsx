import { createContext, useContext, useId, type ReactNode } from "react";

const CardLayoutContext = createContext(false);

/** 由设置容器选择呈现方式，字段和保存逻辑保持共用。 */
export function SettingsCardLayout({ children }: { children: ReactNode }) {
  return (
    <CardLayoutContext value={true}>
      <div className="space-y-7">{children}</div>
    </CardLayoutContext>
  );
}

export function useSettingsCardLayout() {
  return useContext(CardLayoutContext);
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const cards = useSettingsCardLayout();
  const headingId = useId();
  if (!cards) {
    return (
      <section
        aria-labelledby={headingId}
        className="border-border/60 space-y-5 border-t py-6 first:border-t-0 first:pt-0"
      >
        <div>
          <h3 id={headingId} className="text-base font-semibold">
            {title}
          </h3>
          {description ? (
            <p className="text-muted-foreground mt-1 text-xs leading-5">{description}</p>
          ) : null}
        </div>
        <div className="[&>div+div]:border-border/40 space-y-5 [&>div+div]:border-t [&>div+div]:pt-5">
          {children}
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="space-y-2.5">
      <h3 id={headingId} className="text-muted-foreground px-1 text-[13px] font-medium">
        {title}
      </h3>
      <div className="bg-muted/60 border-border/35 space-y-5 rounded-2xl border p-5">
        {description ? (
          <p className="text-muted-foreground text-xs leading-5">{description}</p>
        ) : null}
        <div className="space-y-6">{children}</div>
      </div>
    </section>
  );
}
