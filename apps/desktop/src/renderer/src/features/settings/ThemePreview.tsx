import { cn } from "cn";
import type { ReactNode } from "react";
export type ThemeChoice = "system" | "light" | "dark";
export function ThemePreview({ choice }: { readonly choice: ThemeChoice }) {
  if (choice === "system")
    return (
      <div
        className="relative h-32 overflow-hidden rounded-lg border border-zinc-300 bg-zinc-200"
        aria-hidden="true"
      >
        <div className="grid h-full grid-cols-2">
          <div className="bg-zinc-300" />
          <div className="bg-zinc-700" />
        </div>
        <PreviewPanel className="absolute inset-x-3 bottom-3 grid grid-cols-2 overflow-hidden border-zinc-300 shadow-sm">
          <PreviewPanelLines tone="light" />
          <PreviewPanelLines tone="dark" />
        </PreviewPanel>
      </div>
    );
  const isLight = choice === "light";
  return (
    <div
      className={cn(
        "relative h-32 overflow-hidden rounded-lg border p-3",
        isLight ? "border-zinc-200 bg-zinc-100" : "border-zinc-700 bg-zinc-900",
      )}
      aria-hidden="true"
    >
      <div
        className={cn("mx-auto h-2 w-1/2 rounded-full", isLight ? "bg-zinc-300" : "bg-zinc-600")}
      />
      <PreviewPanel
        className={cn(
          "absolute inset-x-3 bottom-3 overflow-hidden",
          isLight ? "border-zinc-200 bg-white" : "border-zinc-700 bg-zinc-800",
        )}
      >
        <PreviewPanelLines tone={isLight ? "light" : "dark"} />
      </PreviewPanel>
    </div>
  );
}
function PreviewPanel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={cn("h-16 rounded-md border", className)}>{children}</div>;
}
function PreviewPanelLines({ tone }: { readonly tone: "dark" | "light" }) {
  const isLight = tone === "light";
  return (
    <div className="space-y-2 p-2">
      <div className={cn("h-1.5 w-1/2 rounded-full", isLight ? "bg-zinc-300" : "bg-zinc-600")} />
      <div className={cn("h-1 w-full rounded-full", isLight ? "bg-zinc-200" : "bg-zinc-700")} />
      <div className={cn("h-1 w-4/5 rounded-full", isLight ? "bg-zinc-200" : "bg-zinc-700")} />
    </div>
  );
}
