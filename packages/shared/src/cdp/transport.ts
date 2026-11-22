// Direct Chrome DevTools Protocol WebSocket transport using Node 22 native WebSocket.
// Multiplexes requests by monotonic id and routes flat sessionId messages and events.

import {
  CdpProtocolError,
  CdpTimeoutError,
  type CdpError,
  type CdpEventMap,
  type CdpMethodMap,
} from "./protocol.ts";

type Listener = (payload: any) => void;

const UTF8 = new TextDecoder();

export class SimpleEmitter<Events extends Record<string, any>> {
  private readonly listeners = new Map<string, Set<Listener>>();

  on<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this;
  on(event: string, listener: (payload: any) => void): this;
  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    this.onListenerChange(event, set.size);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this;
  once(event: string, listener: (payload: any) => void): this;
  once(event: string, listener: Listener): this {
    const wrapper: Listener = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  off<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this;
  off(event: string, listener: (payload: any) => void): this;
  off(event: string, listener: Listener): this {
    const set = this.listeners.get(event);
    if (!set) return this;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(event);
    this.onListenerChange(event, set.size);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): boolean;
  emit(event: string, payload?: unknown): boolean;
  emit(event: string, payload?: unknown): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of Array.from(set)) {
      try {
        listener(payload);
      } catch {
        // Keep listener dispatch isolated so one handler cannot break protocol routing.
      }
    }
    return true;
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  protected onListenerChange(_event: string, _count: number): void {}
}

export class CdpSession extends SimpleEmitter<CdpEventMap> {
  readonly sessionId: string | undefined;
  private readonly transport: CdpTransport;
  private closed = false;

  constructor(transport: CdpTransport, sessionId: string | undefined) {
    super();
    this.transport = transport;
    this.sessionId = sessionId;
  }

  isClosed(): boolean {
    return this.closed || this.transport.isClosed();
  }

  send<M extends keyof CdpMethodMap>(
    method: M,
    params?: CdpMethodMap[M]["params"],
  ): Promise<CdpMethodMap[M]["result"]>;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.closed) {
      return Promise.reject(
        new Error(`CDP session ${this.sessionId ?? "root"} is closed (${method}).`),
      );
    }
    return this.transport.send(method, params, this.sessionId);
  }

  async detach(): Promise<void> {
    if (this.closed) return;
    const id = this.sessionId;
    this.markClosed();
    if (id !== undefined) {
      this.transport.unregisterSession(id);
      if (!this.transport.isClosed()) {
        await this.transport.send("Target.detachFromTarget", { sessionId: id }).catch(() => {});
      }
    }
  }

  /** @internal */
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", undefined);
    this.removeAllListeners();
  }
}

interface PendingCommand {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

async function resolveCdpWebSocketUrl(endpoint: string, timeoutMs = 15_000): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const versionUrl = new URL("/json/version", endpoint).href;
  const response = await fetch(versionUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`CDP endpoint ${versionUrl} responded with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== "string" || body.webSocketDebuggerUrl.length === 0) {
    throw new Error(`CDP endpoint ${versionUrl} returned no webSocketDebuggerUrl.`);
  }
  return body.webSocketDebuggerUrl;
}

export class CdpTransport extends SimpleEmitter<{ disconnected: void }> {
  readonly root: CdpSession;
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly sessions = new Map<string, CdpSession>();
  private nextId = 1;
  private closed = false;

  private constructor(socket: WebSocket) {
    super();
    this.socket = socket;
    this.root = new CdpSession(this, undefined);

    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.handleClosed("CDP WebSocket closed.");
    });
    socket.addEventListener("error", () => {
      this.handleClosed("CDP WebSocket error.");
    });
  }

  static async connect(
    endpoint: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<CdpTransport> {
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const wsUrl = await resolveCdpWebSocketUrl(endpoint, timeoutMs);
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Ignore close failures on timed-out sockets.
        }
        reject(new CdpTimeoutError(`Timed out connecting to CDP endpoint after ${timeoutMs}ms.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to connect to CDP endpoint: ${wsUrl}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`CDP endpoint closed during handshake: ${wsUrl}`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
    return new CdpTransport(socket);
  }

  isClosed(): boolean {
    return this.closed;
  }

  createSession(sessionId: string): CdpSession {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.isClosed()) return existing;
    const session = new CdpSession(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): CdpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** @internal */
  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const [id, command] of this.pending) {
      if (command.sessionId === sessionId) {
        this.pending.delete(id);
        command.reject(new Error(`CDP session ${sessionId} detached (${command.method}).`));
      }
    }
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error(`CDP transport is closed (${method}).`));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId !== undefined) payload.sessionId = sessionId;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { method, sessionId, resolve, reject });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClosed("CDP transport closed by client.");
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    } catch {
      // Ignore socket close errors during teardown.
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = UTF8.decode(raw);
    } else if (raw instanceof Blob) {
      text = await raw.text();
    } else if (ArrayBuffer.isView(raw)) {
      text = UTF8.decode(raw);
    } else {
      return;
    }
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: CdpError;
      sessionId?: string;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      if (message.error) {
        command.reject(new CdpProtocolError(command.method, message.error));
      } else {
        command.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (message.method === "Target.detachedFromTarget") {
      const detachedId = message.params?.["sessionId"];
      if (typeof detachedId === "string") {
        const session = this.sessions.get(detachedId);
        if (session) {
          this.unregisterSession(detachedId);
          session.markClosed();
        }
      }
    }

    const params = message.params ?? {};
    if (message.sessionId !== undefined) {
      this.sessions.get(message.sessionId)?.emit(message.method, params);
    } else {
      this.root.emit(message.method, params);
    }
  }

  private handleClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(reason);
    for (const command of this.pending.values()) command.reject(error);
    this.pending.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.markClosed();
    this.root.markClosed();
    this.emit("disconnected", undefined);
  }
}
