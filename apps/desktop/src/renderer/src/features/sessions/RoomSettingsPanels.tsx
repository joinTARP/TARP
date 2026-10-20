import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { useFlushSettings } from "../settings/AutosaveScope";
import { SettingsSection } from "../settings/SettingsSection";
import { CompactionSettings } from "./CompactionSettings";
import { HostVoiceSettings } from "./HostVoiceSettings";
import { roomDisplayMutation } from "./room-display-mutation";
import { RoomConfigurationSettings } from "./RoomConfigurationSettings";
import { RoomModelSettings } from "./RoomModelSettings";
import { RoomModuleSync } from "./RoomModuleSync";
import { RoomSteeringSettings } from "./RoomSteeringSettings";
import { useRoomReplica, useRoomSession } from "./use-room-state";

type RoomSettingsProps = { roomId: string };

export function RoomHostSettings({ roomId }: RoomSettingsProps) {
  const client = useQueryClient();
  const modelOptions = desktopOrpc.sessions.ai.get.queryOptions({ input: { roomId } });
  const model = useQuery({ ...modelOptions, staleTime: 0 });
  const [modelOpen, setModelOpen] = useState(false);
  return (
    <>
      <SettingsSection title="主持模型">
        <Dialog open={modelOpen} onOpenChange={setModelOpen}>
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <h3 id="room-model-heading" className="text-sm font-medium">
                AI 模型
              </h3>
              <p className="text-muted-foreground mt-1 text-xs leading-5 break-words">
                {model.data?.selection?.name ??
                  (model.isPending
                    ? "正在读取模型…"
                    : model.error
                      ? "无法读取当前模型"
                      : "尚未选择模型")}
                {model.data?.selection ? ` · ${model.data.selection.providerName}` : ""}
              </p>
              {model.data?.selection && !model.data.ready ? (
                <p className="text-destructive mt-1 text-xs">连接不可用，请重新配置或选择模型。</p>
              ) : null}
            </div>
            <DialogTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
              {model.data?.selection ? "更换模型" : "选择模型"}
            </DialogTrigger>
          </div>
          {model.error ? (
            <p role="alert" className="text-destructive text-xs">
              {model.error.message}
              <Button variant="ghost" size="sm" onClick={() => void model.refetch()}>
                重试
              </Button>
            </p>
          ) : null}
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
            <DialogHeader className="shrink-0">
              <DialogTitle>冒险模型设置</DialogTitle>
              <DialogDescription className="sr-only">
                选择当前冒险的主持模型，或管理模型服务连接。
              </DialogDescription>
            </DialogHeader>
            <ScrollAreaPane className="min-h-0 flex-1">
              {modelOpen ? (
                <RoomModelSettings
                  key={roomId}
                  roomId={roomId}
                  onSelected={(settings) => {
                    client.setQueryData(modelOptions.queryKey, settings);
                    setModelOpen(false);
                  }}
                />
              ) : null}
            </ScrollAreaPane>
          </DialogContent>
        </Dialog>
      </SettingsSection>
      <RoomConfigurationSettings roomId={roomId} section="host" />
    </>
  );
}

export function RoomChatSettings({ roomId }: RoomSettingsProps) {
  const metrics = useRoomReplica(roomId)?.sections.metrics;
  const [compactionOpen, setCompactionOpen] = useState(false);
  return (
    <>
      <RoomSteeringSettings roomId={roomId} />
      <RoomConfigurationSettings roomId={roomId} section="context" />
      <SettingsSection title="自动压缩">
        <Dialog open={compactionOpen} onOpenChange={setCompactionOpen}>
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <h3 id="compaction-heading" className="text-sm font-medium">
                压缩阈值
              </h3>
              <p className="text-muted-foreground mt-1 text-xs leading-5">
                分别设置主持人与 AI 队友的上下文压缩阈值。
              </p>
            </div>
            <DialogTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
              设置阈值
            </DialogTrigger>
          </div>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
            <DialogHeader className="shrink-0">
              <DialogTitle>自动压缩设置</DialogTitle>
              <DialogDescription>保存后从下一次模型调用起生效。</DialogDescription>
            </DialogHeader>
            <ScrollAreaPane className="min-h-0 flex-1">
              {compactionOpen ? (
                <div className="pb-2">
                  <CompactionSettings
                    roomId={roomId}
                    role="host"
                    contextWindow={metrics?.host.current.contextWindow}
                  />
                  <CompactionSettings roomId={roomId} role="companion" />
                </div>
              ) : null}
            </ScrollAreaPane>
          </DialogContent>
        </Dialog>
      </SettingsSection>
    </>
  );
}

export function RoomVoiceSettings({ roomId }: RoomSettingsProps) {
  const speech = useQuery(desktopOrpc.tts.roomSettings.queryOptions({ input: { roomId } }));
  return (
    <>
      <RoomConfigurationSettings roomId={roomId} section="voice" />
      <HostVoiceSettings roomId={roomId} enabled={speech.data?.enabled === true} />
    </>
  );
}

export function RoomDisplaySettings({ roomId }: RoomSettingsProps) {
  const client = useQueryClient();
  const sessionOptions = desktopOrpc.sessions.load.queryOptions({ input: { id: roomId } });
  const displayOptions = desktopOrpc.sessions.display.get.queryOptions({ input: { roomId } });
  const display = useQuery(displayOptions);
  const displayMutation = useMemo(
    () =>
      roomDisplayMutation(
        client,
        displayOptions.queryKey,
        roomId,
        (patch) => desktopRpc.sessions.display.save({ roomId, ...patch }),
        () => {
          void client.invalidateQueries({ queryKey: sessionOptions.queryKey });
          const channel = new BroadcastChannel("tarp-documents");
          channel.postMessage(roomId);
          channel.close();
        },
      ),
    [client, roomId],
  );
  const saveDisplay = useMutation(displayMutation);
  function toggleDisplay(key: "showReasoning" | "showAllDocuments") {
    const current = client.getQueryData(displayOptions.queryKey);
    if (current) saveDisplay.mutate({ key, value: !current[key] });
  }
  return (
    <>
      <SettingsSection title="信息显示">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-6">
            <div>
              <label
                htmlFor="show-reasoning"
                id="show-reasoning-label"
                className="text-sm font-medium"
              >
                显示推理细节
              </label>
              <p
                id="reasoning-description"
                className="text-muted-foreground mt-1 text-xs leading-5"
              >
                在聊天中查看主持人和 AI 队友的模型推理与工具执行记录，包括队友未发言的回合。
              </p>
            </div>
            <button
              id="show-reasoning"
              type="button"
              role="switch"
              aria-checked={display.data?.showReasoning ?? false}
              aria-labelledby="show-reasoning-label"
              aria-describedby="reasoning-description reasoning-warning"
              disabled={!display.data}
              onClick={() => toggleDisplay("showReasoning")}
              className="bg-input aria-checked:bg-primary focus-visible:outline-ring mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
            >
              <span
                className={`bg-background size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${display.data?.showReasoning ? "translate-x-4" : "translate-x-0"}`}
              />
            </button>
          </div>
          <p
            id="reasoning-warning"
            className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-400"
          >
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            可能剧透隐藏线索与后续剧情。
          </p>
          <p role="status" className="sr-only">
            {saveDisplay.isPending ? "正在保存…" : saveDisplay.isSuccess ? "显示设置已保存" : ""}
          </p>
          {display.error || saveDisplay.error ? (
            <p role="alert" className="text-destructive text-sm">
              保存或读取显示设置失败：{display.error?.message ?? saveDisplay.error?.message}
              <Button variant="ghost" onClick={() => void display.refetch()}>
                重新读取
              </Button>
            </p>
          ) : null}
        </div>
        <div>
          <div className="flex items-center justify-between gap-6">
            <div>
              <label
                htmlFor="debug-documents"
                id="debug-documents-label"
                className="text-sm font-medium"
              >
                调试模式：查看全部模组内容
              </label>
              <p
                id="debug-documents-description"
                className="text-muted-foreground mt-1 text-xs leading-5"
              >
                在本机游戏资料中查看原始字段、幕后内容与未揭示的描述。关闭后恢复玩家视图。
              </p>
            </div>
            <button
              id="debug-documents"
              type="button"
              role="switch"
              aria-checked={display.data?.showAllDocuments ?? false}
              aria-labelledby="debug-documents-label"
              aria-describedby="debug-documents-description"
              disabled={!display.data}
              onClick={() => toggleDisplay("showAllDocuments")}
              className="bg-input aria-checked:bg-primary focus-visible:outline-ring inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50"
            >
              <span
                className={`bg-background size-5 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${display.data?.showAllDocuments ? "translate-x-4" : "translate-x-0"}`}
              />
            </button>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}

export function RoomAdventureManagement({ roomId }: RoomSettingsProps) {
  const flush = useFlushSettings();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sessionOptions = desktopOrpc.sessions.load.queryOptions({ input: { id: roomId } });
  const session = useRoomSession(roomId);
  const [action, setAction] = useState<"end" | "remove" | null>(null);
  const manage = useMutation({
    mutationFn: async (kind: "end" | "remove") => {
      if (!(await flush())) throw new Error("请先修正并保存当前配置。");
      if (kind === "remove") await desktopRpc.sessions.remove({ id: roomId });
      else await desktopRpc.sessions.end({ id: roomId });
    },
    onSuccess: async (_value, kind) => {
      await client.invalidateQueries(desktopOrpc.sessions.list.queryOptions());
      client.removeQueries({ queryKey: sessionOptions.queryKey });
      await navigate({ to: kind === "remove" ? "/" : "/history", replace: true });
    },
  });
  return (
    <>
      <RoomModuleSync roomId={roomId} active={session.data?.room.status === "active"} />
      <SettingsSection title="冒险管理">
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium">结束冒险</p>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              保留聊天、角色和笔记，之后可从历史冒险重新开启。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!session.data || session.data.room.status === "ended"}
            onClick={() => {
              manage.reset();
              setAction("end");
            }}
          >
            结束冒险
          </Button>
        </div>
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium">永久删除</p>
            <p className="text-muted-foreground mt-1 text-xs leading-5">
              删除本机上的聊天、角色、笔记和模组快照，无法恢复。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive shrink-0"
            disabled={!session.data}
            onClick={() => {
              manage.reset();
              setAction("remove");
            }}
          >
            永久删除
          </Button>
        </div>
      </SettingsSection>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !manage.isPending) setAction(null);
        }}
      >
        <DialogContent showCloseButton={!manage.isPending}>
          <DialogHeader>
            <DialogTitle>
              {action === "remove" ? "永久删除这段冒险？" : "结束这段冒险？"}
            </DialogTitle>
            <DialogDescription>
              {action === "remove"
                ? `“${session.data?.room.name ?? "当前冒险"}”的聊天、角色、笔记和模组快照都会从本机删除，此操作无法撤销。`
                : "聊天、角色和笔记都会完整保留。结束后会进入历史冒险，也可以随时重新开启。"}
            </DialogDescription>
          </DialogHeader>
          {manage.error ? (
            <p role="alert" className="text-destructive text-sm">
              操作失败：{manage.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={manage.isPending} onClick={() => setAction(null)}>
              取消
            </Button>
            <Button
              variant={action === "remove" ? "destructive" : "default"}
              disabled={manage.isPending}
              onClick={() => action && manage.mutate(action)}
            >
              {manage.isPending ? "正在处理…" : action === "remove" ? "永久删除" : "结束冒险"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
