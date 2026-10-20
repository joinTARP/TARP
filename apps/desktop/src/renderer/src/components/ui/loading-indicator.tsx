import { LoaderCircle } from "lucide-react";

export function LoadingIndicator({ label = "正在加载…" }: { readonly label?: string }) {
  return (
    <span role="status" className="text-muted-foreground inline-flex items-center gap-2 text-xs">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      <span>{label}</span>
    </span>
  );
}
