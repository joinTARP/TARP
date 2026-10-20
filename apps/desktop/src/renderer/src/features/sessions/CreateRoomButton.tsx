import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Play } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldError, FieldLabel, Form } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { desktopOrpc, desktopRpc, queryClient } from "../../desktop-rpc";

export function CreateRoomButton({
  modulePath,
  moduleName,
  disabled = false,
  className,
}: {
  modulePath: string;
  moduleName: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${moduleName} · 冒险`);
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => desktopRpc.sessions.create({ modulePath, name: name.trim() }),
    onSuccess: async (room) => {
      setOpen(false);
      await queryClient.invalidateQueries(desktopOrpc.sessions.list.queryOptions());
      await navigate({ to: "/game/$roomId", params: { roomId: room.id } });
    },
  });
  return (
    <>
      <Button
        variant="default"
        className={cn("h-8 gap-1.5 rounded-lg px-3 text-xs", className)}
        disabled={disabled}
        onClick={() => {
          create.reset();
          setOpen(true);
        }}
      >
        <Play className="size-3.5 fill-current" />
        开始
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!create.isPending) setOpen(next);
        }}
      >
        <DialogContent
          className="gap-6 rounded-2xl p-6 sm:max-w-md"
          showCloseButton={!create.isPending}
        >
          <DialogHeader>
            <DialogTitle>新的冒险</DialogTitle>
            <DialogDescription>使用「{moduleName}」创建一段独立保存的冒险。</DialogDescription>
          </DialogHeader>
          <Form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!create.isPending) create.mutate();
            }}
          >
            <Field
              name="name"
              className="space-y-2 text-sm"
              validate={(value) => (String(value ?? "").trim() ? null : "请填写冒险名称。")}
            >
              <FieldLabel>冒险名称</FieldLabel>
              <Input
                autoFocus
                aria-required
                maxLength={80}
                className="h-10"
                value={name}
                disabled={create.isPending}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError />
            </Field>
            {create.error ? (
              <p role="alert" className="text-destructive text-sm">
                {create.error.message}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={create.isPending}>
              {create.isPending ? "正在准备冒险…" : "创建并进入冒险"}
            </Button>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
