// CDP Browser and BrowserContext lifecycle: launch, persistent profiles, and connectOverCdp.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { launchChromium, type LaunchChromiumOptions, type LaunchedChromium } from "./launcher.ts";
import { CdpDownload, CdpFrame, CdpPage, uniqueUploadName, type CdpFilePayload } from "./page.ts";
import { CdpSession, CdpTransport, SimpleEmitter } from "./transport.ts";

export interface CdpContextOptions {
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly deviceScaleFactor?: number;
}

export interface LaunchCdpBrowserOptions extends LaunchChromiumOptions {
  /** Optional JS snippet evaluated in paused worker targets before Runtime.runIfWaitingForDebugger. */
  readonly workerInitScript?: string;
}

const PERMISSION_MAP: Readonly<Record<string, string>> = {
  "clipboard-read": "clipboardReadWrite",
  "clipboard-write": "clipboardSanitizedWrite",
  geolocation: "geolocation",
  notifications: "notifications",
  microphone: "audioCapture",
  camera: "videoCapture",
};

export class CdpBrowserContext extends SimpleEmitter<{ close: CdpBrowserContext; page: CdpPage }> {
  readonly browserContextId: string | undefined;
  private readonly cdpTransport: CdpTransport;
  private readonly ownerBrowser: CdpBrowser;
  private readonly pageList = new Set<CdpPage>();
  private readonly pagesByTargetId = new Map<string, CdpPage>();
  private readonly adoptingByTargetId = new Map<string, Promise<CdpPage>>();
  private readonly options: CdpContextOptions;
  private readonly ownsBrowser: boolean;
  private readonly isRemote: boolean;
  private downloadDir: string | undefined;
  private uploadDir: string | undefined;
  private closed = false;

  constructor(params: {
    readonly browser: CdpBrowser;
    readonly transport: CdpTransport;
    readonly browserContextId: string | undefined;
    readonly options: CdpContextOptions;
    readonly ownsBrowser: boolean;
    readonly isRemote: boolean;
  }) {
    super();
    this.ownerBrowser = params.browser;
    this.cdpTransport = params.transport;
    this.browserContextId = params.browserContextId;
    this.options = params.options;
    this.ownsBrowser = params.ownsBrowser;
    this.isRemote = params.isRemote;
  }

  /** @internal */
  transport(): CdpTransport {
    return this.cdpTransport;
  }

  /** @internal */
  workerInitScript(): string | undefined {
    return this.ownerBrowser.workerInitScript;
  }

  pages(): ReadonlyArray<CdpPage> {
    return [...this.pageList].filter((page) => !page.isClosed());
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** @internal */
  async ensureDownloadBehavior(): Promise<string> {
    if (this.downloadDir !== undefined) return this.downloadDir;
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cdp-downloads-"));
    this.downloadDir = dir;
    await this.cdpTransport.root
      .send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        ...(this.browserContextId === undefined ? {} : { browserContextId: this.browserContextId }),
        downloadPath: dir,
        eventsEnabled: true,
      })
      .catch(() => {});
    return dir;
  }

  /** @internal */
  async stageUploadFile(payload: CdpFilePayload): Promise<string> {
    if (this.uploadDir === undefined) {
      this.uploadDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cdp-uploads-"));
    }
    const filePath = NodePath.join(this.uploadDir, uniqueUploadName(payload.name));
    await NodeFSP.writeFile(filePath, payload.buffer, { mode: 0o600 });
    return filePath;
  }

  async newPage(): Promise<CdpPage> {
    if (this.closed) throw new Error("BrowserContext is closed.");
    await this.ensureDownloadBehavior();
    const { targetId } = await this.cdpTransport.root.send("Target.createTarget", {
      url: "about:blank",
      ...(this.browserContextId === undefined ? {} : { browserContextId: this.browserContextId }),
    });
    const { sessionId } = await this.cdpTransport.root.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return this.adoptTarget({ targetId, sessionId, url: "about:blank" });
  }

  /** @internal */
  adoptTarget(info: {
    readonly targetId: string;
    readonly sessionId: string;
    readonly url: string;
    readonly openerId?: string;
  }): Promise<CdpPage> {
    const existing = this.pagesByTargetId.get(info.targetId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.adoptingByTargetId.get(info.targetId);
    if (inFlight) return inFlight;

    const adopting = (async () => {
      await this.ensureDownloadBehavior();
      const session = this.cdpTransport.createSession(info.sessionId);
      const page = new CdpPage({
        context: this,
        session,
        targetId: info.targetId,
        initialUrl: info.url,
        viewport:
          this.options.viewport === undefined
            ? this.isRemote
              ? null
              : { width: 1280, height: 800 }
            : this.options.viewport,
        deviceScaleFactor: this.options.deviceScaleFactor ?? 1,
        isRemote: this.isRemote,
      });
      this.pageList.add(page);
      this.pagesByTargetId.set(info.targetId, page);
      page.once("close", () => {
        this.pageList.delete(page);
        this.pagesByTargetId.delete(info.targetId);
      });
      await page.initialize();
      this.emit("page", page);
      if (info.openerId) {
        const opener = this.pagesByTargetId.get(info.openerId);
        if (opener && !opener.isClosed()) opener.emit("popup", page);
      }
      return page;
    })().finally(() => {
      this.adoptingByTargetId.delete(info.targetId);
    });

    this.adoptingByTargetId.set(info.targetId, adopting);
    return adopting;
  }

  async newCDPSession(target: CdpPage | CdpFrame): Promise<CdpSession> {
    const targetId = target instanceof CdpPage ? target.targetId : target.targetId;
    if (!targetId) {
      throw new Error("Frame does not have a separate CDP target.");
    }
    const { sessionId } = await this.cdpTransport.root.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return this.cdpTransport.createSession(sessionId);
  }

  async grantPermissions(permissions: ReadonlyArray<string>): Promise<void> {
    const mapped = permissions.map((perm) => PERMISSION_MAP[perm] ?? perm);
    await this.cdpTransport.root
      .send("Browser.grantPermissions", {
        permissions: mapped,
        ...(this.browserContextId === undefined ? {} : { browserContextId: this.browserContextId }),
      })
      .catch(() => {});
  }

  /** @internal */
  async closePageTarget(page: CdpPage): Promise<void> {
    await this.cdpTransport.root
      .send("Target.closeTarget", { targetId: page.targetId })
      .catch(() => {});
    page.markClosed();
  }

  /** @internal */
  findPageByFrameId(frameId: string | undefined): CdpPage | undefined {
    if (frameId) {
      for (const page of this.pageList) {
        if (page.frames().some((frame) => frame.id === frameId) || page.targetId === frameId) {
          return page;
        }
      }
    }
    return this.pages()[0];
  }

  /** @internal */
  getDownloadDir(): string | undefined {
    return this.downloadDir;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const page of [...this.pageList]) {
      if (!this.isRemote && !this.cdpTransport.isClosed()) {
        await this.cdpTransport.root
          .send("Target.closeTarget", { targetId: page.targetId })
          .catch(() => {});
      }
      page.markClosed();
    }

    if (
      !this.isRemote &&
      !this.ownsBrowser &&
      this.browserContextId !== undefined &&
      !this.cdpTransport.isClosed()
    ) {
      await this.cdpTransport.root
        .send("Target.disposeBrowserContext", { browserContextId: this.browserContextId })
        .catch(() => {});
    }

    this.ownerBrowser.unregisterContext(this);
    this.emit("close", this);
    this.removeAllListeners();

    if (this.downloadDir) {
      await NodeFSP.rm(this.downloadDir, { recursive: true, force: true }).catch(() => {});
    }
    if (this.uploadDir) {
      await NodeFSP.rm(this.uploadDir, { recursive: true, force: true }).catch(() => {});
    }

    if (this.ownsBrowser) {
      await this.ownerBrowser.close();
    }
  }

  /** @internal */
  markClosedFromBrowser(): void {
    if (this.closed) return;
    this.closed = true;
    for (const page of [...this.pageList]) page.markClosed();
    this.emit("close", this);
    this.removeAllListeners();
    if (this.downloadDir) {
      void NodeFSP.rm(this.downloadDir, { recursive: true, force: true }).catch(() => {});
    }
    if (this.uploadDir) {
      void NodeFSP.rm(this.uploadDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export class CdpBrowser extends SimpleEmitter<{ disconnected: void }> {
  readonly workerInitScript: string | undefined;
  private readonly cdpTransport: CdpTransport;
  private readonly launched: LaunchedChromium | undefined;
  private readonly isRemote: boolean;
  private readonly contextMap = new Map<string, CdpBrowserContext>();
  private readonly defaultContextKey = "__default__";
  private readonly downloads = new Map<string, CdpDownload>();
  private closed = false;

  constructor(options: {
    readonly transport: CdpTransport;
    readonly launched?: LaunchedChromium;
    readonly isRemote: boolean;
    readonly workerInitScript?: string;
  }) {
    super();
    this.cdpTransport = options.transport;
    this.launched = options.launched;
    this.isRemote = options.isRemote;
    this.workerInitScript = options.workerInitScript;

    this.cdpTransport.on("disconnected", () => {
      this.handleDisconnected();
    });

    this.cdpTransport.root.on("Target.attachedToTarget", (event) => {
      void this.handleAttachedTarget(event);
    });

    this.cdpTransport.root.on("Target.targetDestroyed", ({ targetId }) => {
      for (const context of this.contextMap.values()) {
        const page = context.pages().find((candidate) => candidate.targetId === targetId);
        if (page) page.markClosed();
      }
    });

    this.cdpTransport.root.on("Browser.downloadWillBegin", (event) => {
      let targetPage: CdpPage | undefined;
      let targetContext: CdpBrowserContext | undefined;
      for (const context of this.contextMap.values()) {
        const found = context.findPageByFrameId(event.frameId);
        if (found) {
          targetPage = found;
          targetContext = context;
          break;
        }
      }
      const downloadDir = targetContext?.getDownloadDir();
      if (!targetPage || !downloadDir) return;
      const download = new CdpDownload({
        guid: event.guid,
        url: event.url,
        suggestedFilename: event.suggestedFilename,
        downloadDir,
      });
      this.downloads.set(event.guid, download);
      targetPage.notifyDownload(download);
    });

    this.cdpTransport.root.on("Browser.downloadProgress", (event) => {
      if (event.state === "inProgress") return;
      const download = this.downloads.get(event.guid);
      if (!download) return;
      this.downloads.delete(event.guid);
      download.finish(event.state);
    });
  }

  contexts(): ReadonlyArray<CdpBrowserContext> {
    return [...this.contextMap.values()].filter((ctx) => !ctx.isClosed());
  }

  async newContext(options: CdpContextOptions = {}): Promise<CdpBrowserContext> {
    if (this.closed) throw new Error("Browser is closed.");
    const { browserContextId } = await this.cdpTransport.root.send("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    const context = new CdpBrowserContext({
      browser: this,
      transport: this.cdpTransport,
      browserContextId,
      options,
      ownsBrowser: false,
      isRemote: this.isRemote,
    });
    this.contextMap.set(browserContextId, context);
    return context;
  }

  /** @internal */
  ensureDefaultContext(
    options: CdpContextOptions,
    ownsBrowser: boolean,
    browserContextId?: string,
  ): CdpBrowserContext {
    const key = browserContextId ?? this.defaultContextKey;
    const existing = this.contextMap.get(key);
    if (existing) return existing;
    const context = new CdpBrowserContext({
      browser: this,
      transport: this.cdpTransport,
      browserContextId,
      options,
      ownsBrowser,
      isRemote: this.isRemote,
    });
    this.contextMap.set(key, context);
    return context;
  }

  /** @internal */
  unregisterContext(context: CdpBrowserContext): void {
    const key = context.browserContextId ?? this.defaultContextKey;
    if (this.contextMap.get(key) === context) this.contextMap.delete(key);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const context of [...this.contextMap.values()]) {
      context.markClosedFromBrowser();
    }
    this.contextMap.clear();
    if (!this.isRemote && !this.cdpTransport.isClosed()) {
      await this.cdpTransport.root.send("Browser.close").catch(() => {});
    }
    await this.cdpTransport.close().catch(() => {});
    await this.launched?.close().catch(() => {});
    this.emit("disconnected", undefined);
    this.removeAllListeners();
  }

  private handleDisconnected(): void {
    if (this.closed) return;
    this.closed = true;
    for (const context of [...this.contextMap.values()]) {
      context.markClosedFromBrowser();
    }
    this.contextMap.clear();
    this.emit("disconnected", undefined);
    this.removeAllListeners();
  }

  private async handleAttachedTarget(event: {
    readonly sessionId: string;
    readonly targetInfo: {
      readonly targetId: string;
      readonly type: string;
      readonly url: string;
      readonly openerId?: string;
      readonly browserContextId?: string;
    };
    readonly waitingForDebugger?: boolean;
  }): Promise<void> {
    const { targetInfo, sessionId, waitingForDebugger } = event;
    if (targetInfo.type === "page") {
      const key = targetInfo.browserContextId ?? this.defaultContextKey;
      const context =
        this.contextMap.get(key) ??
        this.contextMap.get(this.defaultContextKey) ??
        this.ensureDefaultContext({}, false, targetInfo.browserContextId);
      await context
        .adoptTarget({
          targetId: targetInfo.targetId,
          sessionId,
          url: targetInfo.url,
          ...(targetInfo.openerId === undefined ? {} : { openerId: targetInfo.openerId }),
        })
        .catch(() => {});
      if (waitingForDebugger) {
        const session = this.cdpTransport.getSession(sessionId);
        await session?.send("Runtime.runIfWaitingForDebugger").catch(() => {});
      }
      return;
    }

    if (waitingForDebugger) {
      const session = this.cdpTransport.createSession(sessionId);
      if (
        this.workerInitScript &&
        (targetInfo.type === "service_worker" ||
          targetInfo.type === "worker" ||
          targetInfo.type === "shared_worker")
      ) {
        await session.send("Runtime.evaluate", { expression: this.workerInitScript }).catch(() => {});
      }
      await session.send("Runtime.runIfWaitingForDebugger").catch(() => {});
    }
  }
}

export async function launchCdpBrowser(options: LaunchCdpBrowserOptions = {}): Promise<CdpBrowser> {
  const launched = await launchChromium(options);
  try {
    const transport = await CdpTransport.connect(launched.wsEndpoint, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const browser = new CdpBrowser({
      transport,
      launched,
      isRemote: false,
      ...(options.workerInitScript === undefined
        ? {}
        : { workerInitScript: options.workerInitScript }),
    });
    await transport.root
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })
      .catch(() => {});
    return browser;
  } catch (cause) {
    await launched.close().catch(() => {});
    throw cause;
  }
}

export async function launchPersistentCdpContext(
  userDataDir: string,
  options: LaunchCdpBrowserOptions & CdpContextOptions = {},
): Promise<CdpBrowserContext> {
  const { viewport, deviceScaleFactor, ...launchOptions } = options;
  const launched = await launchChromium({ ...launchOptions, userDataDir });
  try {
    const transport = await CdpTransport.connect(launched.wsEndpoint, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const browser = new CdpBrowser({
      transport,
      launched,
      isRemote: false,
      ...(options.workerInitScript === undefined
        ? {}
        : { workerInitScript: options.workerInitScript }),
    });
    const context = browser.ensureDefaultContext(
      {
        ...(viewport === undefined ? {} : { viewport }),
        ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      },
      true,
    );
    await context.ensureDownloadBehavior();
    await transport.root
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })
      .catch(() => {});
    // Attach any initial page opened by Chromium on startup so context.pages() sees it.
    const { targetInfos } = await transport.root.send("Target.getTargets").catch(() => ({
      targetInfos: [],
    }));
    for (const info of targetInfos) {
      if (info.type !== "page") continue;
      if (context.pages().some((page) => page.targetId === info.targetId)) continue;
      const attached = await transport.root
        .send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
        .catch(() => null);
      if (attached) {
        await context.adoptTarget({
          targetId: info.targetId,
          sessionId: attached.sessionId,
          url: info.url,
        });
      }
    }
    return context;
  } catch (cause) {
    await launched.close().catch(() => {});
    throw cause;
  }
}

export async function connectOverCdp(
  endpoint: string,
  options?: { readonly timeout?: number },
): Promise<CdpBrowser> {
  const transport = await CdpTransport.connect(endpoint, {
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  });
  const browser = new CdpBrowser({ transport, isRemote: true });
  // Track Target.attachedToTarget adoption promises so existing pages are ready before returning.
  const pendingAdoptions: Array<Promise<void>> = [];
  const onAttach = (event: {
    readonly sessionId: string;
    readonly targetInfo: {
      readonly targetId: string;
      readonly type: string;
      readonly url: string;
      readonly openerId?: string;
      readonly browserContextId?: string;
    };
  }) => {
    if (event.targetInfo.type !== "page") return;
    const context = browser.ensureDefaultContext({}, false, event.targetInfo.browserContextId);
    pendingAdoptions.push(
      context
        .adoptTarget({
          targetId: event.targetInfo.targetId,
          sessionId: event.sessionId,
          url: event.targetInfo.url,
          ...(event.targetInfo.openerId === undefined
            ? {}
            : { openerId: event.targetInfo.openerId }),
        })
        .then(() => undefined, () => undefined),
    );
  };
  transport.root.on("Target.attachedToTarget", onAttach);
  try {
    await transport.root.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    // Sending Target.getTargets flushes any Target.attachedToTarget announcements queued on the wire.
    const { targetInfos } = await transport.root.send("Target.getTargets").catch(() => ({
      targetInfos: [],
    }));
    await Promise.all(pendingAdoptions);
    // Attach any page target not yet auto-attached (e.g. direct Chrome DevTools endpoints).
    for (const info of targetInfos) {
      if (info.type !== "page") continue;
      const already = browser
        .contexts()
        .some((ctx) => ctx.pages().some((page) => page.targetId === info.targetId));
      if (already) continue;
      const attached = await transport.root
        .send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
        .catch(() => null);
      if (attached) {
        const context = browser.ensureDefaultContext({}, false, info.browserContextId);
        await context.adoptTarget({
          targetId: info.targetId,
          sessionId: attached.sessionId,
          url: info.url,
        });
      }
    }
    return browser;
  } catch (cause) {
    await browser.close().catch(() => {});
    throw cause;
  } finally {
    transport.root.off("Target.attachedToTarget", onAttach);
  }
}
