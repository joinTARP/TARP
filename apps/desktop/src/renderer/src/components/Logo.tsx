import { productName } from "@shared/brand";
import { cn } from "cn";
import type { ComponentProps } from "react";

import tarpLogoSource from "../assets/tarp-logo.svg?raw";

export interface LogoPath {
  readonly d: string;
  readonly transform: string;
  /** 字形在 viewBox 中的左边缘，用于按阅读顺序编排动画。 */
  readonly left: number;
}

const [viewBoxX = 0, viewBoxY = 0, viewBoxWidth = 1837, viewBoxHeight = 527] = (
  /viewBox="([^"]+)"/.exec(tarpLogoSource)?.[1] ?? ""
)
  .split(/\s+/)
  .map(Number);

export const logoViewBox = {
  x: viewBoxX,
  y: viewBoxY,
  width: viewBoxWidth,
  height: viewBoxHeight,
} as const;

/** 源 SVG 只含绝对坐标的 M/C/Z 指令，数字按 x、y 成对出现。 */
function minPathX(d: string): number {
  const numbers = d.match(/-?\d*\.?\d+/g) ?? [];
  return Math.min(...numbers.filter((_, index) => index % 2 === 0).map(Number));
}

export const logoPaths: readonly LogoPath[] = Array.from(
  tarpLogoSource.matchAll(/\sd="([^"]+)"[^>]*?\stransform="translate\(([-\d.]+),([-\d.]+)\)"/g),
  ([, d = "", x = "0", y = "0"]) => ({
    d,
    transform: `translate(${x},${y})`,
    left: Number(x) + minPathX(d),
  }),
).sort((left, right) => left.left - right.left);

type LogoProps = Omit<ComponentProps<"svg">, "children" | "viewBox">;

/** 透明背景品牌标识，颜色跟随 currentColor；可通过 className 调整显示尺寸。 */
export function Logo({ className, "aria-label": label = productName, ...props }: LogoProps) {
  return (
    <svg
      viewBox={`${logoViewBox.x} ${logoViewBox.y} ${logoViewBox.width} ${logoViewBox.height}`}
      width={logoViewBox.width}
      height={logoViewBox.height}
      role="img"
      aria-label={label}
      fill="currentColor"
      className={cn("text-foreground block h-auto w-40 max-w-full", className)}
      {...props}
    >
      {logoPaths.map((path) => (
        <path key={path.transform} d={path.d} transform={path.transform} />
      ))}
    </svg>
  );
}
