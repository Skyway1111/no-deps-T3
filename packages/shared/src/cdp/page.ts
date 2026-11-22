// CDP-backed Page, Frame, Dialog, FileChooser, Download, ConsoleMessage, Request, Response, Mouse, Keyboard.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  buildAriaSnapshot,
  type AriaRefTarget,
  type AriaSnapshotOptions,
} from "./accessibility.ts";
import { describeKey, MODIFIER_BITS, parseKeyChord } from "./keys.ts";
import { CdpElementHandle, CdpLocator } from "./locator.ts";
import {
  CdpTimeoutError,
  type CdpExceptionDetails,
  type CdpFrameTree,
  type CdpRemoteObject,
} from "./protocol.ts";
import { CdpSession, SimpleEmitter } from "./transport.ts";
import type { CdpBrowserContext } from "./context.ts";

export type CdpFilePayload = {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
};

export type CdpFileInput = string | CdpFilePayload;

const exceptionMessage = (details: CdpExceptionDetails): string =>
  details.exception?.description ?? details.text;

const formatRemoteObject = (obj: CdpRemoteObject): string => {
  if ("value" in obj) {
    return typeof obj.value === "string" ? obj.value : String(obj.value);
  }
  if (obj.unserializableValue !== undefined) return obj.unserializableValue;
  return obj.description ?? obj.type;
};

export class CdpDialog {
  private readonly session: CdpSession;
  private readonly dialogType: string;
  private readonly dialogMessage: string;
  private readonly dialogDefaultValue: string;
  private handled = false;

  constructor(
    session: CdpSession,
    info: { readonly type: string; readonly message: string; readonly defaultPrompt?: string },
  ) {
    this.session = session;
    this.dialogType = info.type;
    this.dialogMessage = info.message;
    this.dialogDefaultValue = info.defaultPrompt ?? "";
  }

  type(): string {
    return this.dialogType;
  }

  message(): string {
    return this.dialogMessage;
  }

  defaultValue(): string {
    return this.dialogDefaultValue;
  }

  async accept(promptText?: string): Promise<void> {
    if (this.handled) return;
    this.handled = true;
    await this.session.send("Page.handleJavaScriptDialog", {
      accept: true,
      ...(promptText === undefined ? {} : { promptText }),
    });
  }

  async dismiss(): Promise<void> {
    if (this.handled) return;
    this.handled = true;
    await this.session.send("Page.handleJavaScriptDialog", { accept: false });
  }
}

export class CdpFileChooser {
  private readonly frame: CdpFrame;
  private readonly multiple: boolean;
  private readonly backendNodeId: number | undefined;
  private readonly stageUploadFile: (payload: CdpFilePayload) => Promise<string>;

  constructor(
    frame: CdpFrame,
    multiple: boolean,
    backendNodeId: number | undefined,
    stageUploadFile: (payload: CdpFilePayload) => Promise<string>,
  ) {
    this.frame = frame;
    this.multiple = multiple;
    this.backendNodeId = backendNodeId;
    this.stageUploadFile = stageUploadFile;
  }

  isMultiple(): boolean {
    return this.multiple;
  }

  element(): CdpElementHandle {
    return new CdpElementHandle(
      this.frame,
      this.backendNodeId === undefined ? {} : { backendNodeId: this.backendNodeId },
    );
  }

  async setFiles(
    files: CdpFileInput | ReadonlyArray<CdpFileInput>,
    _options?: { readonly timeout?: number },
  ): Promise<void> {
    const list = Array.isArray(files) ? files : [files];
    const resolvedPaths = await Promise.all(
      list.map((entry) =>
        typeof entry === "string" ? Promise.resolve(entry) : this.stageUploadFile(entry),
      ),
    );
    if (this.backendNodeId === undefined) {
      throw new Error("File chooser has no backing <input> node.");
    }
    await this.frame.session().send("DOM.setFileInputFiles", {
      backendNodeId: this.backendNodeId,
      files: resolvedPaths,
    });
  }
}

export class CdpDownload {
  readonly guid: string;
  private readonly downloadUrl: string;
  private readonly filename: string;
  private readonly sourcePath: string;
  private readonly completed = Promise.withResolvers<string | null>();

  constructor(options: {
    readonly guid: string;
    readonly url: string;
    readonly suggestedFilename: string;
    readonly downloadDir: string;
  }) {
    this.guid = options.guid;
    this.downloadUrl = options.url;
    this.filename = options.suggestedFilename;
    this.sourcePath = NodePath.join(options.downloadDir, options.guid);
  }

  url(): string {
    return this.downloadUrl;
  }

  suggestedFilename(): string {
    return this.filename;
  }

  failure(): Promise<string | null> {
    return this.completed.promise;
  }

  async path(): Promise<string | null> {
    const failed = await this.failure();
    return failed === null ? this.sourcePath : null;
  }

  async saveAs(destination: string): Promise<void> {
    const failed = await this.failure();
    if (failed !== null) throw new Error(`Download failed: ${failed}`);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(this.sourcePath, destination);
  }

  async delete(): Promise<void> {
    await this.failure().catch(() => {});
    await NodeFSP.rm(this.sourcePath, { force: true }).catch(() => {});
  }

  /** @internal */
  finish(state: "completed" | "canceled"): void {
    this.completed.resolve(state === "completed" ? null : "canceled");
  }
}

export class CdpConsoleMessage {
  private readonly msgType: string;
  private readonly msgText: string;
  private readonly msgArgs: ReadonlyArray<CdpRemoteObject>;

  constructor(type: string, text: string, args: ReadonlyArray<CdpRemoteObject>) {
    this.msgType = type;
    this.msgText = text;
    this.msgArgs = args;
  }

  type(): string {
    return this.msgType;
  }

  text(): string {
    return this.msgText;
  }

  args(): ReadonlyArray<CdpRemoteObject> {
    return this.msgArgs;
  }
}

export class CdpRequest {
  readonly requestId: string;
  private readonly reqUrl: string;
  private readonly reqMethod: string;
  private readonly navigation: boolean;
  private readonly reqFrame: CdpFrame | undefined;
  private failureReason: { readonly errorText: string } | null = null;

  constructor(options: {
    readonly requestId: string;
    readonly url: string;
    readonly method: string;
    readonly isNavigation: boolean;
    readonly frame: CdpFrame | undefined;
  }) {
    this.requestId = options.requestId;
    this.reqUrl = options.url;
    this.reqMethod = options.method;
    this.navigation = options.isNavigation;
    this.reqFrame = options.frame;
  }

  url(): string {
    return this.reqUrl;
  }

  method(): string {
    return this.reqMethod;
  }

  isNavigationRequest(): boolean {
    return this.navigation;
  }

  frame(): CdpFrame {
    if (!this.reqFrame) throw new Error("Frame for this request is not available.");
    return this.reqFrame;
  }

  failure(): { readonly errorText: string } | null {
    return this.failureReason;
  }

  /** @internal */
  setFailure(errorText: string): void {
    this.failureReason = { errorText };
  }
}

export class CdpResponse {
  private readonly resUrl: string;
  private readonly resStatus: number;
  private readonly req: CdpRequest;

  constructor(url: string, status: number, request: CdpRequest) {
    this.resUrl = url;
    this.resStatus = status;
    this.req = request;
  }

  url(): string {
    return this.resUrl;
  }

  status(): number {
    return this.resStatus;
  }

  request(): CdpRequest {
    return this.req;
  }
}

export class CdpFrame {
  readonly id: string;
  readonly page: CdpPage;
  targetId: string | undefined;
  private parent: CdpFrame | null;
  private ownerSession: CdpSession;
  private frameUrl: string;
  private detached = false;
  private contextId: number | undefined;

  constructor(options: {
    readonly id: string;
    readonly page: CdpPage;
    readonly session: CdpSession;
    readonly parent: CdpFrame | null;
    readonly url: string;
    readonly targetId?: string;
  }) {
    this.id = options.id;
    this.page = options.page;
    this.ownerSession = options.session;
    this.parent = options.parent;
    this.frameUrl = options.url;
    this.targetId = options.targetId;
  }

  url(): string {
    return this.frameUrl;
  }

  parentFrame(): CdpFrame | null {
    return this.parent;
  }

  isDetached(): boolean {
    return this.detached;
  }

  session(): CdpSession {
    return this.ownerSession;
  }

  defaultContextId(): number | undefined {
    return this.contextId;
  }

  /** @internal */
  setUrl(url: string): void {
    this.frameUrl = url;
  }

  /** @internal */
  setDetached(): void {
    this.detached = true;
  }

  /** @internal */
  setContextId(id: number | undefined): void {
    this.contextId = id;
  }

  /** @internal */
  bindSession(session: CdpSession, targetId: string): void {
    this.ownerSession = session;
    this.targetId = targetId;
    this.contextId = undefined;
  }

  evaluate<R = unknown>(expression: string): Promise<R>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  async evaluate<R = unknown, A = unknown>(
    pageFunction: string | ((arg: A) => R | Promise<R>),
    arg?: A,
  ): Promise<R> {
    const expression =
      typeof pageFunction === "string"
        ? pageFunction
        : arg === undefined
          ? `(${pageFunction.toString()})()`
          : `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
    const isMainOrOopif = this.parent === null || this.targetId !== undefined;
    const contextId = !isMainOrOopif ? this.contextId : undefined;
    const response = await this.ownerSession.send("Runtime.evaluate", {
      expression,
      ...(contextId === undefined ? {} : { contextId }),
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(exceptionMessage(response.exceptionDetails));
    }
    return response.result.value as R;
  }
}

const BUTTON_MASK: Readonly<Record<"none" | "left" | "middle" | "right", number>> = {
  none: 0,
  left: 1,
  right: 2,
  middle: 4,
};

export class CdpMouse {
  private readonly session: CdpSession;
  private x = 0;
  private y = 0;
  private buttons = 0;

  constructor(session: CdpSession) {
    this.session = session;
  }

  async move(x: number, y: number, options?: { readonly steps?: number }): Promise<void> {
    const steps = Math.max(1, options?.steps ?? 1);
    const fromX = this.x;
    const fromY = this.y;
    for (let i = 1; i <= steps; i += 1) {
      const nextX = fromX + ((x - fromX) * i) / steps;
      const nextY = fromY + ((y - fromY) * i) / steps;
      this.x = nextX;
      this.y = nextY;
      await this.session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: nextX,
        y: nextY,
        button:
          this.buttons & 1
            ? "left"
            : this.buttons & 2
              ? "right"
              : this.buttons & 4
                ? "middle"
                : "none",
        buttons: this.buttons,
      });
    }
  }

  async down(options?: {
    readonly button?: "left" | "middle" | "right";
    readonly clickCount?: number;
  }): Promise<void> {
    const button = options?.button ?? "left";
    this.buttons |= BUTTON_MASK[button];
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: this.x,
      y: this.y,
      button,
      buttons: this.buttons,
      clickCount: options?.clickCount ?? 1,
    });
  }

  async up(options?: {
    readonly button?: "left" | "middle" | "right";
    readonly clickCount?: number;
  }): Promise<void> {
    const button = options?.button ?? "left";
    this.buttons &= ~BUTTON_MASK[button];
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: this.x,
      y: this.y,
      button,
      buttons: this.buttons,
      clickCount: options?.clickCount ?? 1,
    });
  }

  async click(
    x: number,
    y: number,
    options?: { readonly button?: "left" | "middle" | "right"; readonly clickCount?: number },
  ): Promise<void> {
    const button = options?.button ?? "left";
    const clickCount = options?.clickCount ?? 1;
    await this.move(x, y);
    for (let count = 1; count <= clickCount; count += 1) {
      await this.down({ button, clickCount: count });
      await this.up({ button, clickCount: count });
    }
  }
}

export class CdpKeyboard {
  private readonly session: CdpSession;
  private modifiers = 0;

  constructor(session: CdpSession) {
    this.session = session;
  }

  async down(key: string): Promise<void> {
    const desc = describeKey(key);
    const bit = MODIFIER_BITS[desc.key];
    if (bit !== undefined) this.modifiers |= bit;
    const hasText = desc.text !== undefined && (this.modifiers & ~8) === 0;
    await this.session.send("Input.dispatchKeyEvent", {
      type: hasText ? "keyDown" : "rawKeyDown",
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
      modifiers: this.modifiers,
      ...(hasText ? { text: desc.text, unmodifiedText: desc.text } : {}),
      ...(desc.location === undefined ? {} : { location: desc.location }),
    });
  }

  async up(key: string): Promise<void> {
    const desc = describeKey(key);
    const bit = MODIFIER_BITS[desc.key];
    if (bit !== undefined) this.modifiers &= ~bit;
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.keyCode,
      nativeVirtualKeyCode: desc.keyCode,
      modifiers: this.modifiers,
      ...(desc.location === undefined ? {} : { location: desc.location }),
    });
  }

  async press(chord: string): Promise<void> {
    const parsed = parseKeyChord(chord);
    for (const mod of parsed.modifiers) {
      const bit = MODIFIER_BITS[mod.key] ?? 0;
      this.modifiers |= bit;
      await this.session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: mod.key,
        code: mod.code,
        windowsVirtualKeyCode: mod.keyCode,
        modifiers: this.modifiers,
        ...(mod.location === undefined ? {} : { location: mod.location }),
      });
    }
    const effectiveModifiers = this.modifiers | parsed.modifierMask;
    const hasText = parsed.main.text !== undefined && (effectiveModifiers & ~8) === 0;
    await this.session.send("Input.dispatchKeyEvent", {
      type: hasText ? "keyDown" : "rawKeyDown",
      key: parsed.main.key,
      code: parsed.main.code,
      windowsVirtualKeyCode: parsed.main.keyCode,
      nativeVirtualKeyCode: parsed.main.keyCode,
      modifiers: effectiveModifiers,
      ...(hasText ? { text: parsed.main.text, unmodifiedText: parsed.main.text } : {}),
      ...(parsed.commands ? { commands: parsed.commands } : {}),
    });
    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: parsed.main.key,
      code: parsed.main.code,
      windowsVirtualKeyCode: parsed.main.keyCode,
      nativeVirtualKeyCode: parsed.main.keyCode,
      modifiers: effectiveModifiers,
    });
    for (const mod of [...parsed.modifiers].reverse()) {
      const bit = MODIFIER_BITS[mod.key] ?? 0;
      this.modifiers &= ~bit;
      await this.session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mod.key,
        code: mod.code,
        windowsVirtualKeyCode: mod.keyCode,
        modifiers: this.modifiers,
        ...(mod.location === undefined ? {} : { location: mod.location }),
      });
    }
  }

  async insertText(text: string): Promise<void> {
    await this.session.send("Input.insertText", { text });
  }
}

export interface CdpPageEventMap {
  request: CdpRequest;
  requestfailed: CdpRequest;
  response: CdpResponse;
  load: CdpPage;
  domcontentloaded: CdpPage;
  framenavigated: CdpFrame;
  framedetached: CdpFrame;
  console: CdpConsoleMessage;
  dialog: CdpDialog;
  download: CdpDownload;
  filechooser: CdpFileChooser;
  popup: CdpPage;
  close: CdpPage;
  crash: CdpPage;
}

export class CdpPage extends SimpleEmitter<CdpPageEventMap> {
  readonly targetId: string;
  readonly mouse: CdpMouse;
  readonly keyboard: CdpKeyboard;
  private readonly browserContext: CdpBrowserContext;
  private readonly pageSession: CdpSession;
  private readonly frameMap = new Map<string, CdpFrame>();
  private readonly requestsById = new Map<string, CdpRequest>();
  private readonly exposedBindings = new Map<string, (...args: Array<unknown>) => unknown>();
  private readonly ariaRefs = new Map<string, AriaRefTarget>();
  private readonly main: CdpFrame;
  private viewport: { width: number; height: number } | null;
  private deviceScaleFactor: number;
  private closed = false;
  private timeoutMs = 30_000;
  private navigationTimeoutMs = 30_000;
  private fileChooserInterceptEnabled = false;
  private pendingDownloadNavigation: PromiseWithResolvers<void> | null = null;
  private readonly isRemote: boolean;

  constructor(options: {
    readonly context: CdpBrowserContext;
    readonly session: CdpSession;
    readonly targetId: string;
    readonly initialUrl: string;
    readonly viewport: { readonly width: number; readonly height: number } | null;
    readonly deviceScaleFactor: number;
    readonly isRemote: boolean;
  }) {
    super();
    this.browserContext = options.context;
    this.pageSession = options.session;
    this.targetId = options.targetId;
    this.viewport = options.viewport ? { ...options.viewport } : null;
    this.deviceScaleFactor = options.deviceScaleFactor;
    this.isRemote = options.isRemote;
    this.mouse = new CdpMouse(options.session);
    this.keyboard = new CdpKeyboard(options.session);
    this.main = new CdpFrame({
      id: options.targetId,
      page: this,
      session: options.session,
      parent: null,
      url: options.initialUrl || "about:blank",
      targetId: options.targetId,
    });
    this.frameMap.set(this.main.id, this.main);
    this.wireSessionEvents(options.session, this.main);
  }

  /** @internal */
  async initialize(): Promise<void> {
    await Promise.all([
      this.pageSession.send("Page.enable"),
      this.pageSession.send("Runtime.enable"),
      this.pageSession.send("Network.enable"),
      this.pageSession.send("Log.enable").catch(() => {}),
    ]);
    const tree = await this.pageSession.send("Page.getFrameTree").catch(() => null);
    if (tree) this.syncFrameTree(tree.frameTree, this.pageSession);
    if (this.viewport && !this.isRemote) {
      await this.setViewportSize(this.viewport);
    }
    await this.pageSession
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })
      .catch(() => {});
  }

  /** @internal */
  session(): CdpSession {
    return this.pageSession;
  }

  context(): CdpBrowserContext {
    return this.browserContext;
  }

  url(): string {
    return this.main.url();
  }

  async title(): Promise<string> {
    const result = await this.main.evaluate("document.title");
    return typeof result === "string" ? result : "";
  }

  isClosed(): boolean {
    return this.closed;
  }

  mainFrame(): CdpFrame {
    return this.main;
  }

  frames(): ReadonlyArray<CdpFrame> {
    return [...this.frameMap.values()].filter((frame) => !frame.isDetached());
  }

  viewportSize(): { width: number; height: number } | null {
    return this.viewport ? { ...this.viewport } : null;
  }

  async setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void> {
    this.viewport = { width: size.width, height: size.height };
    await this.pageSession.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: this.deviceScaleFactor,
      mobile: false,
    });
  }

  async emulateMedia(options: {
    readonly colorScheme?: "light" | "dark" | "no-preference" | null;
  }): Promise<void> {
    const features: Array<{ readonly name: string; readonly value: string }> = [];
    if ("colorScheme" in options) {
      features.push({
        name: "prefers-color-scheme",
        value: options.colorScheme ?? "",
      });
    }
    await this.pageSession.send("Emulation.setEmulatedMedia", { features });
  }

  setDefaultTimeout(timeout: number): void {
    this.timeoutMs = timeout;
  }

  setDefaultNavigationTimeout(timeout: number): void {
    this.navigationTimeoutMs = timeout;
  }

  defaultTimeout(): number {
    return this.timeoutMs;
  }

  locator(selector: string): CdpLocator {
    return new CdpLocator(this, selector);
  }

  /** @internal */
  resolveAriaRef(ref: string): AriaRefTarget | undefined {
    return this.ariaRefs.get(ref);
  }

  async ariaSnapshot(options?: AriaSnapshotOptions): Promise<string> {
    const timeoutMs = options?.timeout ?? this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = buildAriaSnapshot(this.main, this.frames(), {
      ...options,
      timeout: timeoutMs,
    });
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CdpTimeoutError(`page.ariaSnapshot: Timeout ${timeoutMs}ms exceeded.`)),
        timeoutMs,
      );
    });
    const { yaml, refs } = await Promise.race([work, expired]).finally(() => clearTimeout(timer));
    this.ariaRefs.clear();
    for (const [key, value] of refs) this.ariaRefs.set(key, value);
    return yaml;
  }

  evaluate<R = unknown>(expression: string): Promise<R>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  async evaluate<R = unknown, A = unknown>(
    pageFunction: string | ((arg: A) => R | Promise<R>),
    arg?: A,
  ): Promise<R> {
    return this.main.evaluate(pageFunction as any, arg);
  }

  async exposeFunction(
    name: string,
    callback: (...args: Array<unknown>) => unknown,
  ): Promise<void> {
    this.exposedBindings.set(name, callback);
    await this.pageSession.send("Runtime.addBinding", { name });
    // Wrap the raw string-payload CDP binding so callers can invoke `globalThis[name](...args)`.
    const wrapper = `(() => {
      const raw = globalThis[${JSON.stringify(name)}];
      if (typeof raw !== "function" || raw.__t3Wrapped) return;
      const wrapped = (...args) => { raw(JSON.stringify(args)); };
      wrapped.__t3Wrapped = true;
      globalThis[${JSON.stringify(name)}] = wrapped;
    })()`;
    await this.pageSession
      .send("Page.addScriptToEvaluateOnNewDocument", { source: wrapper })
      .catch(() => {});
    await this.pageSession.send("Runtime.evaluate", { expression: wrapper }).catch(() => {});
  }

  async goto(
    url: string,
    options?: {
      readonly waitUntil?: "commit" | "domcontentloaded" | "load";
      readonly timeout?: number;
    },
  ): Promise<void> {
    const waitUntil = options?.waitUntil ?? "load";
    const timeoutMs = options?.timeout ?? this.navigationTimeoutMs;
    await this.runNavigation(
      async () => {
        const result = await this.pageSession.send("Page.navigate", { url });
        if (result.errorText) {
          if (result.errorText.includes("ERR_ABORTED") && this.pendingDownloadNavigation === null) {
            throw new Error(`page.goto: ${result.errorText} at ${url}`);
          }
          if (!result.errorText.includes("ERR_ABORTED")) {
            throw new Error(`page.goto: ${result.errorText} at ${url}`);
          }
          // ERR_ABORTED may be a download; wait briefly for Browser.downloadWillBegin.
          const race = await Promise.race([
            this.pendingDownloadNavigation!.promise.then(() => "download" as const),
            new Promise<"aborted">((resolve) => setTimeout(() => resolve("aborted"), 100)),
          ]);
          if (race === "download") throw new Error("page.goto: Download is starting");
          throw new Error(`page.goto: ${result.errorText} at ${url}`);
        }
        return result.loaderId;
      },
      waitUntil,
      timeoutMs,
      `page.goto(${url})`,
    );
  }

  async reload(options?: {
    readonly waitUntil?: "commit" | "domcontentloaded" | "load";
    readonly timeout?: number;
  }): Promise<void> {
    const waitUntil = options?.waitUntil ?? "load";
    const timeoutMs = options?.timeout ?? this.navigationTimeoutMs;
    await this.runNavigation(
      async () => {
        await this.pageSession.send("Page.reload", {});
        return undefined;
      },
      waitUntil,
      timeoutMs,
      "page.reload",
    );
  }

  async goBack(options?: {
    readonly waitUntil?: "commit" | "domcontentloaded" | "load";
    readonly timeout?: number;
  }): Promise<void> {
    await this.navigateHistory(-1, options);
  }

  async goForward(options?: {
    readonly waitUntil?: "commit" | "domcontentloaded" | "load";
    readonly timeout?: number;
  }): Promise<void> {
    await this.navigateHistory(1, options);
  }

  private async navigateHistory(
    delta: -1 | 1,
    options?: {
      readonly waitUntil?: "commit" | "domcontentloaded" | "load";
      readonly timeout?: number;
    },
  ): Promise<void> {
    const history = await this.pageSession.send("Page.getNavigationHistory");
    const next = history.entries[history.currentIndex + delta];
    if (!next) return;
    await this.runNavigation(
      async () => {
        await this.pageSession.send("Page.navigateToHistoryEntry", { entryId: next.id });
        return undefined;
      },
      options?.waitUntil ?? "load",
      options?.timeout ?? this.navigationTimeoutMs,
      delta < 0 ? "page.goBack" : "page.goForward",
    );
  }

  private async runNavigation(
    trigger: () => Promise<string | undefined>,
    waitUntil: "commit" | "domcontentloaded" | "load",
    timeoutMs: number,
    label: string,
  ): Promise<void> {
    const downloadSignal = Promise.withResolvers<void>();
    this.pendingDownloadNavigation = downloadSignal;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const committed = Promise.withResolvers<void>();
    const onNav = (frame: CdpFrame) => {
      if (frame === this.main) committed.resolve();
    };
    const onDcl = () => {
      if (waitUntil === "domcontentloaded") committed.resolve();
    };
    const onLoad = () => {
      if (waitUntil === "load") committed.resolve();
    };
    const onClose = () => {
      committed.reject(new Error(`${label}: Target page, context or browser has been closed`));
    };

    if (waitUntil === "commit") this.on("framenavigated", onNav);
    else if (waitUntil === "domcontentloaded") this.on("domcontentloaded", onDcl);
    else this.on("load", onLoad);
    this.once("close", onClose);

    try {
      const waitPromise = Promise.race([
        committed.promise,
        downloadSignal.promise.then(() => {
          throw new Error(`${label}: Download is starting`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (!settled) {
              reject(new CdpTimeoutError(`${label}: Timeout ${timeoutMs}ms exceeded.`));
            }
          }, timeoutMs);
        }),
      ]);
      // Prevent unhandled rejection if trigger() rejects before waitPromise is awaited.
      void waitPromise.catch(() => {});

      const loaderId = await trigger();
      // Same-document hash navigations return no loaderId and settle immediately on commit.
      if (waitUntil === "commit" && loaderId === undefined) return;
      await waitPromise;
    } finally {
      settled = true;
      clearTimeout(timer);
      if (this.pendingDownloadNavigation === downloadSignal) {
        this.pendingDownloadNavigation = null;
      }
      this.off("framenavigated", onNav);
      this.off("domcontentloaded", onDcl);
      this.off("load", onLoad);
      this.off("close", onClose);
    }
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" = "load",
    options?: { readonly timeout?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeout ?? this.navigationTimeoutMs;
    const readyState = await this.main.evaluate("document.readyState").catch(() => "");
    if (readyState === "complete") return;
    if (state === "domcontentloaded" && readyState === "interactive") return;
    await this.waitForEvent(state, { timeout: timeoutMs });
  }

  async waitForEvent<K extends keyof CdpPageEventMap & string>(
    event: K,
    options?: { readonly timeout?: number },
  ): Promise<CdpPageEventMap[K]> {
    const timeoutMs = options?.timeout ?? this.timeoutMs;
    return new Promise<CdpPageEventMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new CdpTimeoutError(`page.waitForEvent(${event}): Timeout ${timeoutMs}ms exceeded.`),
        );
      }, timeoutMs);
      const onEvent = (payload: CdpPageEventMap[K]) => {
        cleanup();
        resolve(payload);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Target page closed while waiting for event "${event}".`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, onEvent);
        this.off("close", onClose);
      };
      this.once(event, onEvent);
      if (event !== "close") this.once("close", onClose);
    });
  }

  async close(options?: { readonly runBeforeUnload?: boolean }): Promise<void> {
    if (this.closed) return;
    if (options?.runBeforeUnload || this.isRemote) {
      await this.pageSession.send("Page.close").catch(() => {});
      return;
    }
    await this.browserContext.closePageTarget(this);
  }

  /** @internal */
  notifyDownload(download: CdpDownload): void {
    this.pendingDownloadNavigation?.resolve();
    this.emit("download", download);
  }

  /** @internal */
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const frame of this.frameMap.values()) frame.setDetached();
    this.ariaRefs.clear();
    this.emit("close", this);
    this.removeAllListeners();
  }

  protected override onListenerChange(event: string, count: number): void {
    if (event !== "filechooser" || this.closed) return;
    const enabled = count > 0;
    if (enabled === this.fileChooserInterceptEnabled) return;
    this.fileChooserInterceptEnabled = enabled;
    void this.pageSession.send("Page.setInterceptFileChooserDialog", { enabled }).catch(() => {});
  }

  private syncFrameTree(tree: CdpFrameTree, session: CdpSession): void {
    const visit = (node: CdpFrameTree, parent: CdpFrame | null) => {
      const existing = this.frameMap.get(node.frame.id);
      const url = node.frame.url + (node.frame.urlFragment ?? "");
      let frame: CdpFrame;
      if (existing) {
        existing.setUrl(url);
        frame = existing;
      } else if (parent === null) {
        // Re-key the main frame to Chromium's real frameId if it differed from targetId.
        if (this.main.id !== node.frame.id) {
          this.frameMap.delete(this.main.id);
          Object.defineProperty(this.main, "id", { value: node.frame.id, writable: false });
          this.frameMap.set(node.frame.id, this.main);
        }
        this.main.setUrl(url);
        frame = this.main;
      } else {
        frame = new CdpFrame({
          id: node.frame.id,
          page: this,
          session,
          parent,
          url,
        });
        this.frameMap.set(frame.id, frame);
      }
      for (const child of node.childFrames ?? []) visit(child, frame);
    };
    visit(tree, null);
  }

  private wireSessionEvents(session: CdpSession, rootFrame: CdpFrame): void {
    session.on("Page.frameAttached", ({ frameId, parentFrameId }) => {
      if (this.frameMap.has(frameId)) return;
      const parent = this.frameMap.get(parentFrameId) ?? rootFrame;
      const frame = new CdpFrame({
        id: frameId,
        page: this,
        session,
        parent,
        url: "about:blank",
      });
      this.frameMap.set(frameId, frame);
    });

    session.on("Page.frameNavigated", ({ frame: info }) => {
      const url = info.url + (info.urlFragment ?? "");
      let frame = this.frameMap.get(info.id);
      if (!frame) {
        if (!info.parentId) {
          this.main.setUrl(url);
          frame = this.main;
        } else {
          frame = new CdpFrame({
            id: info.id,
            page: this,
            session,
            parent: this.frameMap.get(info.parentId) ?? rootFrame,
            url,
          });
          this.frameMap.set(info.id, frame);
        }
      } else {
        frame.setUrl(url);
      }
      this.emit("framenavigated", frame);
    });

    session.on("Page.navigatedWithinDocument", ({ frameId, url }) => {
      const frame = this.frameMap.get(frameId);
      if (!frame) return;
      frame.setUrl(url);
      this.emit("framenavigated", frame);
    });

    session.on("Page.frameDetached", ({ frameId }) => {
      const frame = this.frameMap.get(frameId);
      if (!frame || frame === this.main) return;
      frame.setDetached();
      this.frameMap.delete(frameId);
      this.emit("framedetached", frame);
    });

    session.on("Page.loadEventFired", () => {
      if (session === this.pageSession) this.emit("load", this);
    });

    session.on("Page.domContentLoadedEventFired", () => {
      if (session === this.pageSession) this.emit("domcontentloaded", this);
    });

    session.on("Page.javascriptDialogOpening", (event) => {
      const dialog = new CdpDialog(session, event);
      this.emit("dialog", dialog);
    });

    session.on("Page.fileChooserOpened", (event) => {
      const frame = (event.frameId ? this.frameMap.get(event.frameId) : undefined) ?? rootFrame;
      const chooser = new CdpFileChooser(
        frame,
        event.mode === "selectMultiple",
        event.backendNodeId,
        (payload) => this.browserContext.stageUploadFile(payload),
      );
      this.emit("filechooser", chooser);
    });

    session.on("Network.requestWillBeSent", (event) => {
      const frame = event.frameId ? this.frameMap.get(event.frameId) : undefined;
      const isNavigation =
        event.type === "Document" ||
        (event.loaderId !== undefined && event.loaderId === event.requestId);
      const request = new CdpRequest({
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        isNavigation,
        frame,
      });
      this.requestsById.set(event.requestId, request);
      if (this.requestsById.size > 1000) {
        const oldest = this.requestsById.keys().next().value;
        if (oldest !== undefined) this.requestsById.delete(oldest);
      }
      this.emit("request", request);
    });

    session.on("Network.responseReceived", (event) => {
      const request =
        this.requestsById.get(event.requestId) ??
        new CdpRequest({
          requestId: event.requestId,
          url: event.response.url,
          method: "GET",
          isNavigation: event.type === "Document",
          frame: event.frameId ? this.frameMap.get(event.frameId) : undefined,
        });
      this.emit("response", new CdpResponse(event.response.url, event.response.status, request));
    });

    session.on("Network.loadingFailed", (event) => {
      const request = this.requestsById.get(event.requestId);
      if (!request) return;
      request.setFailure(
        event.errorText || (event.canceled ? "net::ERR_ABORTED" : "net::ERR_FAILED"),
      );
      this.requestsById.delete(event.requestId);
      this.emit("requestfailed", request);
    });

    // A finished request gets no further events, so it no longer needs to be found by id.
    session.on("Network.loadingFinished", (event: { readonly requestId: string }) => {
      this.requestsById.delete(event.requestId);
    });

    session.on("Runtime.consoleAPICalled", (event) => {
      const text = event.args.map(formatRemoteObject).join(" ");
      this.emit("console", new CdpConsoleMessage(event.type, text, event.args));
    });

    session.on("Log.entryAdded", (event) => {
      this.emit("console", new CdpConsoleMessage(event.entry.level ?? "log", event.entry.text, []));
    });

    session.on("Runtime.executionContextCreated", ({ context }) => {
      const frameId = context.auxData?.frameId;
      if (frameId && context.auxData?.isDefault) {
        this.frameMap.get(frameId)?.setContextId(context.id);
      }
    });

    session.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      for (const frame of this.frameMap.values()) {
        if (frame.defaultContextId() === executionContextId) frame.setContextId(undefined);
      }
    });

    session.on("Runtime.executionContextsCleared", () => {
      for (const frame of this.frameMap.values()) {
        if (frame.session() === session) frame.setContextId(undefined);
      }
    });

    session.on("Runtime.bindingCalled", ({ name, payload }) => {
      const handler = this.exposedBindings.get(name);
      if (!handler) return;
      let args: Array<unknown> = [];
      try {
        const parsed = JSON.parse(payload);
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        args = [payload];
      }
      try {
        void handler(...args);
      } catch {
        // Ignore user callback throws in CDP event loop.
      }
    });

    session.on("Inspector.targetCrashed", () => {
      if (session === this.pageSession) this.emit("crash", this);
    });

    session.on("Target.attachedToTarget", (event) => {
      void this.handleChildTargetAttached(event);
    });

    if (session === this.pageSession) {
      session.on("close", () => this.markClosed());
    }
  }

  private async handleChildTargetAttached(event: {
    readonly sessionId: string;
    readonly targetInfo: { readonly targetId: string; readonly type: string; readonly url: string };
    readonly waitingForDebugger?: boolean;
  }): Promise<void> {
    const childSession = this.browserContext.transport().createSession(event.sessionId);
    const { type, targetId, url } = event.targetInfo;

    if (type === "iframe") {
      let frame = this.frameMap.get(targetId);
      if (frame) {
        frame.bindSession(childSession, targetId);
      } else {
        frame = new CdpFrame({
          id: targetId,
          page: this,
          session: childSession,
          parent: this.main,
          url: url || "about:blank",
          targetId,
        });
        this.frameMap.set(targetId, frame);
      }
      this.wireSessionEvents(childSession, frame);
      await Promise.all([
        childSession.send("Page.enable").catch(() => {}),
        childSession.send("Runtime.enable").catch(() => {}),
        childSession.send("Network.enable").catch(() => {}),
        childSession
          .send("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          })
          .catch(() => {}),
      ]);
      if (event.waitingForDebugger) {
        await childSession.send("Runtime.runIfWaitingForDebugger").catch(() => {});
      }
      return;
    }

    if (event.waitingForDebugger) {
      const workerScript = this.browserContext.workerInitScript();
      if (
        workerScript &&
        (type === "service_worker" || type === "worker" || type === "shared_worker")
      ) {
        await childSession.send("Runtime.evaluate", { expression: workerScript }).catch(() => {});
      }
      await childSession.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    }
  }
}

export const uniqueUploadName = (name: string): string => {
  const safeBase = NodePath.basename(name || "upload").replace(/[^\w.-]/g, "_") || "upload";
  return `${NodeCrypto.randomUUID()}-${safeBase}`;
};
