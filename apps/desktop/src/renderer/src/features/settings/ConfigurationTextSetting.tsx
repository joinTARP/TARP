import { useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { AutosaveField } from "./AutosaveField";
import { useFlushSettings } from "./AutosaveScope";

/** 长文本在设置页仅展示摘要，关闭编辑器前必须成功提交输入。 */
export function ConfigurationTextSetting({
  summary,
  description,
  disabled,
  generation,
  children,
  ...field
}: ComponentProps<typeof AutosaveField> & {
  summary: string;
  description: string;
  disabled: boolean;
  generation?: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const flush = useFlushSettings();
  async function close() {
    if (closing) return;
    setClosing(true);
    try {
      if (await flush()) setOpen(false);
    } finally {
      setClosing(false);
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{field.label}</p>
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">{summary}</p>
        </div>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
          编辑
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
      >
        <DialogContent overlayClassName="z-[110]" className="z-[120] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{field.label}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <AutosaveField key={generation} {...field} multiline />
          <DialogFooter>
            {children}
            <Button disabled={closing} onClick={() => void close()}>
              {closing ? "正在保存…" : "完成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
