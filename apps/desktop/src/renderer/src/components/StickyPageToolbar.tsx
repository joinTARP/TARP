import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface StickyPageToolbarProps {
  /** 标题区内容，吸顶时整体淡出。 */
  readonly heading: ReactNode;
  /** 右侧常驻操作区，例如搜索框或主操作按钮。 */
  readonly actions?: ReactNode;
  /** 变化时同步清除吸顶外观；必须是稳定原始值（如分类名、视图名），避免每次渲染都重置。 */
  readonly resetKey?: string;
  /** 标题区与吸顶栏内容宽度，默认 max-w-5xl。 */
  readonly widthClassName?: string;
}

/**
 * 页面顶部吸顶工具栏外壳，应用内的长内容页面共用同一套哨兵检测。
 * 上部 48px 自然滚出视口，吸顶后只露出 48px；不改布局高度，避免列表跳动。
 */
function StickyPageToolbar({
  heading,
  actions,
  resetKey,
  widthClassName = "max-w-5xl",
}: StickyPageToolbarProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isPinned, setIsPinned] = useState(false);

  useLayoutEffect(() => {
    // 分类切换会由父容器回到顶部，同步清除吸顶外观，无需等待异步观察回调。
    setIsPinned(false);
  }, [resetKey]);

  useEffect(() => {
    const sentinel = sentinelRef.current!;
    const viewport = sentinel.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // 观察实际滚动容器内的固定哨兵，只在越过吸顶边界时更新，避免逐帧重渲染列表。
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsPinned(entry.boundingClientRect.top < entry.rootBounds!.top);
      },
      { root: viewport, rootMargin: "48px 0px 0px 0px", threshold: 1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} className="pointer-events-none -mb-px h-px" aria-hidden="true" />
      <div
        data-pinned={isPinned}
        className="group data-[pinned=true]:border-border/60 data-[pinned=true]:bg-background/95 sticky -top-12 z-50 h-24 border-b border-transparent transition-[background-color,border-color] duration-300 ease-out data-[pinned=true]:backdrop-blur-xl motion-reduce:transition-none"
      >
        <div
          className={cn(
            "mx-auto flex h-full w-full items-end justify-between gap-5 px-9 pb-2",
            widthClassName,
          )}
        >
          {/* 页头文字属于页面内容，不参与窗口拖拽；窗口移动由顶部全局拖拽条负责。 */}
          <div
            aria-hidden={isPinned}
            className="min-w-0 transition-[opacity,transform] duration-300 ease-out [-webkit-app-region:no-drag] group-data-[pinned=true]:pointer-events-none group-data-[pinned=true]:-translate-y-2 group-data-[pinned=true]:opacity-0 motion-reduce:transition-none"
          >
            {heading}
          </div>
          {actions}
        </div>
      </div>
    </>
  );
}

interface PageToolbarHeaderProps {
  readonly title: ReactNode;
  /** 标题后统计徽章，例如“12 个”“本模组 3 · 官方 200”。 */
  readonly badge?: ReactNode;
  /** 说明行末尾的低干扰辅助入口。 */
  readonly descriptionAccessory?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly resetKey?: string;
  readonly widthClassName?: string;
}

/** 统一页面标题：吸顶工具栏 + 标题徽章 + 辅助说明 + 右侧常驻操作。 */
export function PageToolbarHeader({
  title,
  badge,
  description,
  descriptionAccessory,
  actions,
  resetKey,
  widthClassName,
}: PageToolbarHeaderProps) {
  return (
    <StickyPageToolbar
      resetKey={resetKey}
      widthClassName={widthClassName}
      heading={
        <>
          <div className="flex items-center gap-2.5">
            <h2 className="text-foreground m-0 text-xl font-semibold tracking-[-0.025em]">
              {title}
            </h2>
            {badge ? (
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="text-muted-foreground m-0 mt-2 truncate text-xs leading-5">
              {description}
              {descriptionAccessory}
            </p>
          ) : null}
        </>
      }
      actions={
        actions ? (
          <div className="flex shrink-0 items-end gap-2 self-stretch [-webkit-app-region:no-drag]">
            {actions}
          </div>
        ) : undefined
      }
    />
  );
}
