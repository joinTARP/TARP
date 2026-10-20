import { isAbsolute, join } from "node:path";

import { modulePreviewHash } from "@jointarp/module-cli/commands";
import { NativeMessagePort, type NativeBridge } from "@shared/native-bridge";
import { ChatService, createPiRuntime } from "@tarp/core/node";
import { narrationGapMs } from "@tarp/core/shared/narration";
import Electrobun, { BrowserView, Utils } from "electrobun/main";

import { readAppConfig, resolveAppConfigLocation } from "./config/app-config";
import { acquireDesktopInstance } from "./desktop-instance";
import { configureApplicationMenu } from "./desktop-menu";
import { createDesktopRpcHandler } from "./desktop-rpc";
import { LocalGameSettings } from "./game/local-settings";
import { RoomAiSettingsStore } from "./game/room-ai-settings";
import { SubscriptionAuth } from "./game/subscription-auth";
import { PlaytestService } from "./mcp/playtest";
import { McpService } from "./mcp/service";
import { createMediaServer } from "./media-protocol";
import {
  configureDesktopWindows,
  createDesktopWindow,
  focusedWindow,
  isWindowOpen,
  loadWindow,
  showWindow,
  windowStates,
  type DesktopWindow,
} from "./native-window";
import {
  closeAllModuleReferences,
  closeModuleReference,
  configureReferenceWindows,
  flushReferenceWindowState,
} from "./reference-window";
import { LocalSessionLifecycle } from "./sessions/local-session-lifecycle";
import { TtsService } from "./tts/service";
import { openHttpLink } from "./window-security";

export async function startDesktop(modulePath?: string): Promise<void> {
  let mainWindow: DesktopWindow | null = null;
  let shuttingDown = false;
  let startupAnimationPending = true;
  const configLocation = resolveAppConfigLocation();
  let pendingPreview = modulePath;
  let initialized = false;
  const instance = await acquireDesktopInstance(configLocation.directory, modulePath, (path) => {
    if (path && isAbsolute(path)) pendingPreview = path;
    if (!initialized) return;
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow();
    else {
      if (path && isAbsolute(path)) loadWindow(mainWindow, modulePreviewHash(path));
      showWindow(mainWindow);
    }
  });
  if (!instance) {
    process.exit(0);
  }

  await readAppConfig(configLocation.filePath);
  const media = createMediaServer();
  const gameSettings = new LocalGameSettings(configLocation.directory);
  const subscriptionAuth = new SubscriptionAuth(
    () => gameSettings.modelRuntime(),
    async (url) => {
      if (!(await openHttpLink(url, Utils.openExternal))) throw new Error("无法打开登录页面");
    },
  );
  const tts = new TtsService(configLocation.directory);
  const sessionsRoot = join(configLocation.directory, "sessions");
  const roomAi = new RoomAiSettingsStore(sessionsRoot, gameSettings);
  const chat = new ChatService(
    sessionsRoot,
    createPiRuntime({ modelRuntime: () => gameSettings.modelRuntime() }),
    (roomId, selection) => roomAi.credentials(roomId, selection),
    { narrationGap: narrationGapMs },
  );
  const sessionLifecycle = new LocalSessionLifecycle(sessionsRoot, chat, closeModuleReference);
  function showRoom(roomId?: string | null) {
    if (shuttingDown) return;
    const hash = roomId ? `/game/${roomId}` : "/";
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow(hash);
    else {
      loadWindow(mainWindow, hash);
      showWindow(mainWindow);
    }
  }
  const mcp = new McpService({
    directory: configLocation.directory,
    copyText: Utils.clipboardWriteText,
    createPlaytest: () =>
      new PlaytestService({
        root: sessionsRoot,
        chat,
        player: () => gameSettings.player(),
        defaults: () => gameSettings.defaults(),
        showRoom,
      }),
  });
  const handler = createDesktopRpcHandler();
  configureDesktopWindows((window) => {
    let port: NativeMessagePort | undefined;
    const rpc = BrowserView.defineRPC<NativeBridge>({
      handlers: {
        requests: {
          bootstrap: () => {
            // 页面刷新关闭上一条连接，释放房间订阅与在途请求。
            port?.close();
            port = new NativeMessagePort((packet) => rpc.send.orpc(packet));
            handler.upgrade(port, {
              context: async () => ({
                configFilePath: configLocation.filePath,
                sessionsRoot,
                sessionLifecycle,
                gameSettings,
                tts,
                roomAi,
                subscriptionAuth,
                chat,
                mcp,
                isHost: true,
                player: await gameSettings.player(),
              }),
            });
            return { mediaBase: media.base };
          },
          claimStartupAnimation: () => {
            if (!startupAnimationPending || window !== mainWindow) return false;
            startupAnimationPending = false;
            return true;
          },
          openExternal: ({ url }) => openHttpLink(url, Utils.openExternal),
          setGamePage: ({ active }) => {
            const state = windowStates.get(window.id);
            if (state) state.gamePage = active;
          },
        },
        messages: { orpc: (packet) => port?.receive(packet) },
      },
    });
    window.webview.rpc = rpc;
    rpc.setTransport(window.webview.createTransport());
    windowStates.set(window.id, { gamePage: false, send: (name) => rpc.send.desktop({ name }) });
    window.on("close", () => port?.close());
  });
  function createMainWindow(hash = pendingPreview ? modulePreviewHash(pendingPreview) : "/") {
    const window = createDesktopWindow({}, hash);
    window.on("will-close", (event) => {
      if (!shuttingDown && windowStates.get(window.id)?.gamePage) {
        (event as { response: { allow: boolean } }).response = { allow: false };
        windowStates.get(window.id)?.send("request-leave-room");
      }
    });
    window.on("close", () => {
      if (mainWindow === window) mainWindow = null;
      closeAllModuleReferences();
      if (process.platform !== "darwin" && !shuttingDown) Utils.quit();
    });
    return window;
  }
  Electrobun.events.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.response = { allow: false };
    shuttingDown = true;
    tts.close();
    closeAllModuleReferences();
    void Promise.allSettled([
      (async () => {
        try {
          await mcp.close();
        } finally {
          await chat.close();
        }
      })(),
      subscriptionAuth.cancel(),
      flushReferenceWindowState(),
      instance.close(),
    ]).finally(() => {
      media.close();
      Utils.quit();
    });
  });
  Electrobun.events.on("reopen", () => {
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow();
    else showWindow(mainWindow);
  });
  configureApplicationMenu(() => {
    const target = focusedWindow();
    if (isWindowOpen(target)) windowStates.get(target.id)?.send("open-settings");
    else mainWindow = createMainWindow("/?overlay=settings");
  });
  await configureReferenceWindows({
    boundsFile: join(configLocation.directory, "reference-window.json"),
    parent: () => mainWindow,
  });
  initialized = true;
  mainWindow = createMainWindow();
  await mcp.initialize();
}
