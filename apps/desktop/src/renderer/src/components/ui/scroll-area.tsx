import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "cn";
import type { ReactNode, Ref } from "react";

function ScrollArea({ className, ...props }: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative grid min-h-0 min-w-0 overflow-hidden", className)}
      {...props}
    />
  );
}

function ScrollAreaViewport({ className, ...props }: ScrollAreaPrimitive.Viewport.Props) {
  return (
    <ScrollAreaPrimitive.Viewport
      data-slot="scroll-area-viewport"
      className={cn("h-full min-h-0 w-full min-w-0 focus-visible:outline-none", className)}
      {...props}
    />
  );
}

function ScrollAreaContent({ className, ...props }: ScrollAreaPrimitive.Content.Props) {
  return (
    <ScrollAreaPrimitive.Content
      data-slot="scroll-area-content"
      className={cn("min-w-full", className)}
      {...props}
    />
  );
}

// 默认悬停显示；拖动期间保持可见，特定场景可选择滚动时也显示。
function ScrollAreaScrollbar({
  className,
  orientation = "vertical",
  visibility = "hover",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props & { visibility?: "hover" | "interaction" }) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "pointer-events-none absolute m-px flex justify-center bg-foreground/8 opacity-0 transition-opacity duration-150",
        "data-hovering:pointer-events-auto data-hovering:opacity-100 [&:has(:active)]:pointer-events-auto [&:has(:active)]:opacity-100",
        visibility === "interaction" &&
          "data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-0",
        "data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ScrollAreaThumb({ className, ...props }: ScrollAreaPrimitive.Thumb.Props) {
  return (
    <ScrollAreaPrimitive.Thumb
      data-slot="scroll-area-thumb"
      className={cn(
        "h-full w-full rounded-full bg-ring/60 transition-colors duration-150 hover:bg-ring/85 data-scrolling:bg-ring",
        className,
      )}
      {...props}
    />
  );
}

function ScrollAreaCorner({ className, ...props }: ScrollAreaPrimitive.Corner.Props) {
  return (
    <ScrollAreaPrimitive.Corner
      data-slot="scroll-area-corner"
      className={cn("bg-transparent", className)}
      {...props}
    />
  );
}

/**
 * 常用滚动区域的完整封装。业务组件通常只需要这个组件；底层部件保留给需要
 * 自定义结构的复杂场景。
 */
function ScrollAreaPane({
  children,
  className,
  viewportClassName,
  viewportProps,
  contentClassName,
  viewportRef,
  orientation = "vertical",
  scrollbarVisibility = "hover",
  ...props
}: Omit<ScrollAreaPrimitive.Root.Props, "children"> & {
  children: ReactNode;
  viewportClassName?: string;
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "children" | "className" | "ref">;
  contentClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  orientation?: "vertical" | "horizontal" | "both";
  scrollbarVisibility?: "hover" | "interaction";
}) {
  return (
    <ScrollArea className={className} {...props}>
      <ScrollAreaViewport {...viewportProps} ref={viewportRef} className={viewportClassName}>
        <ScrollAreaContent className={contentClassName}>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      {orientation !== "horizontal" ? (
        <ScrollAreaScrollbar visibility={scrollbarVisibility}>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      ) : null}
      {orientation !== "vertical" ? (
        <ScrollAreaScrollbar orientation="horizontal" visibility={scrollbarVisibility}>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      ) : null}
      {orientation === "both" ? <ScrollAreaCorner /> : null}
    </ScrollArea>
  );
}

export {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  ScrollAreaPane,
};
