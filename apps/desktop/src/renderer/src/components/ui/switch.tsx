import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "bg-muted data-checked:bg-primary focus-visible:outline-ring inline-flex h-4 w-7 shrink-0 cursor-default items-center rounded-full border border-transparent p-0.5 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="bg-background pointer-events-none size-2.5 rounded-full shadow-sm transition-transform data-checked:translate-x-3 motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}
