import { useEffect, type RefObject } from "react";

import type { MentionFieldHandle } from "./MentionField";

const editingTarget =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"]';
// @ 候选属于 composer，自身不阻止继续输入。
const focusLayer =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not(#chat-mentions)';

/** 聊天可见时直接输入；其他编辑控件与弹层保留自己的键盘行为。 */
export function useComposerFocus(
  field: RefObject<MentionFieldHandle | null>,
  enabled: boolean,
  toggleMode?: () => void,
) {
  useEffect(() => {
    if (!enabled) return;

    function hasFocusLayer() {
      return [...document.querySelectorAll<HTMLElement>(focusLayer)].some(
        (element) => element.getClientRects().length > 0 && !element.closest("[data-ending-style]"),
      );
    }

    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active.closest(editingTarget) || hasFocusLayer())
        return;
      field.current?.focus();
    });

    function keydown(event: KeyboardEvent) {
      const paste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
      if (event.defaultPrevented || event.altKey || ((event.ctrlKey || event.metaKey) && !paste))
        return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest(editingTarget) || hasFocusLayer())
        return;
      if (event.key === "Tab" && event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!event.repeat) toggleMode?.();
        return;
      }
      // 保留按钮与链接的键盘空格激活；Esc、Tab、Enter 和方向键不重定向。
      if (event.key === " " && target.closest('button, a, [role="button"]')) return;
      if (paste || event.key.length === 1 || event.key === "Process" || event.keyCode === 229)
        field.current?.focus();
    }

    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
    };
  }, [field, enabled, toggleMode]);
}
