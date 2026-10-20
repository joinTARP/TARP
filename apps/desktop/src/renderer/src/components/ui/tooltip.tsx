import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delay={500}>{children}</TooltipPrimitive.Provider>;
}

/** 提示不增加布局节点；需要操作的内容使用预览卡或弹窗。 */
export function Tooltip({
  content,
  children,
  overflowOnly = false,
  ref,
  ...triggerProps
}: Omit<TooltipPrimitive.Trigger.Props, "children" | "render" | "content" | "ref"> & {
  content: ReactNode;
  children: ReactElement;
  overflowOnly?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const describedBy =
    [
      triggerProps["aria-describedby"],
      (children.props as { "aria-describedby"?: string })["aria-describedby"],
      open ? id : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const trigger = useRef<HTMLElement | null>(null);
  const setTrigger = useCallback(
    (element: HTMLElement | null) => {
      trigger.current = element;
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    },
    [ref],
  );
  return (
    <TooltipPrimitive.Root
      disabled={!content}
      open={open}
      onOpenChange={(next) => {
        const element = trigger.current;
        const text = element?.querySelector<HTMLElement>("[data-overflow-text]") ?? element;
        if (
          !next ||
          !overflowOnly ||
          (text && (text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight))
        )
          setOpen(next);
      }}
    >
      <TooltipPrimitive.Trigger
        {...triggerProps}
        aria-describedby={describedBy}
        render={children}
        ref={setTrigger}
        delay={500}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner sideOffset={6} className="z-[150]">
          <TooltipPrimitive.Popup
            id={id}
            role="tooltip"
            className="border-border/70 bg-popover text-popover-foreground max-w-[min(24rem,calc(100vw-2rem))] rounded-lg border px-2.5 py-1.5 text-xs leading-5 break-words shadow-md transition-opacity duration-100 outline-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
