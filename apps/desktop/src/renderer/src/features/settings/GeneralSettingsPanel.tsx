import { FolderOpen } from "lucide-react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { PlayerSettings } from "./PlayerSettings";
interface GeneralSettingsPanelProps {
  readonly modulesPath: string | null;
  readonly busy: boolean;
  readonly isDefaultPath: boolean;
  readonly error: string | null;
  readonly onPick: () => void;
  readonly onReset: () => void;
}
export function GeneralSettingsPanel({
  modulesPath,
  busy,
  isDefaultPath,
  error,
  onPick,
  onReset,
}: GeneralSettingsPanelProps) {
  return (
    <>
      <PageToolbarHeader
        widthClassName="max-w-4xl"
        title="常规"
        description="设置玩家昵称和模组文件的默认保存位置。"
      />
      <div className="mx-auto w-full max-w-4xl px-9">
        <PlayerSettings />
        <section className="mt-12" aria-labelledby="modules-path-heading">
          <div>
            <h2 id="modules-path-heading" className="text-base font-semibold">
              模组保存路径
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              默认在系统「文档」目录下的 tarp/modules。首页会列出该目录里的模组。
            </p>
          </div>
          <div className="border-border bg-card mt-5 rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <div className="bg-accent text-ring grid size-10 shrink-0 place-items-center rounded-lg">
                <FolderOpen className="size-4" strokeWidth={1.7} aria-hidden="true" />
              </div>
              <p className="min-w-0 flex-1 pt-2 font-mono text-sm break-all">
                {modulesPath ?? "正在读取…"}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button className="[-webkit-app-region:no-drag]" disabled={busy} onClick={onPick}>
                选择文件夹
              </Button>
              <Button
                className="[-webkit-app-region:no-drag]"
                disabled={busy || isDefaultPath}
                variant="outline"
                onClick={onReset}
              >
                恢复默认
              </Button>
            </div>
          </div>
          {error ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </>
  );
}
