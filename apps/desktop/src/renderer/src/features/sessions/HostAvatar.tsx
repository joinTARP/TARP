import { useEffect, useId, useRef } from "react";

import styles from "./HostAvatar.module.css";

// 只有鼠标进入过的头像监听后续移动，离远后立即释放监听。
let trackedAvatar: HTMLSpanElement | undefined;
const gazeRadius = 120;
let pointer: { x: number; y: number } | undefined;
let frame: number | undefined;

function resetGaze(avatar: HTMLSpanElement) {
  delete avatar.dataset.tracking;
  avatar.style.removeProperty("--gaze-x");
  avatar.style.removeProperty("--gaze-y");
}

function stopTracking() {
  if (trackedAvatar) resetGaze(trackedAvatar);
  trackedAvatar = undefined;
  pointer = undefined;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  window.removeEventListener("pointermove", followPointer);
  window.removeEventListener("blur", stopTracking);
  window.removeEventListener("pointerout", leaveWindow);
  window.removeEventListener("scroll", scheduleUpdate, true);
}

function updateGaze() {
  frame = undefined;
  const avatar = trackedAvatar;
  if (!pointer || !avatar) return;
  const { x, y } = pointer;
  const bounds = avatar.getBoundingClientRect();
  const dx = x - (bounds.left + bounds.width / 2);
  const dy = y - (bounds.top + bounds.height / 2);
  const distance = Math.hypot(dx, dy);
  if (
    !bounds.width ||
    !bounds.height ||
    bounds.bottom < 0 ||
    bounds.top > window.innerHeight ||
    distance >= gazeRadius
  ) {
    stopTracking();
    return;
  }
  // 最外侧 40px 逐渐收回视线，避免跨过感应边界时突然转头。
  const strength = Math.min(1, (gazeRadius - distance) / 40);
  const divisor = Math.max(bounds.width / 2, distance);
  avatar.style.setProperty("--gaze-x", `${(dx / divisor) * 12 * strength}px`);
  avatar.style.setProperty("--gaze-y", `${(dy / divisor) * 10 * strength}px`);
  avatar.dataset.tracking = "true";
}

function scheduleUpdate() {
  if (frame === undefined) frame = requestAnimationFrame(updateGaze);
}

function leaveWindow(event: PointerEvent) {
  if (!event.relatedTarget) stopTracking();
}

function followPointer(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  scheduleUpdate();
}

function startTracking(avatar: HTMLSpanElement, event: PointerEvent) {
  if (event.pointerType === "touch") return;
  stopTracking();
  trackedAvatar = avatar;
  window.addEventListener("pointermove", followPointer, { passive: true });
  window.addEventListener("blur", stopTracking);
  window.addEventListener("pointerout", leaveWindow);
  window.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true });
  followPointer(event);
}

/** 默认主持人：执行时优先播放思考动画，空闲时平滑注视鼠标。 */
export function HostAvatar({ active }: { active: boolean }) {
  const id = useId();
  const avatarRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const avatar = avatarRef.current;
    return () => {
      if (trackedAvatar === avatar) stopTracking();
    };
  }, []);

  return (
    <span
      ref={avatarRef}
      className={styles.avatar}
      data-active={active}
      aria-hidden="true"
      onPointerEnter={(event) => startTracking(event.currentTarget, event.nativeEvent)}
    >
      <span className={styles.body}>
        <svg viewBox="0 0 100 100" className={styles.die}>
          <defs>
            <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="0.85" y2="1">
              <stop offset="0" stopColor="#fffefa" />
              <stop offset="0.55" stopColor="#e8e7e3" />
              <stop offset="1" stopColor="#969793" />
            </linearGradient>
            <radialGradient id={`${id}-light`} cx="0.3" cy="0.2" r="0.85">
              <stop offset="0" stopColor="white" stopOpacity="0.65" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path
            d="M46 8 Q50 5 54 8 L85 27 Q89 29 89 34 L89 68 Q89 73 85 76 L54 94 Q50 97 46 94 L15 76 Q11 73 11 68 L11 34 Q11 29 15 27 Z"
            fill={`url(#${id}-shell)`}
            stroke="#ffffff"
            strokeOpacity="0.35"
            strokeWidth="0.7"
          />
          <path
            d="M46 8 Q50 5 54 8 L85 27 Q89 29 89 34 L89 68 Q89 73 85 76 L54 94 Q50 97 46 94 L15 76 Q11 73 11 68 L11 34 Q11 29 15 27 Z"
            fill={`url(#${id}-light)`}
          />
          <g className={styles.gaze}>
            <g className={styles.pointerGaze}>
              <g className={styles.eyes} fill="#232522">
                <rect x="37" y="42" width="7" height="15" rx="1.4" />
                <rect x="56" y="42" width="7" height="15" rx="1.4" />
              </g>
            </g>
          </g>
        </svg>
      </span>
    </span>
  );
}
