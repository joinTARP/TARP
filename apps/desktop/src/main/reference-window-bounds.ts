export interface WindowRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const referenceWindowSize = { width: 880, height: 760 } as const;

/** 优先用上次的位置；换了屏幕就贴着游戏房右边打开。 */
export function placeReferenceWindow(
  saved: WindowRectangle | null,
  parent: WindowRectangle | null,
  workArea: WindowRectangle,
): WindowRectangle {
  const width = clamp(saved?.width ?? referenceWindowSize.width, 720, workArea.width);
  const height = clamp(saved?.height ?? referenceWindowSize.height, 560, workArea.height);
  if (saved && overlapsWorkArea({ ...saved, width, height }, workArea)) {
    return { x: saved.x, y: saved.y, width, height };
  }
  const x = parent
    ? parent.x + parent.width + 16 + width <= workArea.x + workArea.width
      ? parent.x + parent.width + 16
      : workArea.x + Math.max(0, workArea.width - width)
    : workArea.x + Math.max(0, Math.round((workArea.width - width) / 2));
  const y = parent
    ? clamp(parent.y, workArea.y, workArea.y + Math.max(0, workArea.height - height))
    : workArea.y + Math.max(0, Math.round((workArea.height - height) / 2));
  return { x, y, width, height };
}

function overlapsWorkArea(bounds: WindowRectangle, workArea: WindowRectangle): boolean {
  return (
    bounds.x < workArea.x + workArea.width - 80 &&
    bounds.x + bounds.width > workArea.x + 80 &&
    bounds.y < workArea.y + workArea.height - 80 &&
    bounds.y + bounds.height > workArea.y + 40
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
