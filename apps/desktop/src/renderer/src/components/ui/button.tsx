import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ReactNode } from "react";

import { Tooltip } from "./tooltip";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent text-sm leading-none font-medium whitespace-nowrap outline-none select-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive aria-invalid:outline-destructive motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75",
        outline:
          "border-input bg-transparent text-foreground hover:border-foreground/30 hover:bg-muted active:bg-accent aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent active:bg-foreground/15 aria-expanded:bg-accent",
        ghost: "rounded-lg text-foreground hover:bg-muted active:bg-accent aria-expanded:bg-muted",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/15 active:bg-destructive/20 focus-visible:outline-destructive",
        link: "rounded-sm text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 px-3.5 has-[>svg:first-child:not(:only-child)]:pl-3 has-[>svg:last-child:not(:only-child)]:pr-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg:first-child:not(:only-child)]:pl-1.5 has-[>svg:last-child:not(:only-child)]:pr-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-3 text-[0.8rem] has-[>svg:first-child:not(:only-child)]:pl-2.5 has-[>svg:last-child:not(:only-child)]:pr-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-4 has-[>svg:first-child:not(:only-child)]:pl-3.5 has-[>svg:last-child:not(:only-child)]:pr-3.5",
        icon: "size-8 gap-0 rounded-full p-0",
        "icon-xs": "size-6 gap-0 rounded-full p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 gap-0 rounded-full p-0 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-9 gap-0 rounded-full p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  tooltip,
  ...props
}: Omit<ButtonPrimitive.Props, "title"> &
  VariantProps<typeof buttonVariants> & { tooltip?: ReactNode }) {
  const button = (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}

export { Button, buttonVariants };
