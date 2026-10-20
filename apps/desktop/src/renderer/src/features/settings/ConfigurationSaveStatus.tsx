import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";

type SaveStatus = "saved" | "dirty" | "saving" | "error";
const ReportContext = createContext<((id: string, status: SaveStatus | null) => void) | null>(null);
const StatusContext = createContext<SaveStatus>("saved");

/** 同时汇总选择项和文本输入；任一字段失败时优先展示失败状态。 */
export function ConfigurationSaveStatusProvider({ children }: { children: ReactNode }) {
  const [fields, setFields] = useState(new Map<string, SaveStatus>());
  const report = useCallback((id: string, status: SaveStatus | null) => {
    setFields((previous) => {
      if (previous.get(id) === (status ?? undefined)) return previous;
      const next = new Map(previous);
      if (status === null) next.delete(id);
      else next.set(id, status);
      return next;
    });
  }, []);
  const states = [...fields.values()];
  const status = states.includes("error")
    ? "error"
    : states.includes("saving")
      ? "saving"
      : states.includes("dirty")
        ? "dirty"
        : "saved";
  return (
    <ReportContext value={report}>
      <StatusContext value={status}>{children}</StatusContext>
    </ReportContext>
  );
}

export function useConfigurationSaveStatus(status: SaveStatus) {
  const report = useContext(ReportContext);
  const id = useId();
  useEffect(() => {
    report?.(id, status);
  }, [report, id, status]);
  useEffect(() => () => report?.(id, null), [report, id]);
  return report !== null;
}

export function ConfigurationSaveStatus() {
  const status = useContext(StatusContext);
  return (
    <p
      role="status"
      className={`mb-2 flex items-center gap-2 text-xs ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${status === "saved" ? "bg-emerald-600 dark:bg-emerald-400" : status === "error" ? "bg-destructive" : "bg-current"}`}
      />
      {status === "error"
        ? "保存失败，请重试"
        : status === "saving"
          ? "正在保存…"
          : status === "dirty"
            ? "待保存"
            : "已保存"}
    </p>
  );
}
