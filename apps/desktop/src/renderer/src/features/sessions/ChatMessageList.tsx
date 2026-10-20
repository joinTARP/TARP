import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Button } from "../../components/ui/button";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import type { ChatTimelineEntry } from "./chat-timeline";

const bottomThreshold = 80;

export interface ChatMessageListHandle {
  scrollToBottom: () => void;
}

export function ChatMessageList({
  ref,
  entries,
  renderMessage,
  hasMore,
  loadingHistory,
  onLoadOlder,
  onBottomChange,
  unread,
  emptyState,
  bottomInset = 0,
}: {
  ref?: Ref<ChatMessageListHandle>;
  entries: ChatTimelineEntry[];
  renderMessage: (entry: ChatTimelineEntry) => ReactNode;
  hasMore: boolean;
  loadingHistory: boolean;
  onLoadOlder: () => void;
  onBottomChange: (atBottom: boolean) => void;
  unread: boolean;
  emptyState: ReactNode;
  /** 浮在列表底部的输入区高度，最新消息贴底时停在它上方。 */
  bottomInset?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const atBottom = useRef(true);
  const reducedMotion = useReducedMotion();
  const followFrame = useRef<number | undefined>(undefined);
  const writtenScrollTop = useRef<number | undefined>(undefined);
  const lastScrollTop = useRef(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const stopFollowing = useCallback(() => {
    if (followFrame.current !== undefined) cancelAnimationFrame(followFrame.current);
    followFrame.current = undefined;
    writtenScrollTop.current = undefined;
  }, []);
  const followBottom = useCallback(() => {
    if (!atBottom.current || !positioned.current || followFrame.current !== undefined) return;
    let previous = performance.now();
    const step = (time: number) => {
      followFrame.current = undefined;
      const element = viewport.current;
      if (!element || !atBottom.current) return;
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      const distance = target - element.scrollTop;
      // 目标随内容高度更新，避免反复启动原生 smooth 滚动造成停顿。
      const amount = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, time - previous) / 65);
      previous = time;
      element.scrollTop = Math.abs(distance) <= 1 ? target : element.scrollTop + distance * amount;
      writtenScrollTop.current = element.scrollTop;
      if (Math.abs(target - element.scrollTop) >= 1)
        followFrame.current = requestAnimationFrame(step);
    };
    followFrame.current = requestAnimationFrame(step);
  }, [reducedMotion]);
  const count = entries.length;
  const getItemKey = useCallback((index: number) => entries[index]!.key, [entries]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => {
      const entry = entries[index];
      if (!entry) return 320;
      if (entry.message.kind === "dice") return 240;
      if (entry.message.kind === "card") return 320;
      return entry.grouped ? 40 : 120;
    },
    overscan: 4,
    // 测量补偿只更新位置和总高度，避免同一批新行反复触发 React 渲染。
    directDomUpdates: true,
    // 下一帧测量避免容器高度更新反复触发 ResizeObserver；滚动独立平滑追随。
    useAnimationFrameWithResizeObserver: true,
    paddingStart: hasMore ? 72 : 8,
    paddingEnd: 12 + bottomInset,
    anchorTo: "end",
    // 保留前插历史的锚定；底部追随统一由帧动画处理，不再逐行硬跳。
    followOnAppend: false,
    scrollEndThreshold: -1,
    onChange: followBottom,
  });
  // 跟随时避免虚拟列表的尺寸补偿和帧动画同时写 scrollTop。
  // 阅读历史时恢复默认补偿，保住视口上方行的测量锚点。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = atBottom.current
    ? () => false
    : undefined;
  const updateBottom = useCallback(
    (value: boolean) => {
      if (atBottom.current === value) return;
      atBottom.current = value;
      if (!value) stopFollowing();
      setAwayFromBottom(!value);
      onBottomChange(value);
    },
    [onBottomChange, stopFollowing],
  );
  const scrollToBottom = useCallback(() => {
    atBottom.current = true;
    setAwayFromBottom(false);
    onBottomChange(true);
    followBottom();
  }, [onBottomChange, followBottom]);
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

  useLayoutEffect(() => {
    if (!count || positioned.current) return;
    positioned.current = true;
    // 初次打开历史直接定位，后续增量才平滑追随。
    virtualizer.scrollToEnd();
  }, [count, virtualizer]);

  useLayoutEffect(() => {
    followBottom();
  }, [bottomInset, entries, followBottom]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    // 消息高度交给虚拟列表测量；输入框或窗口改变视口高度时继续贴底。
    const observer = new ResizeObserver(followBottom);
    observer.observe(element);
    return () => {
      observer.disconnect();
      stopFollowing();
    };
  }, [followBottom, stopFollowing]);

  return (
    <>
      <ScrollAreaPane
        viewportRef={viewport}
        viewportProps={{
          onWheel: (event) => {
            if (event.deltaY < 0) updateBottom(false);
          },
          onTouchStart: () => updateBottom(false),
          onKeyDown: (event) => {
            if (["ArrowUp", "PageUp", "Home"].includes(event.key)) updateBottom(false);
          },
          onScroll: (event) => {
            const element = event.currentTarget;
            const top = element.scrollTop;
            const programmed =
              writtenScrollTop.current !== undefined &&
              Math.abs(top - writtenScrollTop.current) < 1;
            const upwards = top < lastScrollTop.current;
            lastScrollTop.current = top;
            if (programmed) return;
            if (upwards && element.scrollHeight - top - element.clientHeight > 1)
              updateBottom(false);
            else if (element.scrollHeight - top - element.clientHeight <= bottomThreshold) {
              updateBottom(true);
              followBottom();
            }
          },
        }}
        className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:z-30"
        viewportClassName="[scrollbar-gutter:stable] overscroll-contain [overflow-anchor:none]"
        scrollbarVisibility="interaction"
      >
        {!count && !hasMore ? (
          <div
            className="mx-auto w-full max-w-5xl pt-2"
            style={{ paddingBottom: 20 + bottomInset }}
          >
            {emptyState}
          </div>
        ) : (
          <div ref={virtualizer.containerRef} className="relative mx-auto w-full max-w-5xl">
            {hasMore ? (
              // 加载入口不参与消息锚定，位于顶部时也能保住前插前的第一条消息。
              <div className="absolute inset-x-0 top-2 flex h-16 items-center justify-center">
                <Button variant="ghost" size="sm" disabled={loadingHistory} onClick={onLoadOlder}>
                  {loadingHistory ? "正在读取…" : "读取更早的日志"}
                </Button>
              </div>
            ) : null}
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-message-key={item.key}
                // flow-root 把消息和工具卡的外边距纳入测量，防止相邻行重叠。
                className="absolute top-0 left-0 flow-root w-full"
              >
                {renderMessage(entries[item.index])}
              </div>
            ))}
          </div>
        )}
      </ScrollAreaPane>
      {awayFromBottom ? (
        <div className="relative h-0">
          <Button
            className="absolute right-7 z-30 rounded-full shadow-sm"
            style={{ bottom: bottomInset + 8 }}
            variant="secondary"
            size="sm"
            onClick={scrollToBottom}
          >
            <ArrowDown className="size-4" />
            {unread ? "有新消息" : "回到最新"}
          </Button>
        </div>
      ) : null}
    </>
  );
}
