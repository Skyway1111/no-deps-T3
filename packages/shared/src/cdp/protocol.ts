// Pure Chrome DevTools Protocol (CDP) types, payload validation, and error classes.
// Zero Node or DOM runtime imports so both server and desktop relay share one contract.

export const CDP_ERROR_CODE = -32000;
const MAX_CDP_PAYLOAD_SIZE = 64 * 1024 * 1024;

export interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

export interface CdpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface CdpResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: CdpError;
  readonly sessionId?: string;
}

export interface CdpEvent {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

export type CdpMessage = CdpCommand | CdpResponse | CdpEvent;

export const isCdpCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

// CDP values are plain JSON data, so their serialized size can be bounded before
// JSON.stringify allocates it. A string counts at its length unless it holds a
// character JSON may escape, which can take six code units.
const MAY_ESCAPE = /[^\x20\x21\x23-\x5b\x5d-\ud7ff\ue000-\uffff]/;
const serializedSize = (text: string) =>
  (MAY_ESCAPE.test(text) ? text.length * 6 : text.length) + 3;

export const fitsCdpPayloadBudget = (
  message: unknown,
  maxBytes = MAX_CDP_PAYLOAD_SIZE,
): boolean => {
  let remaining = maxBytes;
  const visit = (value: unknown): boolean => {
    remaining -= typeof value === "string" ? serializedSize(value) : 26;
    if (remaining < 0) return false;
    if (typeof value !== "object" || value === null) return true;
    if (Array.isArray(value)) return value.every(visit);
    return Object.entries(value).every(([key, item]) => {
      remaining -= serializedSize(key);
      return visit(item);
    });
  };
  return visit(message);
};

export class CdpTimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(message: string) {
    super(message);
  }
}

export class CdpProtocolError extends Error {
  override readonly name = "CdpProtocolError";
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, error: CdpError) {
    super(`Protocol error (${method}): ${error.message}`);
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export interface CdpFrameInfo {
  readonly id: string;
  readonly parentId?: string;
  readonly loaderId?: string;
  readonly name?: string;
  readonly url: string;
  readonly urlFragment?: string;
}

export interface CdpFrameTree {
  readonly frame: CdpFrameInfo;
  readonly childFrames?: ReadonlyArray<CdpFrameTree>;
}

export interface CdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly attached?: boolean;
  readonly openerId?: string;
  readonly canAccessOpener?: boolean;
  readonly browserContextId?: string;
}

export interface CdpRemoteObject {
  readonly type: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly objectId?: string;
}

export interface CdpExceptionDetails {
  readonly exceptionId?: number;
  readonly text: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly scriptId?: string;
  readonly stackTrace?: unknown;
  readonly exception?: CdpRemoteObject;
}

export interface CdpAxValue {
  readonly type: string;
  readonly value?: unknown;
}

export interface CdpAxProperty {
  readonly name: string;
  readonly value: CdpAxValue;
}

export interface CdpAxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: CdpAxValue;
  readonly name?: CdpAxValue;
  readonly value?: CdpAxValue;
  readonly properties?: ReadonlyArray<CdpAxProperty>;
  readonly parentId?: string;
  readonly childIds?: ReadonlyArray<string>;
  readonly backendDOMNodeId?: number;
  readonly frameId?: string;
}

export interface CdpScreencastFrameEvent {
  readonly data: string;
  readonly metadata: {
    readonly offsetTop?: number;
    readonly pageScaleFactor?: number;
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly scrollOffsetX?: number;
    readonly scrollOffsetY?: number;
    readonly timestamp?: number;
  };
  readonly sessionId: number;
}

export interface CdpRequestPausedEvent {
  readonly requestId: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers?: Record<string, string>;
  };
  readonly frameId: string;
  readonly resourceType?: string;
  readonly responseErrorReason?: string;
  readonly responseStatusCode?: number;
  readonly responseStatusText?: string;
  readonly responseHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface CdpMethodMap {
  "Browser.getVersion": {
    params?: Record<string, never>;
    result: {
      readonly protocolVersion: string;
      readonly product: string;
      readonly revision: string;
      readonly userAgent: string;
      readonly jsVersion: string;
    };
  };
  "Browser.close": { params?: Record<string, never>; result: Record<string, never> };
  "Browser.grantPermissions": {
    params: {
      readonly permissions: ReadonlyArray<string>;
      readonly origin?: string;
      readonly browserContextId?: string;
    };
    result: Record<string, never>;
  };
  "Browser.setDownloadBehavior": {
    params: {
      readonly behavior: "deny" | "allow" | "allowAndName" | "default";
      readonly browserContextId?: string;
      readonly downloadPath?: string;
      readonly eventsEnabled?: boolean;
    };
    result: Record<string, never>;
  };
  "Emulation.setUserAgentOverride": {
    params: {
      readonly userAgent: string;
      readonly acceptLanguage?: string;
      readonly platform?: string;
      readonly userAgentMetadata?: Record<string, unknown>;
    };
    result: Record<string, never>;
  };
  "Emulation.setDeviceMetricsOverride": {
    params: {
      readonly width: number;
      readonly height: number;
      readonly deviceScaleFactor: number;
      readonly mobile: boolean;
      readonly scale?: number;
    };
    result: Record<string, never>;
  };
  "Emulation.setEmulatedMedia": {
    params: {
      readonly media?: string;
      readonly features?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    };
    result: Record<string, never>;
  };
  "Page.enable": { params?: Record<string, never>; result: Record<string, never> };
  "Page.close": { params?: Record<string, never>; result: Record<string, never> };
  "Page.reload": {
    params?: { readonly ignoreCache?: boolean; readonly scriptToEvaluateOnLoad?: string };
    result: Record<string, never>;
  };
  "Page.stopLoading": { params?: Record<string, never>; result: Record<string, never> };
  "Page.navigate": {
    params: { readonly url: string; readonly referrer?: string; readonly frameId?: string };
    result: {
      readonly frameId?: string;
      readonly loaderId?: string;
      readonly errorText?: string;
    };
  };
  "Page.navigateToHistoryEntry": {
    params: { readonly entryId: number };
    result: Record<string, never>;
  };
  "Page.getNavigationHistory": {
    params?: Record<string, never>;
    result: {
      readonly currentIndex: number;
      readonly entries: ReadonlyArray<{
        readonly id: number;
        readonly url: string;
        readonly userTypedURL?: string;
        readonly title: string;
      }>;
    };
  };
  "Page.getFrameTree": {
    params?: Record<string, never>;
    result: { readonly frameTree: CdpFrameTree };
  };
  "Page.createIsolatedWorld": {
    params: {
      readonly frameId: string;
      readonly worldName?: string;
      readonly grantUniveralAccess?: boolean;
    };
    result: { readonly executionContextId: number };
  };
  "Page.addScriptToEvaluateOnNewDocument": {
    params: {
      readonly source: string;
      readonly worldName?: string;
      readonly includeCommandLineAPI?: boolean;
      readonly runImmediately?: boolean;
    };
    result: { readonly identifier: string };
  };
  "Page.getLayoutMetrics": {
    params?: Record<string, never>;
    result: {
      readonly cssVisualViewport: {
        readonly pageX?: number;
        readonly pageY?: number;
        readonly clientWidth?: number;
        readonly clientHeight?: number;
        readonly scale?: number;
        readonly zoom?: number;
      };
    };
  };
  "Page.captureScreenshot": {
    params?: {
      readonly format?: "jpeg" | "png" | "webp";
      readonly quality?: number;
      readonly clip?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly scale: number;
      };
      readonly fromSurface?: boolean;
    };
    result: { readonly data: string };
  };
  "Page.startScreencast": {
    params?: {
      readonly format?: "jpeg" | "png";
      readonly quality?: number;
      readonly maxWidth?: number;
      readonly maxHeight?: number;
      readonly everyNthFrame?: number;
    };
    result: Record<string, never>;
  };
  "Page.stopScreencast": { params?: Record<string, never>; result: Record<string, never> };
  "Page.screencastFrameAck": {
    params: { readonly sessionId: number };
    result: Record<string, never>;
  };
  "Page.handleJavaScriptDialog": {
    params: { readonly accept: boolean; readonly promptText?: string };
    result: Record<string, never>;
  };
  "Page.setInterceptFileChooserDialog": {
    params: { readonly enabled: boolean };
    result: Record<string, never>;
  };
  "Runtime.enable": { params?: Record<string, never>; result: Record<string, never> };
  "Runtime.disable": { params?: Record<string, never>; result: Record<string, never> };
  "Runtime.runIfWaitingForDebugger": {
    params?: Record<string, never>;
    result: Record<string, never>;
  };
  "Runtime.terminateExecution": {
    params?: Record<string, never>;
    result: Record<string, never>;
  };
  "Runtime.addBinding": {
    params: { readonly name: string; readonly executionContextName?: string };
    result: Record<string, never>;
  };
  "Runtime.releaseObject": {
    params: { readonly objectId: string };
    result: Record<string, never>;
  };
  "Runtime.evaluate": {
    params: {
      readonly expression: string;
      readonly contextId?: number;
      readonly awaitPromise?: boolean;
      readonly returnByValue?: boolean;
      readonly replMode?: boolean;
      readonly userGesture?: boolean;
    };
    result: {
      readonly result: CdpRemoteObject;
      readonly exceptionDetails?: CdpExceptionDetails;
    };
  };
  "Runtime.callFunctionOn": {
    params: {
      readonly functionDeclaration: string;
      readonly objectId?: string;
      readonly executionContextId?: number;
      readonly arguments?: ReadonlyArray<{ readonly value?: unknown; readonly objectId?: string }>;
      readonly awaitPromise?: boolean;
      readonly returnByValue?: boolean;
      readonly userGesture?: boolean;
    };
    result: {
      readonly result: CdpRemoteObject;
      readonly exceptionDetails?: CdpExceptionDetails;
    };
  };
  "Network.enable": { params?: Record<string, never>; result: Record<string, never> };
  "Network.clearBrowserCookies": { params?: Record<string, never>; result: Record<string, never> };
  "Network.clearBrowserCache": { params?: Record<string, never>; result: Record<string, never> };
  "Log.enable": { params?: Record<string, never>; result: Record<string, never> };
  "DOM.enable": { params?: Record<string, never>; result: Record<string, never> };
  "DOM.describeNode": {
    params: {
      readonly nodeId?: number;
      readonly backendNodeId?: number;
      readonly objectId?: string;
      readonly depth?: number;
      readonly pierce?: boolean;
    };
    result: {
      readonly node: {
        readonly nodeId: number;
        readonly backendNodeId: number;
        readonly nodeName: string;
        readonly localName?: string;
        readonly frameId?: string;
        readonly attributes?: ReadonlyArray<string>;
      };
    };
  };
  "DOM.resolveNode": {
    params: {
      readonly nodeId?: number;
      readonly backendNodeId?: number;
      readonly objectGroup?: string;
      readonly executionContextId?: number;
    };
    result: { readonly object: CdpRemoteObject };
  };
  "DOM.setFileInputFiles": {
    params: {
      readonly files: ReadonlyArray<string>;
      readonly nodeId?: number;
      readonly backendNodeId?: number;
      readonly objectId?: string;
    };
    result: Record<string, never>;
  };
  "DOM.scrollIntoViewIfNeeded": {
    params: {
      readonly nodeId?: number;
      readonly backendNodeId?: number;
      readonly objectId?: string;
    };
    result: Record<string, never>;
  };
  "DOM.getContentQuads": {
    params: {
      readonly nodeId?: number;
      readonly backendNodeId?: number;
      readonly objectId?: string;
    };
    result: { readonly quads: ReadonlyArray<ReadonlyArray<number>> };
  };
  "Accessibility.enable": { params?: Record<string, never>; result: Record<string, never> };
  "Accessibility.getFullAXTree": {
    params?: { readonly depth?: number; readonly frameId?: string };
    result: { readonly nodes: ReadonlyArray<CdpAxNode> };
  };
  "Input.dispatchMouseEvent": {
    params: {
      readonly type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly modifiers?: number;
      readonly button?: "none" | "left" | "middle" | "right" | "back" | "forward";
      readonly buttons?: number;
      readonly clickCount?: number;
      readonly deltaX?: number;
      readonly deltaY?: number;
    };
    result: Record<string, never>;
  };
  "Input.dispatchKeyEvent": {
    params: {
      readonly type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      readonly modifiers?: number;
      readonly text?: string;
      readonly unmodifiedText?: string;
      readonly key?: string;
      readonly code?: string;
      readonly windowsVirtualKeyCode?: number;
      readonly nativeVirtualKeyCode?: number;
      readonly location?: number;
      readonly commands?: ReadonlyArray<string>;
    };
    result: Record<string, never>;
  };
  "Input.insertText": {
    params: { readonly text: string };
    result: Record<string, never>;
  };
  "Fetch.enable": {
    params?: {
      readonly patterns?: ReadonlyArray<{
        readonly urlPattern?: string;
        readonly resourceType?: string;
        readonly requestStage?: "Request" | "Response";
      }>;
    };
    result: Record<string, never>;
  };
  "Fetch.continueRequest": {
    params: { readonly requestId: string };
    result: Record<string, never>;
  };
  "Fetch.failRequest": {
    params: { readonly requestId: string; readonly errorReason: string };
    result: Record<string, never>;
  };
  "Fetch.fulfillRequest": {
    params: {
      readonly requestId: string;
      readonly responseCode: number;
      readonly responseHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
      readonly body?: string;
    };
    result: Record<string, never>;
  };
  "Target.setAutoAttach": {
    params: {
      readonly autoAttach: boolean;
      readonly waitForDebuggerOnStart: boolean;
      readonly flatten?: boolean;
      readonly filter?: ReadonlyArray<{ readonly type?: string; readonly exclude?: boolean }>;
    };
    result: Record<string, never>;
  };
  "Target.attachToTarget": {
    params: { readonly targetId: string; readonly flatten?: boolean };
    result: { readonly sessionId: string };
  };
  "Target.detachFromTarget": {
    params: { readonly sessionId?: string; readonly targetId?: string };
    result: Record<string, never>;
  };
  "Target.createTarget": {
    params: { readonly url: string; readonly browserContextId?: string };
    result: { readonly targetId: string };
  };
  "Target.closeTarget": {
    params: { readonly targetId: string };
    result: { readonly success?: boolean };
  };
  "Target.createBrowserContext": {
    params?: { readonly disposeOnDetach?: boolean };
    result: { readonly browserContextId: string };
  };
  "Target.disposeBrowserContext": {
    params: { readonly browserContextId: string };
    result: Record<string, never>;
  };
  "Target.getTargets": {
    params?: Record<string, never>;
    result: { readonly targetInfos: ReadonlyArray<CdpTargetInfo> };
  };
}

export interface CdpEventMap {
  "Fetch.requestPaused": CdpRequestPausedEvent;
  "Page.frameResized": Record<string, unknown>;
  "Page.loadEventFired": { readonly timestamp?: number };
  "Page.domContentLoadedEventFired": { readonly timestamp?: number };
  "Page.frameAttached": { readonly frameId: string; readonly parentFrameId: string };
  "Page.frameNavigated": { readonly frame: CdpFrameInfo };
  "Page.navigatedWithinDocument": { readonly frameId: string; readonly url: string };
  "Page.frameDetached": { readonly frameId: string; readonly reason?: string };
  "Page.javascriptDialogOpening": {
    readonly url?: string;
    readonly message: string;
    readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
    readonly defaultPrompt?: string;
  };
  "Page.javascriptDialogClosed": { readonly result?: boolean; readonly userInput?: string };
  "Page.fileChooserOpened": {
    readonly frameId?: string;
    readonly mode: "selectSingle" | "selectMultiple";
    readonly backendNodeId?: number;
  };
  "Page.screencastFrame": CdpScreencastFrameEvent;
  "Network.requestWillBeSent": {
    readonly requestId: string;
    readonly loaderId?: string;
    readonly frameId?: string;
    readonly type?: string;
    readonly request: { readonly url: string; readonly method: string };
  };
  "Network.responseReceived": {
    readonly requestId: string;
    readonly frameId?: string;
    readonly type?: string;
    readonly response: { readonly url: string; readonly status: number };
  };
  "Network.loadingFailed": {
    readonly requestId: string;
    readonly errorText: string;
    readonly canceled?: boolean;
  };
  "Runtime.consoleAPICalled": {
    readonly type: string;
    readonly args: ReadonlyArray<CdpRemoteObject>;
    readonly executionContextId?: number;
  };
  "Runtime.bindingCalled": {
    readonly name: string;
    readonly payload: string;
    readonly executionContextId?: number;
  };
  "Runtime.executionContextCreated": {
    readonly context: {
      readonly id: number;
      readonly name?: string;
      readonly auxData?: { readonly frameId?: string; readonly isDefault?: boolean };
    };
  };
  "Runtime.executionContextDestroyed": { readonly executionContextId: number };
  "Runtime.executionContextsCleared": Record<string, never>;
  "Log.entryAdded": {
    readonly entry: {
      readonly source?: string;
      readonly level?: string;
      readonly text: string;
    };
  };
  "Inspector.targetCrashed": Record<string, never>;
  "Target.attachedToTarget": {
    readonly sessionId: string;
    readonly targetInfo: CdpTargetInfo;
    readonly waitingForDebugger?: boolean;
  };
  "Target.detachedFromTarget": {
    readonly sessionId: string;
    readonly targetId?: string;
  };
  "Target.targetDestroyed": { readonly targetId: string };
  "Browser.downloadWillBegin": {
    readonly frameId?: string;
    readonly guid: string;
    readonly url: string;
    readonly suggestedFilename: string;
  };
  "Browser.downloadProgress": {
    readonly guid: string;
    readonly totalBytes?: number;
    readonly receivedBytes?: number;
    readonly state: "inProgress" | "completed" | "canceled";
  };
  close: void;
}
