import { LayoutGroup, MotionConfig, motion } from "motion/react";
import { useId, type ReactNode } from "react";

/** 每组菜单独立共享选中背景，并遵循系统的减少动态效果设置。 */
export function NavigationMotion({ children }: { readonly children: ReactNode }) {
  const navigationId = useId();

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={navigationId}>{children}</LayoutGroup>
    </MotionConfig>
  );
}

export function NavigationHighlight({ active }: { readonly active: boolean }) {
  return active ? (
    <motion.span
      layoutId="navigation-active"
      className="bg-sidebar-accent ring-foreground/5 pointer-events-none absolute inset-0 rounded-lg ring-1 ring-inset"
      initial={false}
      transition={{ type: "spring", stiffness: 520, damping: 42 }}
      aria-hidden="true"
    />
  ) : null;
}
