import { productName } from "@shared/brand";
import { useIsFetching } from "@tanstack/react-query";
import { useRouterState, type RegisteredRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { motion, useAnimate, useReducedMotion } from "motion/react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Logo, logoPaths, logoViewBox } from "./Logo";

type SplashPhase = "intro" | "handoff" | "done";

interface SplashContextValue {
  readonly phase: SplashPhase;
  readonly registerTarget: (element: HTMLElement | null) => void;
}

const SplashContext = createContext<SplashContextValue>({
  phase: "done",
  registerTarget: () => {},
});

/** 开场动画至少完整播放一遍；之后若数据迟迟未就绪也不会一直挡住界面。 */
const introDurationMs = 2600;
const reducedIntroDurationMs = 500;
const maxWaitMs = 8000;

const glyphStagger = 0.14;
const easeInOut = [0.65, 0, 0.35, 1] as const;
const easeOutExpo = [0.16, 1, 0.3, 1] as const;
const fadeSelector = "[data-splash-fade]";

interface SplashScreenProps {
  readonly router: RegisteredRouter;
  readonly children: ReactNode;
}

/** 启动遮罩：播放标识动画，首屏就绪后把标识平移缩放到侧栏落点，再换成侧栏里的静态标识。 */
export function SplashScreen({ router, children }: SplashScreenProps) {
  const [phase, setPhase] = useState<SplashPhase>("intro");
  const targetRef = useRef<HTMLElement | null>(null);
  const registerTarget = useCallback((element: HTMLElement | null) => {
    targetRef.current = element;
  }, []);
  const handleReady = useCallback(
    () => setPhase((current) => (current === "intro" ? "handoff" : current)),
    [],
  );
  const handleDone = useCallback(() => setPhase("done"), []);
  const context = useMemo(() => ({ phase, registerTarget }), [phase, registerTarget]);

  return (
    <SplashContext value={context}>
      {children}
      {phase === "intro" ? <SplashReadiness router={router} onReady={handleReady} /> : null}
      {phase !== "done" ? (
        <SplashOverlay leaving={phase === "handoff"} targetRef={targetRef} onDone={handleDone} />
      ) : null}
    </SplashContext>
  );
}

/** 只在开场期间订阅路由与请求状态，避免之后每次导航都牵动根组件重渲染。 */
function SplashReadiness({
  router,
  onReady,
}: {
  readonly router: RegisteredRouter;
  readonly onReady: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [introPlayed, setIntroPlayed] = useState(false);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const routerIdle = useRouterState({ router, select: (state) => state.status === "idle" });
  const fetching = useIsFetching();
  const ready = introPlayed && ((routerIdle && fetching === 0) || waitedTooLong);

  useEffect(() => {
    const intro = window.setTimeout(
      () => setIntroPlayed(true),
      reducedMotion ? reducedIntroDurationMs : introDurationMs,
    );
    const fallback = window.setTimeout(() => setWaitedTooLong(true), maxWaitMs);
    return () => {
      window.clearTimeout(intro);
      window.clearTimeout(fallback);
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  return null;
}

/** 侧栏里标识的落点；开场期间保持占位但不可见，开场标识落定后再显示。 */
export function SplashLogoTarget({ className }: { readonly className?: string }) {
  const { phase, registerTarget } = use(SplashContext);
  const hidden = phase !== "done";

  return (
    <div ref={registerTarget} className={cn(hidden && "invisible")}>
      <Logo className={className} aria-hidden={hidden || undefined} />
    </div>
  );
}

interface SplashOverlayProps {
  readonly leaving: boolean;
  readonly targetRef: RefObject<HTMLElement | null>;
  readonly onDone: () => void;
}

function SplashOverlay({ leaving, targetRef, onDone }: SplashOverlayProps) {
  const reducedMotion = useReducedMotion();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const logoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const logo = logoRef.current;
    if (!leaving || !logo) return;

    const from = logo.getBoundingClientRect();
    const to = targetRef.current?.getBoundingClientRect();
    const flight =
      to && to.width > 0
        ? animate(
            logo,
            { x: to.left - from.left, y: to.top - from.top, scale: to.width / from.width },
            { duration: reducedMotion ? 0 : 0.8, ease: easeInOut },
          )
        : animate(logo, { opacity: 0, scale: 0.96 }, { duration: reducedMotion ? 0 : 0.4 });
    const fade = animate(
      fadeSelector,
      { opacity: 0 },
      { duration: reducedMotion ? 0 : 0.55, delay: reducedMotion ? 0 : 0.08, ease: "easeOut" },
    );

    let cancelled = false;
    void Promise.all([flight, fade]).then(() => {
      if (!cancelled) onDone();
    });
    return () => {
      cancelled = true;
      flight.stop();
      fade.stop();
    };
  }, [animate, leaving, onDone, reducedMotion, targetRef]);

  return (
    <div
      ref={scope}
      className="text-foreground fixed inset-0 z-[70] flex flex-col items-center justify-center [-webkit-app-region:drag]"
      role="status"
      aria-label={`${productName} 正在启动`}
    >
      <div
        data-splash-fade=""
        className="bg-background pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <motion.div
          className="absolute top-1/2 left-1/2 size-[min(900px,120vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--foreground)_7%,transparent),transparent)] dark:bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--ring)_16%,transparent),transparent)]"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 2.2, ease: easeOutExpo }}
        />
      </div>
      <div ref={logoRef} className="relative w-[min(440px,48vw)] origin-top-left">
        <AnimatedLogo />
      </div>
      <div data-splash-fade="" className="relative">
        <LoadingTrace />
      </div>
    </div>
  );
}

/** 字形依次描边、填色，最后扫过一道高光。 */
function AnimatedLogo() {
  const reducedMotion = useReducedMotion();
  const id = useId();
  const clipId = `${id}-clip`;
  const shineId = `${id}-shine`;
  const { x, y, width, height } = logoViewBox;
  const shineWidth = width * 0.28;
  const lastGlyphDelay = (logoPaths.length - 1) * glyphStagger;

  return (
    <motion.svg
      viewBox={`${x} ${y} ${width} ${height}`}
      width={width}
      height={height}
      className="block h-auto w-full overflow-visible"
      initial={reducedMotion ? false : { opacity: 0, scale: 0.94, filter: "blur(10px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={{ duration: 1.4, ease: easeOutExpo }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          {logoPaths.map((path) => (
            <path key={path.transform} d={path.d} transform={path.transform} />
          ))}
        </clipPath>
        <linearGradient id={shineId} x1="0" x2="1" y1="0" y2="0.18">
          <stop
            offset="0"
            className="[stop-color:white] dark:[stop-color:var(--ring)]"
            stopOpacity="0"
          />
          <stop
            offset="0.5"
            className="[stop-color:white] dark:[stop-color:var(--ring)]"
            stopOpacity="0.75"
          />
          <stop
            offset="1"
            className="[stop-color:white] dark:[stop-color:var(--ring)]"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>

      {logoPaths.map((path, index) => {
        const delay = index * glyphStagger;
        return (
          <motion.path
            key={path.transform}
            d={path.d}
            transform={path.transform}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={5}
            strokeLinejoin="round"
            initial={reducedMotion ? false : { pathLength: 0, fillOpacity: 0, strokeOpacity: 1 }}
            animate={{ pathLength: 1, fillOpacity: 1, strokeOpacity: 0 }}
            transition={{
              pathLength: { duration: 1.2, delay, ease: easeInOut },
              fillOpacity: { duration: 0.7, delay: 0.85 + delay, ease: "easeOut" },
              strokeOpacity: { duration: 0.5, delay: 1.3 + delay, ease: "easeOut" },
            }}
          />
        );
      })}

      {reducedMotion ? null : (
        <g clipPath={`url(#${clipId})`}>
          <motion.rect
            y={y - height * 0.2}
            width={shineWidth}
            height={height * 1.4}
            fill={`url(#${shineId})`}
            initial={{ x: x - shineWidth }}
            animate={{ x: x + width }}
            transition={{ delay: 1.55 + lastGlyphDelay, duration: 1, ease: [0.45, 0, 0.2, 1] }}
          />
        </g>
      )}
    </motion.svg>
  );
}

/** 标识下方的细线，就绪前一直有光点往复流动。 */
function LoadingTrace() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="bg-foreground/10 relative mt-10 h-px w-40 origin-center overflow-hidden"
      initial={reducedMotion ? false : { scaleX: 0, opacity: 0 }}
      animate={{ scaleX: 1, opacity: 1 }}
      transition={{ delay: 1.2, duration: 0.9, ease: easeOutExpo }}
      aria-hidden="true"
    >
      {reducedMotion ? null : (
        <motion.span
          className="via-foreground/60 absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent to-transparent"
          initial={{ x: "-100%" }}
          animate={{ x: "300%" }}
          transition={{
            delay: 1.8,
            duration: 1.3,
            ease: easeInOut,
            repeat: Infinity,
            repeatDelay: 0.2,
          }}
        />
      )}
    </motion.div>
  );
}
