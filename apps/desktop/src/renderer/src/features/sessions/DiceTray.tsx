import { cn } from "cn";
import { motion, useReducedMotion, type TargetAndTransition } from "motion/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

/**
 * waiting：等待掷骰，骰子轻微浮动；shaking：握在手里摇晃，点数乱跳；
 * throwing：抛出、弹跳并落定到 values；settled：静止展示结果。
 */
export type DiceTrayPhase = "waiting" | "shaking" | "throwing" | "settled";

const THROW_SECONDS = 1.1;
const REST_SHADOW = { scale: 1, opacity: 1 };

export const DiceTray = memo(function DiceTray({
  sides,
  count,
  values,
  phase,
  onSettled,
  className,
}: {
  sides: number;
  count: number;
  values?: readonly number[];
  phase: DiceTrayPhase;
  /** throwing 阶段所有骰子落定后调用；减弱动效时立即调用。 */
  onSettled?: () => void;
  className?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  const percentile = sides === 100;
  const physical = percentile ? count * 2 : count;
  const size = dieSize(physical);
  // 历史结果只保留静态图形，滚动挂载时无需初始化五层动画和逐帧调度。
  const Die = phase === "settled" || reduced ? RestingDie : TumblingDie;
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  useEffect(() => {
    if (phase !== "throwing") return;
    const seconds = reduced ? 0 : THROW_SECONDS + toss(physical - 1, size).delay;
    const timer = setTimeout(() => settled.current?.(), seconds * 1000);
    return () => clearTimeout(timer);
  }, [phase, physical, size, reduced]);
  return (
    <div
      className={cn(
        "flex flex-wrap items-end gap-y-3",
        percentile ? "gap-x-4" : "gap-x-2",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => {
        const value = values?.[index];
        if (!percentile)
          return (
            <Die
              key={index}
              index={index}
              sides={sides}
              value={value}
              size={size}
              phase={phase}
              reduced={reduced}
            />
          );
        return (
          <div key={index} className="flex items-end gap-0.5">
            {(["tens", "units"] as const).map((digit, offset) => (
              <Die
                key={digit}
                index={index * 2 + offset}
                sides={sides}
                digit={digit}
                value={value}
                size={size}
                phase={phase}
                reduced={reduced}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
});

function dieSize(count: number) {
  if (count === 1) return 64;
  if (count <= 3) return 56;
  if (count <= 6) return 46;
  if (count <= 12) return 38;
  return 32;
}

/** 按骰子序号生成稳定的伪随机数，重渲染时抛物线和落点倾角不会跳变。 */
function noise(index: number, salt: number) {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function toss(index: number, size: number) {
  const direction = noise(index, 3) > 0.5 ? 1 : -1;
  return {
    delay: Math.min(index * 0.06, 0.36),
    reach: Math.min(40, size * (0.45 + noise(index, 1) * 0.4)),
    lift: Math.min(40, size * (0.55 + noise(index, 2) * 0.3)),
    tilt: (noise(index, 4) - 0.5) * 14,
    direction,
    spin: direction * 360 * (noise(index, 5) > 0.6 ? 2 : 1),
  };
}
type Toss = ReturnType<typeof toss>;
type Layer = "travel" | "shadow" | "hop" | "squash" | "spin";

/**
 * 运动中的骰子拆成五层：travel 水平位移（影子跟随），hop 竖直弹跳，squash 触地形变，
 * spin 旋转，shadow 随高度缩放。throwing 结束时 rotate 停在 tilt + 整圈，
 * 落定后用静态图形保持相同倾角，视觉上无跳变。
 */
function choreography(
  phase: DiceTrayPhase,
  t: Toss,
  reduced: boolean,
): Record<Layer, TargetAndTransition> {
  if (reduced || phase === "settled") {
    const instant = { duration: 0 };
    return {
      travel: { x: 0, transition: instant },
      shadow: { ...REST_SHADOW, transition: instant },
      hop: { y: 0, transition: instant },
      squash: { scaleX: 1, scaleY: 1, transition: instant },
      spin: { rotate: t.tilt, transition: instant },
    };
  }
  if (phase === "waiting") {
    const float = {
      duration: 2.4,
      ease: "easeInOut",
      repeat: Infinity,
      delay: t.delay * 2,
    } as const;
    return {
      travel: { x: 0 },
      shadow: { scale: [1, 0.9, 1], opacity: [1, 0.8, 1], transition: float },
      hop: { y: [0, -3, 0], transition: float },
      squash: { scaleX: 1, scaleY: 1 },
      spin: { rotate: t.tilt },
    };
  }
  if (phase === "shaking") {
    const rattle = {
      duration: 0.42,
      ease: "easeInOut",
      repeat: Infinity,
      delay: t.delay / 2,
    } as const;
    return {
      travel: { x: [0, -3, 2, -2, 3, 0], transition: rattle },
      shadow: {
        scale: [1, 0.85, 0.97, 0.83, 0.95, 1],
        opacity: [1, 0.7, 0.9, 0.68, 0.88, 1],
        transition: rattle,
      },
      hop: { y: [0, -6, -1, -7, -2, 0], transition: rattle },
      squash: { scaleX: 1, scaleY: 1 },
      spin: { rotate: [0, -12, 9, -8, 12, 0].map((angle) => t.tilt + angle), transition: rattle },
    };
  }
  const base = { duration: THROW_SECONDS, delay: t.delay };
  // 抬手 → 抛到最高点 → 三次触地，弹跳高度逐次衰减。
  const hopTimes = [0, 0.12, 0.24, 0.44, 0.57, 0.69, 0.77, 0.85, 1];
  const squashTimes = [0, 0.24, 0.42, 0.45, 0.51, 0.67, 0.7, 0.75, 0.84, 0.88, 0.94, 1];
  return {
    travel: {
      x: [null, -t.reach, 0, 0],
      transition: {
        ...base,
        times: [0, 0.12, 0.85, 1],
        ease: ["easeOut", [0.3, 0.5, 0.4, 1], "linear"],
      },
    },
    shadow: {
      scale: [null, 0.7, 0.55, 1, 0.8, 1, 0.93, 1, 1],
      opacity: [null, 0.45, 0.35, 1, 0.65, 1, 0.85, 1, 1],
      transition: { ...base, times: hopTimes },
    },
    hop: {
      y: [null, -0.7 * t.lift, -t.lift, 0, -0.3 * t.lift, 0, -0.1 * t.lift, 0, 0],
      transition: {
        ...base,
        times: hopTimes,
        ease: ["easeOut", "easeOut", "easeIn", "easeOut", "easeIn", "easeOut", "easeIn", "linear"],
      },
    },
    squash: {
      scaleX: [null, 1, 0.95, 1.16, 0.98, 1, 1.07, 1, 1, 1.03, 1, 1],
      scaleY: [null, 1, 1.06, 0.8, 1.04, 1, 0.9, 1, 1, 0.96, 1, 1],
      transition: { ...base, times: squashTimes },
    },
    spin: {
      rotate: [null, t.tilt - t.direction * 18, t.tilt + t.spin],
      transition: { ...base, times: [0, 0.12, 1], ease: ["easeOut", [0.2, 0.65, 0.3, 1]] },
    },
  };
}

interface DieProps {
  index: number;
  sides: number;
  digit?: Digit;
  value?: number;
  size: number;
  phase: DiceTrayPhase;
  reduced: boolean;
}

const shadowClassName =
  "absolute h-[16%] bg-[radial-gradient(closest-side,rgb(0_0_0/0.32),transparent)] dark:bg-[radial-gradient(closest-side,rgb(0_0_0/0.7),transparent)]";

function RestingDie({ index, sides, digit, value, size }: DieProps) {
  const shape = digit ? 10 : sides;
  const [width, ground] = groundOf(shape);
  const { tilt } = toss(index, size);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className={shadowClassName}
        style={{ width: `${width}%`, left: `${50 - width / 2}%`, top: `${ground - 6}%` }}
      />
      <div className="size-full" style={{ transform: `rotate(${tilt}deg)` }}>
        <DieFace sides={shape} label={value === undefined ? undefined : faceLabel(value, digit)} />
      </div>
    </div>
  );
}

function TumblingDie({ index, sides, digit, value, size, phase, reduced }: DieProps) {
  const t = useMemo(() => toss(index, size), [index, size]);
  const face = useFlicker(sides, reduced ? "settled" : phase, t.delay);
  const layers = choreography(phase, t, reduced);
  const shape = digit ? 10 : sides;
  const shown = face ?? value;
  const [width, ground] = groundOf(shape);
  return (
    <motion.div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      initial={{ x: 0 }}
      animate={layers.travel}
    >
      <motion.div
        className={shadowClassName}
        style={{ width: `${width}%`, left: `${50 - width / 2}%`, top: `${ground - 6}%` }}
        initial={REST_SHADOW}
        animate={layers.shadow}
      />
      <motion.div className="size-full" initial={{ y: 0 }} animate={layers.hop}>
        <motion.div
          className="size-full origin-bottom"
          initial={{ scaleX: 1, scaleY: 1 }}
          animate={layers.squash}
        >
          <motion.div className="size-full" initial={{ rotate: t.tilt }} animate={layers.spin}>
            <DieFace
              sides={shape}
              label={shown === undefined ? undefined : faceLabel(shown, digit)}
            />
          </motion.div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** d100 拆成十位骰（00–90）和个位骰（0–9），100 记作 00 + 0。 */
type Digit = "tens" | "units";
function faceLabel(value: number, digit?: Digit) {
  if (digit === "tens") return `${Math.floor((value % 100) / 10)}0`;
  if (digit === "units") return String(value % 10);
  return String(value);
}

/** 摇晃时匀速乱跳；抛出后逐渐变慢，在最后一次小弹跳前停到真实点数。 */
function useFlicker(sides: number, phase: DiceTrayPhase, delay: number) {
  const [face, setFace] = useState<number>();
  const active = phase === "shaking" || phase === "throwing";
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const until = phase === "throwing" ? (delay + THROW_SECONDS * 0.8) * 1000 : Infinity;
    let wait = 60;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (performance.now() - start >= until) return setFace(undefined);
      setFace(1 + Math.floor(Math.random() * sides));
      if (phase === "throwing") wait = Math.min(wait * 1.15, 180);
      timer = setTimeout(tick, wait);
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, phase, sides, delay]);
  return active ? face : undefined;
}

interface Shape {
  body: string;
  face?: string;
  facets?: string;
  label: [number, number];
  font: number;
  /** 接触地面的宽度和 y（含厚度），影子贴着这里铺开。 */
  ground: [number, number];
}

/** viewBox 为 100×100，底部留 4 个单位画厚度。 */
const SHAPES: Record<number, Shape> = {
  4: { body: "50,8 92,84 8,84", label: [50, 62], font: 26, ground: [88, 88] },
  8: {
    body: "50,6 91,48 50,90 9,48",
    face: "50,6 76,62 24,62",
    facets: "M76 62 91 48M76 62 50 90M24 62 9 48M24 62 50 90",
    label: [50, 44],
    ground: [44, 94],
    font: 24,
  },
  10: {
    body: "50,6 91,40 50,92 9,40",
    face: "50,6 76,46 50,64 24,46",
    facets: "M76 46 91 40M24 46 9 40M50 64 50 92",
    label: [50, 40],
    ground: [42, 96],
    font: 24,
  },
  12: {
    body: "50,7 90.9,36.7 75.3,84.8 24.7,84.8 9.1,36.7",
    face: "50,25 73.8,42.3 64.7,70.2 35.3,70.2 26.2,42.3",
    facets:
      "M50 25 50 7M73.8 42.3 90.9 36.7M64.7 70.2 75.3 84.8M35.3 70.2 24.7 84.8M26.2 42.3 9.1 36.7",
    label: [50, 50],
    ground: [62, 89],
    font: 24,
  },
  20: {
    body: "50,8 86.4,29 86.4,71 50,92 13.6,71 13.6,29",
    face: "50,26 76,68 24,68",
    facets:
      "M50 26 50 8M50 26 86.4 29M50 26 13.6 29M76 68 86.4 29M76 68 86.4 71M76 68 50 92M24 68 50 92M24 68 13.6 71M24 68 13.6 29",
    label: [50, 55],
    ground: [50, 96],
    font: 20,
  },
};

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 48]],
  2: [
    [28, 26],
    [72, 70],
  ],
  3: [
    [28, 26],
    [50, 48],
    [72, 70],
  ],
  4: [
    [28, 26],
    [72, 26],
    [28, 70],
    [72, 70],
  ],
  5: [
    [28, 26],
    [72, 26],
    [50, 48],
    [28, 70],
    [72, 70],
  ],
  6: [
    [28, 26],
    [72, 26],
    [28, 48],
    [72, 48],
    [28, 70],
    [72, 70],
  ],
};

/** 厚度层与描边同色，避免和本体描边叠成两道平行线。 */
const EDGE =
  "fill-[color-mix(in_oklab,var(--muted),black_22%)] stroke-[color-mix(in_oklab,var(--muted),black_22%)] dark:fill-[color-mix(in_oklab,var(--muted),black_45%)] dark:stroke-[color-mix(in_oklab,var(--muted),black_45%)]";
const CUBE_EDGE =
  "fill-[color-mix(in_oklab,var(--card),black_16%)] stroke-[color-mix(in_oklab,var(--card),black_16%)] dark:fill-[color-mix(in_oklab,var(--card),black_45%)] dark:stroke-[color-mix(in_oklab,var(--card),black_45%)]";
const BODY = "fill-muted stroke-foreground/60";
const FACE = "fill-card stroke-foreground/25";
const FACET = "fill-none stroke-foreground/25";

/** sides 只决定外形；label 缺省时显示问号。 */
function DieFace({ sides, label = "?" }: { sides: number; label?: string }) {
  const shape = SHAPES[sides];
  const pips = sides === 6 ? PIPS[Number(label)] : undefined;
  return (
    <svg viewBox="0 0 100 100" className="size-full overflow-visible" aria-hidden="true">
      <g strokeLinejoin="round" strokeLinecap="round">
        {sides === 6 ? (
          <>
            <rect
              x="10"
              y="12"
              width="80"
              height="80"
              rx="16"
              className={CUBE_EDGE}
              strokeWidth="3"
            />
            <rect
              x="10"
              y="8"
              width="80"
              height="80"
              rx="16"
              className="fill-card stroke-foreground/60"
              strokeWidth="3"
            />
          </>
        ) : shape ? (
          <>
            <polygon
              points={shape.body}
              transform="translate(0 4)"
              className={EDGE}
              strokeWidth="3"
            />
            <polygon points={shape.body} className={BODY} strokeWidth="3" />
            {shape.face ? <polygon points={shape.face} className={FACE} strokeWidth="1.5" /> : null}
            {shape.facets ? <path d={shape.facets} className={FACET} strokeWidth="1.5" /> : null}
          </>
        ) : (
          <>
            <circle cx="50" cy="52" r="42" className={EDGE} strokeWidth="3" />
            <circle cx="50" cy="48" r="42" className={BODY} strokeWidth="3" />
            <circle cx="50" cy="48" r="31" className={FACE} strokeWidth="1.5" />
          </>
        )}
      </g>
      {pips ? (
        pips.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="7.5" className="fill-foreground" />
        ))
      ) : (
        <text
          x={shape?.label[0] ?? 50}
          y={shape?.label[1] ?? 48}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize(shape?.font ?? (sides === 6 ? 40 : 28), label.length)}
          className="fill-foreground font-semibold tabular-nums"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

function groundOf(sides: number): [number, number] {
  if (sides === 6) return [88, 92];
  return SHAPES[sides]?.ground ?? [54, 94];
}

function fontSize(base: number, digits: number) {
  if (digits <= 2) return base;
  return base * (digits === 3 ? 0.78 : 0.62);
}
