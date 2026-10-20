import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanionModel } from "@tarp/core/shared/companion";
import {
  defaultCompanionInitiative,
  type CompanionInitiative,
} from "@tarp/core/shared/companion-initiative";
import type { AiConfig } from "@tarp/core/shared/game";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { AiSettingsPanel } from "../settings/AiSettingsPanel";
import { ModelPicker } from "../settings/ModelPicker";
import { CompanionDocumentSettings } from "./CompanionDocumentSettings";
import { CompanionInitiativeSettings } from "./CompanionInitiativeSettings";
import { CompanionVoiceSettings } from "./CompanionVoiceSettings";
import { errorMessage } from "./game-client";

export function CompanionSettingsDialog({
  roomId,
  companionId,
  name,
  model,
  initiative,
  documentAccess = false,
  open,
  onOpenChange,
}: {
  roomId: string;
  companionId: string;
  name: string;
  model?: CompanionModel;
  initiative?: CompanionInitiative;
  documentAccess?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [choosingModel, setChoosingModel] = useState(false);
  const roomOptions = desktopOrpc.sessions.ai.get.queryOptions({ input: { roomId } });
  const room = useQuery({ ...roomOptions, enabled: open });
  const label = modelLabel(model, room.data?.selection?.name, room.isPending, Boolean(room.error));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setChoosingModel(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex h-[min(36rem,85vh)] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>设置{name}</DialogTitle>
          <DialogDescription>修改将在这名队友下次发言时生效。</DialogDescription>
        </DialogHeader>
        {open ? (
          <Tabs
            key={`${roomId}:${companionId}`}
            defaultValue="model"
            className="min-h-0 flex-1 gap-4"
          >
            <TabsList className="w-full shrink-0" aria-label="队友设置">
              <TabsTrigger value="model">模型</TabsTrigger>
              <TabsTrigger value="voice">声音</TabsTrigger>
              <TabsTrigger value="initiative">互动</TabsTrigger>
            </TabsList>
            <TabsContent value="model" className="min-h-0">
              <ScrollAreaPane className="h-full">
                <div className="flex items-center justify-between gap-6">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">模型</h3>
                    <p className="text-muted-foreground mt-1 text-xs leading-5 break-words">
                      {label}
                    </p>
                    {room.error ? (
                      <p role="alert" className="text-destructive mt-1 text-xs">
                        {errorMessage(room.error)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setChoosingModel(true)}
                  >
                    {model ? "更换模型" : "选择模型"}
                  </Button>
                </div>
              </ScrollAreaPane>
            </TabsContent>
            <TabsContent value="voice" keepMounted className="min-h-0">
              <ScrollAreaPane className="h-full">
                <CompanionVoiceSettings roomId={roomId} companionId={companionId} name={name} />
              </ScrollAreaPane>
            </TabsContent>
            <TabsContent value="initiative" keepMounted className="min-h-0">
              <ScrollAreaPane className="h-full">
                <CompanionDocumentSettings
                  roomId={roomId}
                  companionId={companionId}
                  enabled={documentAccess}
                />
                <CompanionInitiativeSettings
                  roomId={roomId}
                  companionId={companionId}
                  initiative={initiative ?? defaultCompanionInitiative}
                />
              </ScrollAreaPane>
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
      <ModelDialog
        roomId={roomId}
        companionId={companionId}
        name={name}
        model={model}
        label={label}
        open={choosingModel}
        onOpenChange={setChoosingModel}
      />
    </Dialog>
  );
}

function ModelDialog({
  roomId,
  companionId,
  name,
  model,
  label,
  open,
  onOpenChange,
}: {
  roomId: string;
  companionId: string;
  name: string;
  model?: CompanionModel;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const companionOptions = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const roomOptions = desktopOrpc.sessions.ai.get.queryOptions({ input: { roomId } });
  const modelsOptions = desktopOrpc.ai.availableModels.queryOptions();
  const room = useQuery({ ...roomOptions, enabled: open });
  const models = useQuery({ ...modelsOptions, enabled: open });
  const [managing, setManaging] = useState(false);
  const select = useMutation({
    mutationFn: (next: AiConfig | null) =>
      next
        ? desktopRpc.sessions.companion.setModel({ roomId, id: companionId, ...next })
        : desktopRpc.sessions.companion.clearModel({ roomId, id: companionId }),
    onSuccess: (value) => {
      client.setQueryData(companionOptions.queryKey, value);
      setManaging(false);
      onOpenChange(false);
    },
  });
  const error = models.error ?? select.error ?? room.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setManaging(false);
        onOpenChange(next);
      }}
    >
      <DialogContent
        overlayClassName="z-[60]"
        className="z-[60] flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>选择{name}的模型</DialogTitle>
          <DialogDescription>未单独选择时使用当前冒险的模型。</DialogDescription>
        </DialogHeader>
        <ScrollAreaPane className="min-h-0 flex-1">
          {managing ? (
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  setManaging(false);
                  void client.invalidateQueries({ queryKey: modelsOptions.queryKey });
                  void client.invalidateQueries({ queryKey: roomOptions.queryKey });
                }}
              >
                返回模型选择
              </Button>
              <AiSettingsPanel embedded />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">当前：{label}</p>
              <ModelPicker
                models={models.data ?? []}
                selection={model ?? null}
                busy={select.isPending}
                loading={models.isPending}
                onSelect={(next) => select.mutate(next)}
                onConnect={() => setManaging(true)}
              />
              <Button
                variant="outline"
                disabled={select.isPending || !model}
                onClick={() => select.mutate(null)}
              >
                跟随冒险模型
              </Button>
              {error ? (
                <div role="alert" className="text-destructive text-sm">
                  {errorMessage(error)}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void room.refetch();
                      void models.refetch();
                      select.reset();
                    }}
                  >
                    重试
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </ScrollAreaPane>
      </DialogContent>
    </Dialog>
  );
}

function modelLabel(
  model: CompanionModel | undefined,
  roomModelName: string | undefined,
  pending: boolean,
  failed: boolean,
) {
  if (model) return `${model.providerName} · ${model.name}`;
  if (failed) return "无法读取冒险模型";
  if (roomModelName) return `跟随冒险 · ${roomModelName}`;
  if (pending) return "正在读取模型…";
  return "跟随冒险模型";
}
