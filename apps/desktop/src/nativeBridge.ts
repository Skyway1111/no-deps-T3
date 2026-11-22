import type {
  DesktopAppBranding,
  DesktopBridge,
  DesktopEnvironmentBootstrap,
  DesktopPreviewAnnotationVoiceEvent,
  DesktopPreviewFindResultEvent,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewTabState,
  DesktopSnapShotEvent,
} from "@t3tools/contracts";

import * as IpcChannels from "./ipc/channels.ts";

export interface NativeBridgeBootstrap {
  readonly platform?: string;
  readonly branding?: DesktopAppBranding | null;
  readonly relayTelemetryEnabled?: boolean | null;
  readonly systemLocale?: string | null;
  readonly preferredSystemLanguages?: readonly string[];
  readonly primaryPasteEnabled?: boolean;
  readonly localEnvironmentEnabled?: boolean;
  readonly localEnvironmentBootstraps?: readonly DesktopEnvironmentBootstrap[];
  readonly fullscreen?: boolean;
  readonly zoomFactor?: number;
}

export interface NativeBridgeTransport {
  readonly invoke: (channel: string, params?: unknown) => Promise<unknown>;
  readonly sendSync?: (channel: string, params?: unknown) => unknown;
  readonly on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  readonly getClientPlatform: () => string;
  readonly getWindowZoomFactor?: () => number;
  readonly getPathForFile?: (file: File) => string;
  readonly bootstrap?: NativeBridgeBootstrap;
}

interface NativeWebKitGlobal {
  webkit?: {
    messageHandlers?: Record<string, { postMessage: (message: string) => void }>;
  };
  chrome?: {
    webview?: { postMessage: (message: string) => void };
  };
  __t3NativeBridge?: {
    bootstrap?: NativeBridgeBootstrap;
    invoke?: (method: string, params?: unknown) => Promise<unknown>;
    on?: (channel: string, listener: (...args: unknown[]) => void) => () => void;
    _resolve?: (id: number, ok: boolean, result: unknown, error: unknown) => void;
    _emit?: (channel: string, payload: unknown) => void;
  };
  desktopBridge?: DesktopBridge;
}

const SNAP_SHOT_EVENT_TYPES = new Set([
  "requested",
  "started",
  "ready",
  "failed",
  "shortcut-changed",
]);

function isSnapShotEvent(value: unknown): value is DesktopSnapShotEvent {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return (
    typeof type === "string" &&
    SNAP_SHOT_EVENT_TYPES.has(type) &&
    (id === undefined || typeof id === "string")
  );
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

/**
 * Creates a `NativeBridgeTransport` backed by `native/t3-desktop`'s WebKit2GTK /
 * WKWebView / WebView2 message handler (`t3bridge`).
 */
export function createWebKitTransport(
  handlerName = "t3bridge",
  bootstrap?: NativeBridgeBootstrap,
): NativeBridgeTransport {
  const host = globalThis as unknown as NativeWebKitGlobal;
  const existingBridge = host.__t3NativeBridge;
  const effectiveBootstrap: NativeBridgeBootstrap = {
    ...existingBridge?.bootstrap,
    ...bootstrap,
  };

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const post = (payload: { id: number; method: string; params: unknown }): boolean => {
    const raw = JSON.stringify(payload);
    const webkitHandler = host.webkit?.messageHandlers?.[handlerName];
    if (webkitHandler) {
      webkitHandler.postMessage(raw);
      return true;
    }
    if (host.chrome?.webview?.postMessage) {
      host.chrome.webview.postMessage(raw);
      return true;
    }
    return false;
  };

  const invoke = (channel: string, params?: unknown): Promise<unknown> => {
    if (existingBridge?.invoke) {
      return existingBridge.invoke(channel, params);
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      if (!post({ id, method: channel, params: params === undefined ? null : params })) {
        pending.delete(id);
        reject(new Error(`Native desktop transport unavailable for channel "${channel}".`));
      }
    });
  };

  const on = (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    if (existingBridge?.on) {
      return existingBridge.on(channel, listener);
    }
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  if (!existingBridge) {
    host.__t3NativeBridge = {
      bootstrap: effectiveBootstrap,
      invoke,
      on,
      _resolve: (id, ok, result, error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(typeof error === "string" ? error : "Native IPC error"));
      },
      _emit: (channel, payload) => {
        const set = listeners.get(channel);
        if (!set) return;
        for (const fn of set) {
          try {
            fn(payload);
          } catch {}
        }
      },
    };
  }

  return {
    invoke,
    on,
    bootstrap: effectiveBootstrap,
    getClientPlatform: () => effectiveBootstrap.platform ?? "linux",
    getWindowZoomFactor: () => effectiveBootstrap.zoomFactor ?? 1,
    getPathForFile: (file) =>
      "path" in file && typeof (file as File & { path?: unknown }).path === "string"
        ? ((file as File & { path: string }).path)
        : "",
  };
}

/**
 * Wraps Electron's `ipcRenderer` / `webFrame` / `webUtils` into the same
 * `NativeBridgeTransport` interface used by `native/t3-desktop`.
 */
export function createElectronTransport(input: {
  readonly ipcRenderer: {
    readonly invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    readonly sendSync: (channel: string, ...args: unknown[]) => unknown;
    readonly on: (channel: string, listener: (_event: unknown, ...args: unknown[]) => void) => void;
    readonly removeListener: (
      channel: string,
      listener: (_event: unknown, ...args: unknown[]) => void,
    ) => void;
  };
  readonly platform: string;
  readonly getZoomFactor: () => number;
  readonly getPathForFile: (file: File) => string;
}): NativeBridgeTransport {
  return {
    invoke: (channel, params) =>
      params === undefined
        ? input.ipcRenderer.invoke(channel)
        : input.ipcRenderer.invoke(channel, params),
    sendSync: (channel, params) =>
      params === undefined
        ? input.ipcRenderer.sendSync(channel)
        : input.ipcRenderer.sendSync(channel, params),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, ...args: unknown[]) => listener(...args);
      input.ipcRenderer.on(channel, wrapped);
      return () => input.ipcRenderer.removeListener(channel, wrapped);
    },
    getClientPlatform: () => input.platform,
    getWindowZoomFactor: input.getZoomFactor,
    getPathForFile: input.getPathForFile,
  };
}

/**
 * Builds the full `window.desktopBridge` contract over any `NativeBridgeTransport`
 * so the web app speaks identically to `native/t3-desktop` or Electron.
 */
export function createDesktopBridge(transport: NativeBridgeTransport): DesktopBridge {
  const boot = transport.bootstrap ?? {};
  let fullscreen = boot.fullscreen === true;
  let localEnvironmentEnabled = boot.localEnvironmentEnabled !== false;

  const syncValue = <T>(channel: string, fallback: T): T => {
    if (!transport.sendSync) return fallback;
    try {
      return transport.sendSync(channel) as T;
    } catch {
      return fallback;
    }
  };

  transport.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, (value) => {
    if (typeof value === "boolean") fullscreen = value;
  });

  return {
    getAppBranding: () => {
      const result = syncValue<unknown>(
        IpcChannels.GET_APP_BRANDING_CHANNEL,
        boot.branding ?? null,
      );
      return typeof result === "object" && result !== null
        ? (result as ReturnType<DesktopBridge["getAppBranding"]>)
        : null;
    },
    getRelayTelemetryEnabled: () => {
      const enabled = syncValue<unknown>(
        IpcChannels.GET_RELAY_TELEMETRY_ENABLED_CHANNEL,
        boot.relayTelemetryEnabled ?? false,
      );
      return enabled === null ? null : enabled === true;
    },
    getPathForFile: (file) => transport.getPathForFile?.(file) ?? "",
    getClientPlatform: () => transport.getClientPlatform(),
    restartAudioService: () =>
      transport.invoke(IpcChannels.RESTART_AUDIO_SERVICE_CHANNEL) as Promise<boolean>,
    setNotificationBadge: (badge) =>
      transport.invoke(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, badge) as Promise<void>,
    onNotificationBadgeClear: (listener) =>
      transport.on(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, () => listener()),
    onTrackpadScrollBegin: (listener) =>
      transport.on(IpcChannels.TRACKPAD_SCROLL_BEGIN_CHANNEL, () => listener()),
    onTrackpadScrollEnd: (listener) =>
      transport.on(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, () => listener()),
    revealWindow: () => transport.invoke(IpcChannels.REVEAL_WINDOW_CHANNEL) as Promise<void>,
    getPrimaryPasteEnabled: () =>
      syncValue<unknown>(
        IpcChannels.GET_PRIMARY_PASTE_ENABLED_CHANNEL,
        boot.primaryPasteEnabled ?? true,
      ) !== false,
    getSystemLocale: () => {
      const result = syncValue<unknown>(
        IpcChannels.GET_SYSTEM_LOCALE_CHANNEL,
        boot.systemLocale ?? null,
      );
      return typeof result === "string" ? result : null;
    },
    getPreferredSystemLanguages: () => {
      const result = syncValue<unknown>(
        IpcChannels.GET_PREFERRED_SYSTEM_LANGUAGES_CHANNEL,
        boot.preferredSystemLanguages ?? [],
      );
      return Array.isArray(result) ? result.filter((tag) => typeof tag === "string") : [];
    },
    getLocalEnvironmentBootstraps: () => {
      const result = syncValue<unknown>(
        IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
        boot.localEnvironmentBootstraps ?? [],
      );
      return Array.isArray(result)
        ? (result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>)
        : [];
    },
    getLocalEnvironmentBearerToken: () =>
      transport.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL) as Promise<string>,
    getLocalEnvironmentEnabled: () =>
      syncValue<unknown>(
        IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
        localEnvironmentEnabled,
      ) !== false,
    setLocalEnvironmentEnabled: (enabled) => {
      localEnvironmentEnabled = enabled;
      return transport.invoke(
        IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
        enabled,
      ) as Promise<void>;
    },
    getHostEnvironmentId: () =>
      transport.invoke(IpcChannels.GET_HOST_ENVIRONMENT_ID_CHANNEL) as Promise<string | null>,
    getClientSettings: () =>
      transport.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL) as ReturnType<
        DesktopBridge["getClientSettings"]
      >,
    setClientSettings: (settings) =>
      transport.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings) as Promise<void>,
    requestSnapShotPermissions: (includeAccessibility) =>
      transport.invoke(
        IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL,
        includeAccessibility,
      ) as Promise<void>,
    getSnapShotState: () =>
      transport.invoke(IpcChannels.GET_SNAP_SHOT_STATE_CHANNEL) as ReturnType<
        DesktopBridge["getSnapShotState"]
      >,
    setupSnapShot: (action) =>
      transport.invoke(IpcChannels.SETUP_SNAP_SHOT_CHANNEL, action) as Promise<void>,
    previewSnapShotConfig: (request) =>
      transport.invoke(IpcChannels.PREVIEW_SNAP_SHOT_CONFIG_CHANNEL, request) as ReturnType<
        DesktopBridge["previewSnapShotConfig"]
      >,
    applySnapShotConfig: (id) =>
      transport.invoke(IpcChannels.APPLY_SNAP_SHOT_CONFIG_CHANNEL, id) as ReturnType<
        DesktopBridge["applySnapShotConfig"]
      >,
    checkSnapShotShortcut: (shortcut) =>
      transport.invoke(IpcChannels.CHECK_SNAP_SHOT_SHORTCUT_CHANNEL, shortcut) as ReturnType<
        DesktopBridge["checkSnapShotShortcut"]
      >,
    setSnapShotShortcutSuppressed: (suppressed) =>
      transport.invoke(
        IpcChannels.SET_SNAP_SHOT_SHORTCUT_SUPPRESSED_CHANNEL,
        suppressed,
      ) as Promise<void>,
    listPendingSnapShots: () =>
      transport.invoke(IpcChannels.LIST_PENDING_SNAP_SHOTS_CHANNEL) as ReturnType<
        DesktopBridge["listPendingSnapShots"]
      >,
    readSnapShot: (id) =>
      transport.invoke(IpcChannels.READ_SNAP_SHOT_CHANNEL, id) as ReturnType<
        DesktopBridge["readSnapShot"]
      >,
    setSnapShotAnimationDestination: (destination) =>
      transport.invoke(
        IpcChannels.SET_SNAP_SHOT_ANIMATION_DESTINATION_CHANNEL,
        destination,
      ) as Promise<void>,
    dismissSnapShotAnimation: (id) =>
      transport.invoke(IpcChannels.DISMISS_SNAP_SHOT_ANIMATION_CHANNEL, id) as Promise<void>,
    acknowledgeSnapShot: (id) =>
      transport.invoke(IpcChannels.ACKNOWLEDGE_SNAP_SHOT_CHANNEL, id) as Promise<void>,
    getConnectionCatalog: () =>
      transport.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL) as Promise<string | null>,
    setConnectionCatalog: (catalog) =>
      transport.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog) as Promise<boolean>,
    discoverSshHosts: () =>
      transport.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL) as ReturnType<
        DesktopBridge["discoverSshHosts"]
      >,
    resolveSshHost: (alias) =>
      transport.invoke(IpcChannels.RESOLVE_SSH_HOST_CHANNEL, alias) as ReturnType<
        DesktopBridge["resolveSshHost"]
      >,
    ensureSshEnvironment: async (target, options) =>
      unwrapEnsureSshEnvironmentResult(
        await transport.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
          target,
          ...(options === undefined ? {} : { options }),
        }),
      ),
    disconnectSshEnvironment: (target) =>
      transport.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target) as Promise<void>,
    fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
      transport.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, {
        httpBaseUrl,
      }) as ReturnType<DesktopBridge["fetchSshEnvironmentDescriptor"]>,
    bootstrapSshBearerSession: (httpBaseUrl, credential) =>
      transport.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
        httpBaseUrl,
        credential,
      }) as ReturnType<DesktopBridge["bootstrapSshBearerSession"]>,
    fetchSshSessionState: (httpBaseUrl, bearerToken) =>
      transport.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, {
        httpBaseUrl,
        bearerToken,
      }) as ReturnType<DesktopBridge["fetchSshSessionState"]>,
    onSshPasswordPrompt: (listener) =>
      transport.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, (request) => {
        if (typeof request === "object" && request !== null) {
          listener(request as Parameters<typeof listener>[0]);
        }
      }),
    onSshPasswordPromptSettled: (listener) =>
      transport.on(IpcChannels.SSH_PASSWORD_PROMPT_SETTLED_CHANNEL, (requestId) => {
        if (typeof requestId === "string") listener(requestId);
      }),
    resolveSshPasswordPrompt: (requestId, password) =>
      transport.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, {
        requestId,
        password,
      }) as Promise<void>,
    getServerExposureState: () =>
      transport.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL) as ReturnType<
        DesktopBridge["getServerExposureState"]
      >,
    setServerExposureMode: (mode) =>
      transport.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode) as ReturnType<
        DesktopBridge["setServerExposureMode"]
      >,
    setTailscaleServeEnabled: (input) =>
      transport.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input) as ReturnType<
        DesktopBridge["setTailscaleServeEnabled"]
      >,
    getAdvertisedEndpoints: () =>
      transport.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL) as ReturnType<
        DesktopBridge["getAdvertisedEndpoints"]
      >,
    getWslState: () =>
      transport.invoke(IpcChannels.GET_WSL_STATE_CHANNEL) as ReturnType<
        DesktopBridge["getWslState"]
      >,
    setWslBackendEnabled: (enabled) =>
      transport.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled) as ReturnType<
        DesktopBridge["setWslBackendEnabled"]
      >,
    setWslDistro: (distro) =>
      transport.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro) as ReturnType<
        DesktopBridge["setWslDistro"]
      >,
    setWslOnly: (enabled) =>
      transport.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled) as ReturnType<
        DesktopBridge["setWslOnly"]
      >,
    pickFolder: (options) =>
      transport.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options) as Promise<string | null>,
    toLocalBackendPath: (backendId, path) =>
      transport.invoke(IpcChannels.TO_LOCAL_BACKEND_PATH_CHANNEL, {
        backendId,
        path,
      }) as Promise<string | null>,
    pickProjectFavicon: (initialPath) =>
      transport.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath) as Promise<
        string | null
      >,
    pickThemeFiles: () =>
      transport.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL) as ReturnType<
        DesktopBridge["pickThemeFiles"]
      >,
    setTheme: (theme) => transport.invoke(IpcChannels.SET_THEME_CHANNEL, theme) as Promise<void>,
    showContextMenu: <T extends string>(
      items: Parameters<DesktopBridge["showContextMenu"]>[0],
      position?: { x: number; y: number },
      source?: Parameters<DesktopBridge["showContextMenu"]>[2],
    ) =>
      transport.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
        items,
        ...(position === undefined ? {} : { position }),
        ...(source === undefined ? {} : { source }),
      }) as Promise<T | null>,
    receiveProviderAuthCallback: (url) =>
      transport.invoke(IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL, url) as Promise<string>,
    cancelProviderAuthCallback: (url) =>
      transport.invoke(IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL, url) as Promise<void>,
    startFileDrag: (input) =>
      transport.invoke(IpcChannels.START_FILE_DRAG_CHANNEL, input) as Promise<boolean>,
    openExternal: (url) =>
      transport.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url) as Promise<boolean>,
    readMedia: (url) =>
      transport.invoke(IpcChannels.READ_MEDIA_CHANNEL, url) as ReturnType<
        DesktopBridge["readMedia"]
      >,
    checkSystemPermission: (pane) =>
      transport.invoke(IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL, pane) as Promise<boolean>,
    appleSpeech: {
      supportedLocales: () =>
        transport.invoke(IpcChannels.APPLE_SPEECH_AVAILABLE_CHANNEL) as Promise<readonly string[]>,
      prepare: (locale) =>
        transport.invoke(IpcChannels.APPLE_SPEECH_PREPARE_CHANNEL, locale) as ReturnType<
          NonNullable<DesktopBridge["appleSpeech"]>["prepare"]
        >,
      transcribe: (input) =>
        transport.invoke(IpcChannels.APPLE_SPEECH_TRANSCRIBE_CHANNEL, input) as ReturnType<
          NonNullable<DesktopBridge["appleSpeech"]>["transcribe"]
        >,
    },
    openSystemSettings: (pane) =>
      transport.invoke(IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL, pane) as Promise<boolean>,
    probeRemoteEditors: () =>
      transport.invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL) as ReturnType<
        DesktopBridge["probeRemoteEditors"]
      >,
    pasteAsText: () => transport.invoke(IpcChannels.PASTE_AS_TEXT_CHANNEL) as Promise<void>,
    onMenuAction: (listener) =>
      transport.on(IpcChannels.MENU_ACTION_CHANNEL, (action) => {
        if (typeof action === "string") listener(action);
      }),
    onSnapShotEvent: (listener) =>
      transport.on(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, (event) => {
        if (isSnapShotEvent(event)) listener(event);
      }),
    onQuitShortcut: (listener) =>
      transport.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, (hint) => {
        if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
        if (hint.state === "up") {
          listener({ state: "up" });
        } else if (
          hint.state === "down" &&
          "mode" in hint &&
          (hint.mode === "hold" || hint.mode === "double-click")
        ) {
          listener({ state: "down", mode: hint.mode });
        }
      }),
    getWindowFullscreenState: () =>
      syncValue<unknown>(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL, fullscreen) === true,
    getWindowZoomFactor: () => transport.getWindowZoomFactor?.() ?? 1,
    onWindowFullscreenStateChange: (listener) =>
      transport.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, (value) => {
        if (typeof value === "boolean") listener(value);
      }),
    getUpdateState: () =>
      transport.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL) as ReturnType<
        DesktopBridge["getUpdateState"]
      >,
    setUpdateChannel: (channel, minimumVersion) =>
      transport.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, {
        channel,
        ...(minimumVersion === undefined ? {} : { minimumVersion }),
      }) as ReturnType<DesktopBridge["setUpdateChannel"]>,
    checkForUpdate: () =>
      transport.invoke(IpcChannels.UPDATE_CHECK_CHANNEL) as ReturnType<
        DesktopBridge["checkForUpdate"]
      >,
    downloadUpdate: () =>
      transport.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL) as ReturnType<
        DesktopBridge["downloadUpdate"]
      >,
    installUpdate: (expectedVersion) =>
      transport.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL, expectedVersion) as ReturnType<
        DesktopBridge["installUpdate"]
      >,
    cliCommand: {
      getState: () =>
        transport.invoke(IpcChannels.CLI_COMMAND_GET_STATE_CHANNEL) as ReturnType<
          DesktopBridge["cliCommand"]["getState"]
        >,
      install: () =>
        transport.invoke(IpcChannels.CLI_COMMAND_INSTALL_CHANNEL) as ReturnType<
          DesktopBridge["cliCommand"]["install"]
        >,
      uninstall: () =>
        transport.invoke(IpcChannels.CLI_COMMAND_UNINSTALL_CHANNEL) as ReturnType<
          DesktopBridge["cliCommand"]["uninstall"]
        >,
      addToPath: () =>
        transport.invoke(IpcChannels.CLI_COMMAND_ADD_TO_PATH_CHANNEL) as ReturnType<
          DesktopBridge["cliCommand"]["addToPath"]
        >,
    },
    onUpdateState: (listener) =>
      transport.on(IpcChannels.UPDATE_STATE_CHANNEL, (state) => {
        if (typeof state === "object" && state !== null) {
          listener(state as Parameters<typeof listener>[0]);
        }
      }),
    webLinks: {
      setReady: (ready) =>
        transport.invoke(IpcChannels.WEB_LINK_READY_CHANNEL, ready) as Promise<void>,
      onOpen: (listener) =>
        transport.on(IpcChannels.WEB_LINK_OPEN_CHANNEL, (url) => {
          if (typeof url === "string") listener(url);
        }),
    },
    appActivation: {
      setReady: (ready) =>
        transport.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL, ready) as Promise<void>,
      complete: (response) =>
        transport.invoke(
          IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
          response,
        ) as Promise<void>,
      onRequest: (listener) =>
        transport.on(IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, (request) => {
          if (typeof request === "object" && request !== null) {
            listener(request as Parameters<typeof listener>[0]);
          }
        }),
    },
    preview: {
      setForwardedShortcuts: (shortcuts) =>
        transport.invoke(
          IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL,
          shortcuts,
        ) as Promise<void>,
      createTab: (tabId, defaults) =>
        transport.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
          tabId,
          ...(defaults?.zoomFactor === undefined ? {} : { zoomFactor: defaults.zoomFactor }),
          ...(defaults?.serverTab === undefined ? {} : { serverTab: defaults.serverTab }),
          ...(defaults?.colorScheme === undefined ? {} : { colorScheme: defaults.colorScheme }),
        }) as Promise<void>,
      closeTab: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }) as Promise<void>,
      registerWebview: (tabId, webContentsId) =>
        transport.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, {
          tabId,
          webContentsId,
        }) as Promise<void>,
      navigate: (tabId, url) =>
        transport.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }) as Promise<void>,
      goBack: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }) as Promise<void>,
      goForward: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }) as Promise<void>,
      refresh: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }) as Promise<void>,
      stopLoading: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_STOP_LOADING_CHANNEL, { tabId }) as Promise<void>,
      zoomIn: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }) as Promise<void>,
      zoomOut: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }) as Promise<void>,
      resetZoom: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }) as Promise<void>,
      setZoomFactor: (tabId, zoomFactor) =>
        transport.invoke(IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL, {
          tabId,
          zoomFactor,
        }) as Promise<void>,
      hardReload: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }) as Promise<void>,
      setColorScheme: (tabId, colorScheme) =>
        transport.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, {
          tabId,
          colorScheme,
        }) as Promise<void>,
      setAudioMuted: (tabId, audioMuted) =>
        transport.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, {
          tabId,
          audioMuted,
        }) as Promise<void>,
      findInPage: (tabId, text, { forward, newSession }) =>
        transport.invoke(IpcChannels.PREVIEW_FIND_IN_PAGE_CHANNEL, {
          tabId,
          text,
          forward,
          newSession,
        }) as Promise<void>,
      stopFindInPage: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_STOP_FIND_IN_PAGE_CHANNEL, {
          tabId,
        }) as Promise<void>,
      setShown: (tabId, shown) =>
        transport.invoke(IpcChannels.PREVIEW_SET_SHOWN_CHANNEL, { tabId, shown }) as Promise<void>,
      setCaptureDrawn: (tabId, drawn) =>
        transport.invoke(IpcChannels.PREVIEW_SET_CAPTURE_DRAWN_CHANNEL, {
          tabId,
          drawn,
        }) as Promise<void>,
      openDevTools: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }) as Promise<void>,
      listBrowserImportSources: () =>
        transport.invoke(IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL) as ReturnType<
          DesktopBridge["preview"]["listBrowserImportSources"]
        >,
      importBrowserCookies: (input) =>
        transport.invoke(IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL, input) as ReturnType<
          DesktopBridge["preview"]["importBrowserCookies"]
        >,
      clearCookies: (environmentId, profileId) =>
        transport.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, {
          environmentId,
          ...(profileId === undefined ? {} : { profileId }),
        }) as Promise<void>,
      clearCache: (environmentId, profileId) =>
        transport.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, {
          environmentId,
          ...(profileId === undefined ? {} : { profileId }),
        }) as Promise<void>,
      getPreviewConfig: (environmentId, profileId, tunnelLoopback) =>
        transport.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, {
          environmentId,
          ...(profileId === undefined ? {} : { profileId }),
          ...(tunnelLoopback === undefined ? {} : { tunnelLoopback }),
        }) as ReturnType<DesktopBridge["preview"]["getPreviewConfig"]>,
      onTunnelAccessRequest: (listener) =>
        transport.on(IpcChannels.PREVIEW_TUNNEL_ACCESS_REQUEST_CHANNEL, (request) => {
          if (typeof request === "object" && request !== null) {
            listener(request as Parameters<typeof listener>[0]);
          }
        }),
      resolveTunnelAccess: (requestId, url) =>
        transport.invoke(IpcChannels.PREVIEW_TUNNEL_ACCESS_RESOLVE_CHANNEL, {
          requestId,
          url,
        }) as Promise<void>,
      forwardPort: (environmentId, remotePort) =>
        transport.invoke(IpcChannels.PORT_FORWARD_START_CHANNEL, {
          environmentId,
          remotePort,
        }) as ReturnType<DesktopBridge["preview"]["forwardPort"]>,
      stopPortForward: (environmentId, remotePort) =>
        transport.invoke(IpcChannels.PORT_FORWARD_STOP_CHANNEL, {
          environmentId,
          remotePort,
        }) as Promise<void>,
      listPortForwards: () =>
        transport.invoke(IpcChannels.PORT_FORWARD_LIST_CHANNEL) as ReturnType<
          DesktopBridge["preview"]["listPortForwards"]
        >,
      sharesLoopback: (environmentId) =>
        transport.invoke(IpcChannels.PORT_FORWARD_SHARES_LOOPBACK_CHANNEL, {
          environmentId,
        }) as Promise<boolean>,
      onPortForwards: (listener) =>
        transport.on(IpcChannels.PORT_FORWARD_CHANGE_CHANNEL, (forwards) => {
          if (Array.isArray(forwards)) listener(forwards);
        }),
      setAnnotationTheme: (theme) =>
        transport.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, {
          theme,
        }) as Promise<void>,
      setAnnotationSendEnabled: (tabId, enabled) =>
        transport.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL, {
          tabId,
          enabled,
        }) as Promise<void>,
      annotationVoice: {
        onEvent: (listener) =>
          transport.on(IpcChannels.PREVIEW_ANNOTATION_VOICE_EVENT_CHANNEL, (tabId, value) => {
            if (typeof tabId === "string" && typeof value === "object" && value !== null) {
              listener(tabId, value as DesktopPreviewAnnotationVoiceEvent);
            }
          }),
        update: (state) =>
          transport.invoke(
            IpcChannels.PREVIEW_ANNOTATION_VOICE_STATE_CHANNEL,
            state,
          ) as Promise<void>,
      },
      pickElement: (tabId, voice) =>
        transport.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, {
          tabId,
          ...(voice === undefined ? {} : { voice }),
        }) as ReturnType<DesktopBridge["preview"]["pickElement"]>,
      cancelPickElement: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, {
          tabId,
        }) as Promise<void>,
      captureScreenshot: (tabId) =>
        transport.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }) as ReturnType<
          DesktopBridge["preview"]["captureScreenshot"]
        >,
      revealArtifact: (path) =>
        transport.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }) as Promise<void>,
      copyArtifactToClipboard: (path) =>
        transport.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }) as Promise<void>,
      pictureInPicture: {
        open: (tabId) =>
          transport.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, {
            tabId,
          }) as Promise<void>,
        close: (tabId) =>
          transport.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, {
            tabId,
          }) as Promise<void>,
      },
      recording: {
        onInput: (listener) =>
          transport.on(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, (event) => {
            if (typeof event === "object" && event !== null) {
              listener(event as DesktopPreviewRecordingInputEvent);
            }
          }),
        startScreencast: (tabId) =>
          transport.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }) as ReturnType<
            DesktopBridge["preview"]["recording"]["startScreencast"]
          >,
        stopScreencast: (tabId) =>
          transport.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }) as Promise<void>,
        save: (tabId, mimeType, data) =>
          transport.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
            tabId,
            mimeType,
            data,
          }) as ReturnType<DesktopBridge["preview"]["recording"]["save"]>,
      },
      onStateChange: (listener) =>
        transport.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, (tabId, state) => {
          if (typeof tabId === "string" && typeof state === "object" && state !== null) {
            listener(tabId, state as DesktopPreviewTabState);
          }
        }),
      onPointerEvent: (listener) =>
        transport.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, (pointerEvent) => {
          if (typeof pointerEvent === "object" && pointerEvent !== null) {
            listener(pointerEvent as DesktopPreviewPointerEvent);
          }
        }),
      onOpenLink: (listener) =>
        transport.on(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, (linkEvent) => {
          if (typeof linkEvent === "object" && linkEvent !== null) {
            listener(linkEvent as DesktopPreviewOpenLinkEvent);
          }
        }),
      onFindResult: (listener) =>
        transport.on(IpcChannels.PREVIEW_FIND_RESULT_CHANNEL, (findEvent) => {
          if (typeof findEvent === "object" && findEvent !== null) {
            listener(findEvent as DesktopPreviewFindResultEvent);
          }
        }),
    },
  } satisfies DesktopBridge;
}

/**
 * Installs `window.desktopBridge` when running inside `native/t3-desktop`
 * (or returns the existing Electron bridge unchanged).
 */
export function installNativeDesktopBridge(
  bootstrap?: NativeBridgeBootstrap,
): DesktopBridge | null {
  const host = globalThis as unknown as NativeWebKitGlobal;
  if (host.desktopBridge) return host.desktopBridge;
  const hasNativeTransport =
    Boolean(host.__t3NativeBridge) ||
    Boolean(host.webkit?.messageHandlers?.t3bridge) ||
    Boolean(host.chrome?.webview?.postMessage);
  if (!hasNativeTransport) return null;

  const bridge = createDesktopBridge(createWebKitTransport("t3bridge", bootstrap));
  host.desktopBridge = bridge;
  return bridge;
}
