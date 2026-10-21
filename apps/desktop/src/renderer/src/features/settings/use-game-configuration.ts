import {
  patchGameDefaults,
  type GameDefaults,
  type GameDefaultsPatch,
} from "@jointarp/core/shared/game-defaults";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { desktopOrpc } from "../../desktop-rpc";
import { errorMessage } from "../sessions/game-client";
import { speechPlayer, useSpeechSnapshot } from "../tts/use-speech";
import { useRegisterSave, useFlushSettings } from "./AutosaveScope";
import { useConfigurationSaveStatus } from "./ConfigurationSaveStatus";

export interface GameConfigurationProps {
  settings: GameDefaults;
  onSave: (patch: GameDefaultsPatch) => Promise<unknown>;
}

export function useGameConfiguration({ settings, onSave }: GameConfigurationProps, owner: string) {
  const models = useQuery(desktopOrpc.ai.availableModels.queryOptions());
  const catalog = useQuery(desktopOrpc.tts.catalog.queryOptions());
  const connections = useQuery(desktopOrpc.tts.connections.queryOptions());
  const flush = useFlushSettings();
  const playback = useSpeechSnapshot();
  useEffect(() => () => speechPlayer.stop(owner), [owner]);
  const [dialog, setDialog] = useState<"host" | "companion" | null>(null);
  const [pending, setPending] = useState<GameDefaultsPatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef<Promise<boolean> | null>(null);
  const failed = useRef<GameDefaultsPatch | null>(null);
  const current = pending ? patchGameDefaults(settings, pending) : settings;
  const disabled = busy || Boolean(error);
  useConfigurationSaveStatus(error ? "error" : busy ? "saving" : "saved");
  const latestConfig = useRef(current.tts.config);
  latestConfig.current = current.tts.config;
  const previewing = playback.owner === owner && ["loading", "playing"].includes(playback.status);
  async function preview() {
    if (previewing) {
      speechPlayer.stop(owner);
      return;
    }
    if (!(await flush())) return;
    speechPlayer.replace({
      owner,
      key: owner,
      text: "夜色渐深，酒馆的门缓缓打开。一位旅人走进灯火里，你的冒险即将开始。",
      preview: { config: latestConfig.current },
    });
  }
  async function choose(patch: GameDefaultsPatch): Promise<boolean> {
    if (flight.current) await flight.current;
    failed.current = patch;
    setPending(patch);
    setBusy(true);
    setError("");
    const work = (async () => {
      try {
        await onSave(patch);
        failed.current = null;
        setPending(null);
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusy(false);
        flight.current = null;
      }
    })();
    flight.current = work;
    return work;
  }
  async function chooseAfterFlush(patch: GameDefaultsPatch) {
    if (await flush()) await choose(patch);
  }
  useRegisterSave(async () => {
    if (flight.current) await flight.current;
    return failed.current ? choose(failed.current) : true;
  });
  return {
    current,
    onSave,
    busy,
    disabled,
    error,
    models,
    catalog,
    connections,
    dialog,
    setDialog,
    choose,
    chooseAfterFlush,
    preview,
    previewing,
    previewError: playback.owner === owner ? playback.error : undefined,
    stopPreview: () => speechPlayer.stop(owner),
    retry: () => (failed.current ? choose(failed.current) : Promise.resolve(true)),
  };
}

export type GameConfiguration = ReturnType<typeof useGameConfiguration>;
