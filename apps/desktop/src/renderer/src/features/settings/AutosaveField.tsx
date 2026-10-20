import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { errorMessage } from "../sessions/game-client";
import { useRegisterSave } from "./AutosaveScope";
import { useConfigurationSaveStatus } from "./ConfigurationSaveStatus";
import { useSettingsCardLayout } from "./SettingsSection";

export function AutosaveField({
  label,
  value,
  onSave,
  multiline = false,
  maxLength,
  validate,
  hint,
  inputMode = "numeric",
}: {
  label: string;
  value: string;
  onSave: (value: string) => Promise<unknown>;
  multiline?: boolean;
  maxLength?: number;
  validate?: (value: string) => string | undefined;
  hint?: string;
  inputMode?: "text" | "numeric";
}) {
  const id = useId();
  const inline = useSettingsCardLayout() && !multiline;
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const text = draft ?? value;
  const consolidatedStatus = useConfigurationSaveStatus(
    error ? "error" : busy ? "saving" : text !== value ? "dirty" : "saved",
  );
  const latest = useRef({ text, value, onSave, validate });
  latest.current = { text, value, onSave, validate };
  async function commit(): Promise<boolean> {
    if (inFlight.current) await inFlight.current;
    const current = latest.current;
    if (current.text === current.value) return true;
    const invalid = current.validate?.(current.text);
    if (invalid) {
      setError(invalid);
      return false;
    }
    setBusy(true);
    const work = (async () => {
      try {
        await current.onSave(current.text);
        setDraft((previous) => (previous === current.text ? undefined : previous));
        latest.current.value = current.text;
        setError("");
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = work;
    return work;
  }
  useRegisterSave(commit);
  const props = {
    id,
    value: text,
    maxLength,
    "aria-invalid": Boolean(error),
    "aria-describedby": `${id}-status`,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      latest.current.text = event.target.value;
      setDraft(event.target.value);
      setError("");
    },
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      latest.current.text = event.currentTarget.value;
      setDraft(
        event.currentTarget.value === latest.current.value ? undefined : event.currentTarget.value,
      );
      void commit();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.nativeEvent.isComposing &&
        (!multiline || event.ctrlKey || event.metaKey)
      ) {
        event.preventDefault();
        latest.current.text = event.currentTarget.value;
        setDraft(
          event.currentTarget.value === latest.current.value
            ? undefined
            : event.currentTarget.value,
        );
        void commit();
      }
    },
  };
  return (
    <div
      className={
        inline ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2" : "space-y-2"
      }
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {multiline ? (
        <Textarea
          {...props}
          rows={label.includes("主持指令") ? 12 : 3}
          className="field-sizing-fixed resize-y leading-6"
        />
      ) : (
        <Input
          {...props}
          inputMode={inputMode}
          className={inline ? "w-28 text-right tabular-nums" : undefined}
        />
      )}
      <div
        id={`${id}-status`}
        className={`text-muted-foreground text-xs leading-5 ${inline ? "col-span-2" : ""} ${consolidatedStatus && !error && !hint ? "sr-only" : ""}`}
      >
        {error ? (
          <span role="alert" className="text-destructive">
            {error}{" "}
            <Button size="sm" variant="ghost" onClick={() => void commit()}>
              重试
            </Button>
          </span>
        ) : (
          <span role="status">
            {busy
              ? "正在保存…"
              : draft !== undefined && text !== value
                ? "完成输入后自动保存"
                : (hint ?? "已保存")}
          </span>
        )}
      </div>
    </div>
  );
}
