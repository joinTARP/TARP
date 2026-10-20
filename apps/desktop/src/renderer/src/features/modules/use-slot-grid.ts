import { useLayoutEffect, useRef, useState } from "react";

/** 槽位均分容器宽度，增加列数以保证每格不超过 70px；空余列不折叠。 */
export function useSlotGrid() {
  const ref = useRef<HTMLUListElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => setColumns(Math.max(1, Math.ceil((width + 4) / 74)));
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } };
}
