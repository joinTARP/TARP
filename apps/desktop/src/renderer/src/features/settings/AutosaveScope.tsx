import { useBlocker } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

type Save = () => Promise<boolean>;
const SaveContext = createContext<{ register: (save: Save) => () => void; flush: Save } | null>(
  null,
);

/** 在分类切换和路由退出前提交表单，保存失败则留在原位置。 */
export function AutosaveScope({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const saves = useRef(new Set<Save>());
  const register = useCallback((save: Save) => {
    saves.current.add(save);
    return () => {
      saves.current.delete(save);
    };
  }, []);
  const flush = useCallback(async () => {
    const results = await Promise.all([...saves.current].map((save) => save()));
    return results.every(Boolean);
  }, []);
  useBlocker({
    disabled: !active,
    enableBeforeUnload: false,
    shouldBlockFn: async () => !(await flush()),
  });
  return <SaveContext value={{ register, flush }}>{children}</SaveContext>;
}
export function useFlushSettings() {
  return useContext(SaveContext)?.flush ?? (async () => true);
}
export function useRegisterSave(save: Save) {
  const scope = useContext(SaveContext);
  const latest = useRef(save);
  latest.current = save;
  useLayoutEffect(() => scope?.register(() => latest.current()), [scope?.register]);
}
