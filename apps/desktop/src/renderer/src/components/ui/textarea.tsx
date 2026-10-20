import { cn } from "cn";
import * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-lg border border-transparent bg-muted px-4 py-3 text-sm leading-relaxed text-foreground outline-none transition-colors duration-150 placeholder:text-muted-foreground enabled:hover:bg-accent/70 focus-visible:border-ring focus-visible:bg-muted disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
