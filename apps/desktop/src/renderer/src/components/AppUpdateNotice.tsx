import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { desktopOrpc } from "../desktop-rpc";
import { Button } from "./ui/button";
import { useSettingsOverlay } from "./useSettingsOverlay";

export function AppUpdateNotice() {
  const { openSettings, isOpen } = useSettingsOverlay();
  const { data } = useQuery({ ...desktopOrpc.updates.get.queryOptions(), refetchInterval: 5000 });
  const [dismissed, setDismissed] = useState("");
  const notice = `${data?.version}:${data?.state}`;
  if (isOpen || notice === dismissed || (data?.state !== "available" && data?.state !== "ready"))
    return null;
  return (
    <aside
      className="border-border bg-background fixed right-5 bottom-5 z-40 max-w-sm rounded-xl border p-4 shadow-lg"
      aria-label="应用更新"
      role="status"
    >
      <p className="text-sm">
        {data.state === "ready" ? "更新已准备好" : "发现新版本"} · {data.version}
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={openSettings}>
          前往设置
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(notice)}>
          稍后
        </Button>
      </div>
    </aside>
  );
}
