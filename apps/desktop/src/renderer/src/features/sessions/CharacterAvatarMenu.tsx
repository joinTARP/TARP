import { ContextMenu } from "@base-ui/react/context-menu";
import { AtSign, ContactRound } from "lucide-react";
import type { ReactNode } from "react";

/** 点击头像打开角色卡，右键保留点名等操作。 */
export function CharacterAvatarMenu({
  name,
  onMention,
  onOpenCard,
  className,
  children,
}: {
  name: string;
  onMention?: () => void;
  onOpenCard: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<button type="button" />}
        onClick={onOpenCard}
        aria-label={`查看${name}的角色卡`}
        title={`查看${name}的角色卡`}
        className={`focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2 ${className ?? ""}`}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[70] outline-none">
          <ContextMenu.Popup
            finalFocus={false}
            className="bg-popover text-popover-foreground ring-foreground/10 min-w-40 rounded-lg p-1 shadow-lg ring-1 outline-none"
          >
            {onMention ? (
              <ContextMenu.Item
                onClick={onMention}
                className="data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none select-none"
              >
                <AtSign className="size-4" aria-hidden="true" />
                {name}
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              onClick={onOpenCard}
              className="data-highlighted:bg-accent data-highlighted:text-accent-foreground flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none select-none"
            >
              <ContactRound className="size-4" aria-hidden="true" />
              查看角色卡
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
