import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-transparent bg-muted px-4 py-1 text-sm text-foreground outline-none transition-colors duration-150 file:mr-3 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground enabled:hover:bg-accent/70 focus-visible:border-ring focus-visible:bg-muted disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
