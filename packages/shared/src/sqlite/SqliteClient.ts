import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

export type SqliteOperation = "open" | "prepare" | "execute" | "close";

export interface SqliteErrorInfo {
  readonly message: string;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
}

export class SqliteClientError extends Error {
  readonly operation: SqliteOperation;
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errno?: number;
  readonly errstr?: unknown;

  constructor(operation: SqliteOperation, info: SqliteErrorInfo, cause?: unknown) {
    super(info.message, cause !== undefined ? { cause } : undefined);
    this.name = "SqliteClientError";
    this.operation = operation;
    this.code = info.code;
    this.errcode = info.errcode;
    this.errstr = info.errstr;
    if (typeof info.errcode === "number") this.errno = info.errcode;
  }
}

export interface SqliteClientOptions {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly wal?: boolean | undefined;
  readonly busyTimeoutMs?: number | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly readerWorker?: boolean | undefined;
  readonly writerWorker?: boolean | undefined;
  readonly readerPoolSize?: number | undefined;
  /** Connection-local PRAGMAs every connection runs when it opens, including respawned workers. */
  readonly initPragmas?: string | undefined;
  readonly onCheckpointUnavailable?: ((reason: string) => void) | undefined;
}

export interface SqliteQueryOptions {
  readonly cached?: boolean | undefined;
  readonly values?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly safeIntegers?: boolean | undefined;
}

export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteTransactionHandle {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    options?: SqliteQueryOptions,
  ): Promise<ReadonlyArray<T>>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    options?: SqliteQueryOptions,
  ): Promise<T | undefined>;
  run(
    sql: string,
    params?: ReadonlyArray<unknown>,
    options?: SqliteQueryOptions,
  ): Promise<SqliteRunResult>;
  exec(sql: string): Promise<void>;
}

export const NOT_WAL_ERROR_CODE = "ERR_SQLITE_NOT_WAL";
const DEFAULT_PREPARE_CACHE_SIZE = 200;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_READER_POOL_SIZE = 4;
const CHECKPOINT_FRAMES = 1_000;
const CHECKPOINT_IDLE_MS = 100;
export const WRITER_BACKSTOP_FRAMES = 10_000;

export function checkNodeSqliteSupport() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return {
    supported: (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24,
    nodeVersion: process.versions.node,
    requirement: "Node.js >=22.16, >=23.11, or >=24",
  };
}

export const isFileDatabasePath = (filename: string) => filename !== ":memory:" && filename !== "";

// SQLite retains text/blob bindings until rebind or finalization; node:sqlite cannot clear them.
const LARGE_BINDING_SIZE = 64 * 1024;
const isBlob = (v: unknown): v is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(v) || NodeUtil.types.isAnyArrayBuffer(v);
const bindingSize = (v: unknown) =>
  typeof v === "string" ? v.length : isBlob(v) ? v.byteLength : 0;

function hasLargeBinding(params: ReadonlyArray<unknown>): boolean {
  try {
    let size = 0;
    for (const p of params) {
      if ((typeof p === "object" || typeof p === "function") && p !== null && !isBlob(p)) {
        for (const key in p) {
          if (!Object.hasOwn(p, key)) continue;
          // Accessors could run arbitrary code; treat them as large rather than invoking them.
          if (!("value" in Object.getOwnPropertyDescriptor(p, key)!)) return true;
          size += bindingSize((p as Record<string, unknown>)[key]);
        }
      } else size += bindingSize(p);
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
}

export function toSqliteError(operation: SqliteOperation, cause: unknown): SqliteClientError {
  if (cause instanceof SqliteClientError) return cause;
  const r =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;
  return new SqliteClientError(
    operation,
    {
      message: typeof r?.message === "string" ? r.message : String(cause),
      code: r?.code,
      errcode: r?.errcode,
      errstr: r?.errstr,
    },
    cause,
  );
}

/** O(1) Map-based LRU cache for prepared statements. */
export class StatementLruCache {
  private readonly capacity: number;
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly entries = new Map<string, NodeSqlite.StatementSync>();
  private readonly readerFlags = new WeakMap<NodeSqlite.StatementSync, boolean>();

  constructor(db: NodeSqlite.DatabaseSync, capacity = DEFAULT_PREPARE_CACHE_SIZE) {
    this.db = db;
    this.capacity = Math.max(1, capacity);
  }

  get size() {
    return this.entries.size;
  }

  prepare(sql: string, cached = true): NodeSqlite.StatementSync {
    if (!cached) {
      try {
        return this.db.prepare(sql);
      } catch (cause) {
        throw toSqliteError("prepare", cause);
      }
    }
    let stmt = this.entries.get(sql);
    if (stmt !== undefined) {
      this.entries.delete(sql);
      this.entries.set(sql, stmt);
      return stmt;
    }
    try {
      stmt = this.db.prepare(sql);
    } catch (cause) {
      throw toSqliteError("prepare", cause);
    }
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(sql, stmt);
    return stmt;
  }

  hasRows(stmt: NodeSqlite.StatementSync): boolean {
    let flag = this.readerFlags.get(stmt);
    if (flag === undefined) {
      flag = stmt.columns().length > 0;
      this.readerFlags.set(stmt, flag);
    }
    return flag;
  }

  delete(sql: string) {
    this.entries.delete(sql);
  }

  clear() {
    this.entries.clear();
  }
}

/** Synchronous direct node:sqlite connection with LRU prepared-statement cache. */
export class DirectSqliteConnection {
  readonly db: NodeSqlite.DatabaseSync;
  readonly cache: StatementLruCache;
  private closed = false;

  constructor(options: {
    readonly filename: string;
    readonly readonly?: boolean | undefined;
    readonly wal?: boolean | undefined;
    readonly busyTimeoutMs?: number | undefined;
    readonly prepareCacheSize?: number | undefined;
    readonly initPragmas?: string | undefined;
  }) {
    try {
      this.db = new NodeSqlite.DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: false,
      });
      if (options.busyTimeoutMs && options.busyTimeoutMs > 0) {
        this.db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs)};`);
      }
      if (
        options.wal === true &&
        options.readonly !== true &&
        isFileDatabasePath(options.filename)
      ) {
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
      if (options.initPragmas) this.db.exec(options.initPragmas);
    } catch (cause) {
      throw toSqliteError("open", cause);
    }
    this.cache = new StatementLruCache(this.db, options.prepareCacheSize);
  }

  execute(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    opts: SqliteQueryOptions = {},
  ): unknown {
    const cached = opts.cached !== false && !hasLargeBinding(params);
    const stmt = this.cache.prepare(sql, cached);
    let arrays = false;
    try {
      stmt.setReadBigInts(Boolean(opts.safeIntegers));
      if (this.cache.hasRows(stmt)) {
        arrays = opts.values === true;
        if (arrays) stmt.setReturnArrays(true);
        return stmt.all(...(params as ReadonlyArray<NodeSqlite.SQLInputValue>));
      }
      const res = stmt.run(...(params as ReadonlyArray<NodeSqlite.SQLInputValue>));
      return opts.raw ? res : [];
    } catch (cause) {
      if (cached) this.cache.delete(sql);
      throw toSqliteError("execute", cause);
    } finally {
      if (arrays) stmt.setReturnArrays(false);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (cause) {
      throw toSqliteError("execute", cause);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    try {
      this.db.close();
    } catch (cause) {
      throw toSqliteError("close", cause);
    }
  }
}

export interface WorkerRequestPayload {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
  readonly safeIntegers: boolean;
}

type WorkerStartup =
  | { readonly type: "ready" }
  | ({ readonly type: "unavailable" } & SqliteErrorInfo);
type WorkerReply =
  | { readonly id: number; readonly rows: unknown; readonly more?: boolean }
  | {
      readonly id: number;
      readonly error: SqliteErrorInfo & { readonly operation: SqliteOperation };
    };

// Inline worker sources run in bundles and single-executable builds without sidecar files.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const describe = (e) => ({ message: String(e && e.message ? e.message : e), code: e && e.code, errcode: e && e.errcode, errstr: e && e.errstr });
let db;
try {
  const next = new DatabaseSync(workerData.filename, { readOnly: workerData.readOnly, allowExtension: workerData.allowExtension });
  next.exec("PRAGMA busy_timeout = " + workerData.busyTimeoutMs + ";");
  if (workerData.enableWal && !workerData.readOnly) next.exec("PRAGMA journal_mode = WAL;");
  if (workerData.initPragmas) next.exec(workerData.initPragmas);
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (workerData.requireWal && mode !== "wal") throw Object.assign(new Error("database uses journal_mode " + mode + ", not wal"), { code: ${JSON.stringify(NOT_WAL_ERROR_CODE)} });
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (e) { parentPort.postMessage({ type: "unavailable", ...describe(e) }); }
// Each slot is single-flight, so one flag per worker paces every batched reply.
const received = workerData.received;
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) { const statement = db.prepare(sql); return { statement, hasRows: statement.columns().length > 0 }; }
  let s = statements.get(sql);
  if (s === undefined) {
    const statement = db.prepare(sql);
    s = { statement, hasRows: statement.columns().length > 0 };
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else statements.delete(sql);
  statements.set(sql, s);
  return s;
};
parentPort.on("message", (req) => {
  if (req.type === "close") { try { if (db) db.close(); } catch {} parentPort.close(); return; }
  const { id, sql, params, cached, values, raw, safeIntegers, savepoints } = req;
  let operation = "open", iterator;
  try {
    if (!db) throw new Error("database connection is unavailable");
    operation = "execute";
    if (savepoints !== undefined) for (const sp of savepoints) db.exec(sp);
    operation = "prepare";
    const { statement: s, hasRows } = prepare(sql, cached);
    operation = "execute";
    s.setReadBigInts(safeIntegers);
    if (hasRows) {
      s.setReturnArrays(values);
      let rows = [], bytes = 0, pendingBatch = false;
      iterator = s.iterate(...params);
      for (const row of iterator) {
        let rb = 0;
        for (const k in row) { const v = row[k]; rb += typeof v === "string" ? v.length * 2 : ArrayBuffer.isView(v) ? v.byteLength : 8; }
        if (rows.length > 0 && (rows.length >= 16384 || bytes + rb > 8 * 1024 * 1024)) {
          if (pendingBatch) Atomics.wait(received, 0, 0);
          Atomics.store(received, 0, 0);
          parentPort.postMessage({ id, rows, more: true });
          rows = []; bytes = 0; pendingBatch = true;
        }
        rows.push(row); bytes += rb;
      }
      if (pendingBatch) Atomics.wait(received, 0, 0);
      parentPort.postMessage({ id, rows });
    } else {
      const r = s.run(...params);
      parentPort.postMessage({ id, rows: raw ? r : [] });
    }
  } catch (e) {
    try { iterator?.return(); } catch {}
    statements.delete(sql);
    parentPort.postMessage({ id, error: { operation, ...describe(e) } });
  }
});`;

const CHECKPOINT_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db, frames, passive, idle;
const run = (force) => {
  clearTimeout(idle);
  try {
    if (!db) {
      db = new DatabaseSync(workerData.filename);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA checkpoint_fullfsync = ON;");
      frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
      passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
    }
    const before = frames.get();
    let state = before;
    if (state.log - state.checkpointed >= workerData.frames || (force && state.log > state.checkpointed)) {
      passive.get(); state = frames.get();
    }
    if (state.log > state.checkpointed && (!force || state.checkpointed > before.checkpointed)) {
      idle = setTimeout(() => run(true), workerData.idleMs);
    }
    parentPort.postMessage({ type: "checked", log: state.log, checkpointed: state.checkpointed });
  } catch (e) { parentPort.postMessage({ type: "failed", message: String(e && e.message ? e.message : e) }); }
};
parentPort.on("message", () => run(false));`;

export interface CheckpointHandle {
  readonly notify: () => void;
  readonly close: () => Promise<void>;
}

/** Spawns an off-loop passive WAL checkpoint worker (SQLite >= 3.51). */
export function startCheckpointWorker(
  filename: string,
  onUnavailable?: (reason: string) => void,
): CheckpointHandle | undefined {
  const probe = new NodeSqlite.DatabaseSync(":memory:");
  let version: string;
  try {
    version = String(probe.prepare("SELECT sqlite_version() AS v").get()?.v);
  } finally {
    probe.close();
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 51)) {
    onUnavailable?.(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(CHECKPOINT_WORKER_SOURCE, {
      eval: true,
      workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
    });
  } catch (cause) {
    onUnavailable?.(String(cause));
    return undefined;
  }
  worker.unref();
  let stopped = false;
  let scheduled = false;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    void worker.terminate();
    onUnavailable?.(reason);
  };
  worker.on("message", (msg: { readonly type?: unknown; readonly message?: unknown }) => {
    if (msg?.type === "failed") stop(String(msg.message));
  });
  worker.on("error", (err) => stop(err.message));
  worker.on("exit", (code) => stop(`exited with code ${code}`));
  return {
    notify: () => {
      if (stopped || scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        if (!stopped) worker.postMessage(0);
      });
    },
    close: async () => {
      stopped = true;
      await worker.terminate();
    },
  };
}

export interface WorkerInstance {
  readonly worker: NodeWorkerThreads.Worker;
  readonly started: Promise<WorkerStartup>;
  readonly send: (input: WorkerRequestPayload) => Promise<unknown>;
  readonly sendUnprepared: (
    sql: string,
    params: ReadonlyArray<unknown>,
    safeIntegers: boolean,
  ) => Promise<unknown>;
}

/** Manages one reader or writer worker_thread with batched row streaming and savepoint coalescing. */
export class SqliteWorkerSlot {
  readonly role: "reader" | "writer";
  readonly readOnly: boolean;
  private readonly filename: string;
  private readonly enableWal: boolean;
  private readonly busyTimeoutMs: number;
  private readonly prepareCacheSize: number;
  private readonly initPragmas: string | undefined;
  private readonly onReply: (() => void) | undefined;
  private current: WorkerInstance | undefined;
  private nextRequestId = 0;
  private readonly pendingSavepoints: string[] = [];
  private writerStopped: string | undefined;

  constructor(options: {
    readonly filename: string;
    readonly role: "reader" | "writer";
    readonly readOnly: boolean;
    readonly enableWal?: boolean | undefined;
    readonly busyTimeoutMs?: number | undefined;
    readonly prepareCacheSize?: number | undefined;
    readonly initPragmas?: string | undefined;
    readonly onReply?: (() => void) | undefined;
  }) {
    this.filename = options.filename;
    this.role = options.role;
    this.readOnly = options.readOnly;
    this.enableWal = options.enableWal ?? false;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.prepareCacheSize = options.prepareCacheSize ?? DEFAULT_PREPARE_CACHE_SIZE;
    this.initPragmas = options.initPragmas;
    this.onReply = options.onReply;
  }

  get label() {
    return this.role === "reader" ? "Database reader" : "Database writer";
  }

  private spawn(): WorkerInstance {
    const received = new Int32Array(new SharedArrayBuffer(4));
    const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        filename: this.filename,
        readOnly: this.readOnly,
        requireWal: this.role === "reader",
        enableWal: this.enableWal,
        busyTimeoutMs: this.busyTimeoutMs,
        allowExtension: false,
        prepareCacheSize: this.prepareCacheSize,
        initPragmas: this.initPragmas,
        received,
      },
    });
    let announce: (s: WorkerStartup) => void = () => {};
    const started = new Promise<WorkerStartup>((r) => (announce = r));
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      {
        readonly endsTx: boolean;
        readonly rows: unknown[];
        readonly resolve: (v: unknown) => void;
        readonly reject: (e: SqliteClientError) => void;
      }
    >();

    const stop = (message: string) => {
      stoppedMessage = message;
      if (this.role === "writer") this.writerStopped = message;
      announce({ type: "unavailable", message });
      if (this.current?.worker === worker) this.current = undefined;
      for (const req of pending.values()) {
        if (req.endsTx) req.resolve([]);
        else req.reject(new SqliteClientError("execute", { message }));
      }
      pending.clear();
    };

    worker.on("message", (reply: WorkerReply | WorkerStartup) => {
      if ("type" in reply) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const req = pending.get(reply.id);
      if (!req) return;
      if ("rows" in reply && reply.more) {
        for (const row of reply.rows as ReadonlyArray<unknown>) req.rows.push(row);
        Atomics.store(received, 0, 1);
        Atomics.notify(received, 0);
        return;
      }
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      this.onReply?.();
      if ("rows" in reply) {
        if (req.rows.length > 0) {
          for (const row of reply.rows as ReadonlyArray<unknown>) req.rows.push(row);
          req.resolve(req.rows);
        } else req.resolve(reply.rows);
      } else req.reject(new SqliteClientError(reply.error.operation, reply.error));
    });
    worker.on("error", (err) => stop(`${this.label} failed: ${err.message}`));
    worker.on("exit", (code) => stop(`${this.label} exited with code ${code}`));

    const send = (input: WorkerRequestPayload): Promise<unknown> => {
      const endsTx = this.readOnly
        ? /^\s*(?:ROLLBACK|COMMIT)\b/i.test(input.sql)
        : /^\s*ROLLBACK\b/i.test(input.sql);
      if (stoppedMessage !== undefined) {
        return endsTx
          ? Promise.resolve([])
          : Promise.reject(new SqliteClientError("execute", { message: stoppedMessage }));
      }
      return new Promise((resolve, reject) => {
        const id = this.nextRequestId++;
        pending.set(id, { endsTx, rows: [], resolve, reject });
        if (pending.size === 1) worker.ref();
        try {
          const request = {
            id,
            ...input,
            cached: input.cached && !hasLargeBinding(input.params),
            savepoints:
              this.pendingSavepoints.length === 0 ? undefined : this.pendingSavepoints.slice(),
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage(request);
          this.pendingSavepoints.length = 0;
        } catch (cause) {
          pending.delete(id);
          if (pending.size === 0) worker.unref();
          reject(toSqliteError("execute", cause));
        }
      });
    };

    const sendUnprepared = (
      sql: string,
      params: ReadonlyArray<unknown>,
      safeIntegers: boolean,
    ): Promise<unknown> => {
      const stmt = this.readOnly && /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
      if (!this.readOnly && /^SAVEPOINT effect_sql_\d+$/.test(stmt)) {
        this.pendingSavepoints.push(stmt);
        return Promise.resolve([]);
      }
      const rb = /^ROLLBACK TO SAVEPOINT (effect_sql_\d+)$/.exec(stmt);
      if (rb) {
        const idx = this.pendingSavepoints.lastIndexOf(`SAVEPOINT ${rb[1]}`);
        if (idx !== -1) {
          this.pendingSavepoints.splice(idx);
          return Promise.resolve([]);
        }
      }
      if (stmt === "COMMIT" || stmt === "ROLLBACK") this.pendingSavepoints.length = 0;
      return send({ sql: stmt, params, cached: false, values: false, raw: false, safeIntegers });
    };

    return (this.current = { worker, started, send, sendUnprepared });
  }

  getOrSpawn(): WorkerInstance {
    if (!this.current && this.writerStopped !== undefined) {
      throw new SqliteClientError("execute", { message: this.writerStopped });
    }
    if (this.current) return this.current;
    try {
      return this.spawn();
    } catch (cause) {
      throw toSqliteError("open", cause);
    }
  }

  isCurrent(instance: WorkerInstance) {
    return this.current === instance;
  }

  retire(worker: NodeWorkerThreads.Worker) {
    if (this.current?.worker === worker) this.current = undefined;
    void worker.terminate();
  }

  async acquire(timeoutMs?: number): Promise<WorkerInstance> {
    const instance = this.getOrSpawn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome =
      timeoutMs === undefined
        ? await instance.started
        : await Promise.race([
            instance.started,
            new Promise<undefined>((r) => {
              timer = setTimeout(() => r(undefined), timeoutMs);
              timer.unref?.();
            }),
          ]);
    if (timer) clearTimeout(timer);
    if (outcome?.type === "ready") {
      if (this.current === instance) return instance;
      throw new SqliteClientError("open", { message: `${this.label} stopped while starting` });
    }
    this.retire(instance.worker);
    throw new SqliteClientError(
      "open",
      outcome ?? { message: `${this.label} did not open the database within ${timeoutMs ?? 0} ms` },
    );
  }

  async close(): Promise<void> {
    const open = this.current;
    if (!open) return;
    this.current = undefined;
    if (this.role === "writer") {
      await new Promise<void>((resolve) => {
        open.worker.once("exit", () => resolve());
        open.worker.ref();
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        open.worker.postMessage({ type: "close" });
      });
    }
    await open.worker.terminate();
  }
}
