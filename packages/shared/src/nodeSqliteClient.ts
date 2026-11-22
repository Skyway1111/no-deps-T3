import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import {
  DEFAULT_READER_POOL_SIZE,
  DirectSqliteConnection,
  NOT_WAL_ERROR_CODE,
  SqliteClientError,
  SqliteWorkerSlot,
  WRITER_BACKSTOP_FRAMES,
  checkNodeSqliteSupport,
  isFileDatabasePath,
  startCheckpointWorker,
  toSqliteError,
  type SqliteOperation,
} from "./sqlite/SqliteClient.ts";

export { SqliteClient } from "./sqlite/SqliteClient.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const READER_STARTUP_TIMEOUT = Duration.seconds(10);
const READER_RETRY_DELAY = Duration.seconds(1);
const READER_RETRY_MAX_DELAY = Duration.minutes(1);

const OPERATION_MESSAGES: Record<SqliteOperation, string> = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
  close: "Failed to close database",
};

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly readerWorker?: boolean | undefined;
  readonly writerWorker?: boolean | undefined;
  /** Connection-local PRAGMAs every connection runs when it opens, including respawned readers. */
  readonly pragmas?: string | undefined;
}

const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@t3tools/shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}
interface ConnectionOwner {
  readonly fiberId: number;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>): ConnectionOwner => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") break;
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

const annotateAcquired = (
  fiber: Fiber.Fiber<unknown, unknown>,
  acq?: Acquired,
  owner?: ConnectionOwner,
) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || !acq) return;
  span.attribute("db.connection", acq.connection);
  span.attribute("db.lock_wait_ms", acq.lockWaitMs);
  if (owner) {
    span.attribute("db.lock_owner_at_start.fiber_id", owner.fiberId);
    span.attribute("db.lock_owner_at_start.name", owner.name);
    if (owner.traceId !== undefined)
      span.attribute("db.lock_owner_at_start.trace_id", owner.traceId);
    if (owner.spanId !== undefined) span.attribute("db.lock_owner_at_start.span_id", owner.spanId);
  }
};

const TransactionAcquire = Context.Reference<
  | {
      acquired?: Acquired;
      ownerAtWaitStart: ConnectionOwner | undefined;
      restore: typeof Effect.interruptible | undefined;
    }
  | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  { nodeVersion: Schema.String, requirement: Schema.String },
) {
  override get message() {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message() {
    return "Node SQLite does not support executeStream.";
  }
}

// SqliteClientError carries node:sqlite's numeric errcode as errno, which the classifier reads.
const toSqlError = (cause: unknown, fallbackOp: SqliteOperation = "execute"): SqlError => {
  const error = toSqliteError(fallbackOp, cause);
  return new SqlError({
    reason: classifySqliteError(error, {
      message: OPERATION_MESSAGES[error.operation],
      operation: error.operation,
    }),
  });
};

const wrapConnection = (
  run: (
    sql: string,
    params: ReadonlyArray<unknown>,
    opts: { cached: boolean; values: boolean; raw: boolean; unprepared?: boolean },
  ) => Effect.Effect<ReadonlyArray<any>, SqlError>,
): Connection => ({
  execute: (sql, params, tx) => {
    const e = run(sql, params, { cached: true, values: false, raw: false });
    return tx ? Effect.map(e, tx) : e;
  },
  executeRaw: (sql, params) => run(sql, params, { cached: true, values: false, raw: true }),
  executeValues: (sql, params) => run(sql, params, { cached: true, values: true, raw: false }),
  executeValuesUnprepared: (sql, params) =>
    run(sql, params ?? [], { cached: false, values: true, raw: false }),
  executeUnprepared: (sql, params, tx) => {
    const e = run(sql, params ?? [], {
      cached: false,
      values: false,
      raw: false,
      unprepared: true,
    });
    return tx ? Effect.map(e, tx) : e;
  },
  executeStream: () => Stream.die(new UnsupportedNodeSqliteOperationError()),
});

const makeDirectConnection = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const direct = yield* Effect.try({
    try: () =>
      new DirectSqliteConnection({
        filename: options.filename,
        readonly: options.readonly ?? false,
        wal: false,
        initPragmas: options.pragmas,
      }),
    catch: (cause) => toSqlError(cause, "open"),
  });
  yield* Effect.addFinalizer(() =>
    Effect.try({ try: () => direct.close(), catch: (c) => toSqlError(c, "close") }).pipe(
      Effect.orDie,
    ),
  );
  return wrapConnection((sql, params, opts) =>
    Effect.withFiber((fiber) => {
      try {
        return Effect.succeed(
          direct.execute(sql, params, {
            ...opts,
            safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          }) as ReadonlyArray<any>,
        );
      } catch (cause) {
        return Effect.fail(toSqlError(cause, "execute"));
      }
    }),
  );
});

const makeWorkerConnection = Effect.fnUntraced(function* (options: {
  readonly filename: string;
  readonly role: "reader" | "writer";
  readonly readOnly: boolean;
  readonly initPragmas?: string | undefined;
  readonly onReply?: () => void;
}) {
  const slot = new SqliteWorkerSlot({ ...options, enableWal: false });
  yield* Effect.addFinalizer(() => Effect.promise(() => slot.close()));

  return Effect.suspend((): Effect.Effect<Connection, SqlError> => {
    let instance: ReturnType<SqliteWorkerSlot["getOrSpawn"]>;
    try {
      instance = slot.getOrSpawn();
    } catch (cause) {
      return Effect.fail(toSqlError(cause, "open"));
    }
    const started = Effect.promise(() => instance.started);
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        return restore(
          options.role === "reader"
            ? Effect.timeoutOption(started, READER_STARTUP_TIMEOUT)
            : Effect.asSome(started),
        );
      }),
      (startup): Effect.Effect<Connection, SqlError> => {
        const outcome = Option.getOrUndefined(startup);
        if (outcome?.type === "ready") {
          if (!slot.isCurrent(instance))
            return Effect.fail(
              toSqlError(
                new SqliteClientError("open", { message: `${slot.label} stopped while starting` }),
                "open",
              ),
            );
          return Effect.succeed(
            wrapConnection((sql, params, opts) =>
              Effect.withFiber((fiber) => {
                const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
                const reply = Effect.tryPromise({
                  try: () =>
                    opts.unprepared
                      ? instance.sendUnprepared(sql, params, safeIntegers)
                      : instance.send({ sql, params, ...opts, safeIntegers }),
                  catch: (cause) => toSqlError(cause, "execute"),
                }) as Effect.Effect<ReadonlyArray<any>, SqlError>;
                return options.role === "writer" ? Effect.uninterruptible(reply) : reply;
              }),
            ),
          );
        }
        slot.retire(instance.worker);
        return Effect.fail(
          toSqlError(
            new SqliteClientError(
              "open",
              outcome ?? {
                message: `${slot.label} did not open the database within ${Duration.toMillis(READER_STARTUP_TIMEOUT)} ms`,
              },
            ),
            "open",
          ),
        );
      },
    );
  });
});

const startFailure = (error: SqlError) => {
  const cause = error.reason.cause;
  return {
    reason: cause instanceof Error ? cause.message : error.message,
    permanent: Predicate.hasProperty(cause, "code") && cause.code === NOT_WAL_ERROR_CODE,
  };
};

const makeReader = Effect.fnUntraced(function* (
  filename: string,
  initPragmas: string | undefined,
  pool: { unavailable: boolean },
) {
  const acquire = yield* makeWorkerConnection({
    filename,
    role: "reader",
    readOnly: true,
    initPragmas,
  });
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const recover = (delay: Duration.Duration): Effect.Effect<void> =>
    Effect.sleep(delay).pipe(
      Effect.andThen(acquire),
      Effect.matchEffect({
        onSuccess: () =>
          Effect.suspend(() => {
            pool.unavailable = false;
            return Effect.logInfo(
              "SQLite reader worker available again; reads use the reader workers",
            );
          }),
        onFailure: (error) => {
          const { reason, permanent } = startFailure(error);
          return permanent
            ? Effect.logInfo(
                "SQLite reader worker retries stopped permanently; reads use the writer",
                { reason },
              )
            : recover(Duration.min(Duration.times(delay, 2), READER_RETRY_MAX_DELAY));
        },
      }),
    );

  return Effect.suspend((): Effect.Effect<Connection | undefined> =>
    pool.unavailable
      ? Effect.undefined
      : acquire.pipe(
          Effect.map((conn) => (pool.unavailable ? undefined : conn)),
          Effect.catch((error) => {
            if (pool.unavailable) return Effect.undefined;
            pool.unavailable = true;
            const { reason, permanent } = startFailure(error);
            return Effect.logWarning("SQLite reader worker unavailable; reads use the writer", {
              reason,
            }).pipe(
              Effect.andThen(
                permanent ? Effect.void : Effect.forkIn(recover(READER_RETRY_DELAY), scope),
              ),
              Effect.updateContext((_: Context.Context<never>) => context),
              Effect.as(undefined),
            );
          }),
        ),
  );
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  const compat = checkNodeSqliteSupport();
  if (!compat.supported) {
    return yield* Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: compat.nodeVersion,
        requirement: compat.requirement,
      }),
    );
  }

  const isFile = isFileDatabasePath(options.filename);
  const semaphore = yield* Semaphore.make(1);
  const writerWorker = options.writerWorker === true && isFile;
  let checkpointAfterWrite: (() => void) | undefined;
  const writerConnection: Effect.Effect<Connection, SqlError> = writerWorker
    ? yield* makeWorkerConnection({
        filename: options.filename,
        role: "writer",
        readOnly: options.readonly ?? false,
        initPragmas: options.pragmas,
        onReply: () => checkpointAfterWrite?.(),
      })
    : Effect.succeed(yield* makeDirectConnection(options));

  const opened = yield* writerConnection;
  if (writerWorker && options.readonly !== true) {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const checkpoint = startCheckpointWorker(options.filename, (reason) => {
      runFork(
        Effect.logWarning(
          "SQLite checkpoint worker unavailable; the writer checkpoints its own WAL",
          { reason },
        ),
      );
    });
    if (checkpoint) {
      yield* Effect.addFinalizer(() => Effect.promise(() => checkpoint.close()));
      checkpointAfterWrite = checkpoint.notify;
      yield* opened.executeUnprepared(
        `PRAGMA wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES}`,
        [],
        undefined,
      );
    }
  }

  const readerPool = { unavailable: false };
  const readers =
    options.readerWorker && isFile
      ? yield* Effect.forEach(Array.from({ length: DEFAULT_READER_POOL_SIZE }), () =>
          Effect.map(
            Effect.all([
              makeReader(options.filename, options.pragmas, readerPool),
              Semaphore.make(1),
            ]),
            ([acquire, lock]) => ({ acquire, lock, claimed: false }),
          ),
        )
      : [];
  const readerAdmission = yield* Semaphore.make(readers.length);

  type Target = {
    readonly name: Acquired["connection"];
    readonly lock: Semaphore.Semaphore;
    readonly connection: Connection;
  };
  const writer = Effect.map(writerConnection, (connection): Target => ({
    name: "writer",
    lock: semaphore,
    connection,
  }));
  let activeWriter: ConnectionOwner | undefined;

  const route = (
    claimed: (release: Effect.Effect<void>) => Effect.Effect<void>,
    restore: typeof Effect.interruptible,
  ) =>
    Effect.withFiber((fiber): Effect.Effect<Target, SqlError> => {
      if (readers.length === 0 || readerPool.unavailable || !Context.get(fiber.context, ReadOnly))
        return writer;
      const claim = Effect.andThen(
        restore(readerAdmission.take(1)),
        Effect.suspend(() => {
          const reader = readers.find((s) => !s.claimed)!;
          reader.claimed = true;
          const release = Effect.andThen(
            Effect.sync(() => {
              reader.claimed = false;
            }),
            readerAdmission.release(1),
          );
          return Effect.as(claimed(release), reader);
        }),
      );
      return Effect.flatMap(
        Effect.provideService(claim, Scheduler.PreventSchedulerYield, true),
        (reader) =>
          Effect.flatMap(Effect.provideService(reader.acquire, ReadOnly, restore), (conn) =>
            conn === undefined
              ? writer
              : Effect.succeed<Target>({ name: "reader", lock: reader.lock, connection: conn }),
          ),
      );
    });

  const acquired = (name: Acquired["connection"], clock: Clock.Clock, start: bigint): Acquired => ({
    connection: name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const borrower: Borrower = (use) =>
    Effect.uninterruptibleMask((restore) => {
      let release: Effect.Effect<void> = Effect.void;
      return Effect.withFiber((fiber) => {
        const start = fiber.getRef(Clock.Clock).monotonicTimeNanosUnsafe();
        return Effect.flatMap(
          route(
            (next) =>
              Effect.sync(() => {
                release = next;
              }),
            restore,
          ),
          (target) =>
            restore(
              Effect.withFiber((f) => {
                const clock = f.getRef(Clock.Clock);
                const ownerAtStart = target.name === "writer" ? activeWriter : undefined;
                const owner = target.name === "writer" ? connectionOwner(f) : undefined;
                const body = Effect.suspend(() => {
                  if (target.name === "writer") activeWriter = owner;
                  if (
                    f.getRef(References.TracerEnabled) &&
                    f.getRef(Statement.SpanPropagationEnabled)
                  ) {
                    annotateAcquired(f, acquired(target.name, clock, start), ownerAtStart);
                  }
                  return use(target.connection);
                });
                const owned =
                  target.name === "writer"
                    ? Effect.onExit(body, () =>
                        Effect.sync(() => {
                          if (activeWriter === owner) activeWriter = undefined;
                        }),
                      )
                    : body;
                return target.lock.withPermits(1)(owned);
              }),
            ),
        );
      }).pipe(Effect.ensuring(Effect.suspend(() => release)));
    });

  const transactionAcquirer = Effect.uninterruptibleMask((maskRestore) =>
    Effect.withFiber((fiber) => {
      const start = fiber.getRef(Clock.Clock).monotonicTimeNanosUnsafe();
      const pending = fiber.getRef(TransactionAcquire);
      const restore = pending?.restore ?? maskRestore;
      return Effect.flatMap(
        route(
          (rel) =>
            Effect.withFiber((f) =>
              Scope.addFinalizer(Context.getUnsafe(f.context, Scope.Scope), rel),
            ),
          restore,
        ),
        (target) => {
          const scope = Context.getUnsafe(fiber.context, Scope.Scope);
          const clock = fiber.getRef(Clock.Clock);
          const ownerAtStart = target.name === "writer" ? activeWriter : undefined;
          const owner = target.name === "writer" ? connectionOwner(fiber) : undefined;
          const acquire = Effect.tap(restore(target.lock.take(1)), () => {
            if (target.name === "writer") activeWriter = owner;
            if (pending) {
              pending.acquired = acquired(target.name, clock, start);
              pending.ownerAtWaitStart = ownerAtStart;
            }
            return Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                if (target.name === "writer" && activeWriter === owner) activeWriter = undefined;
              }).pipe(Effect.andThen(target.lock.release(1))),
            );
          });
          return Effect.as(
            Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
            target.connection,
          );
        },
      );
    }),
  );

  const client = yield* Client.make({
    driver: "node:sqlite",
    acquirer: transactionAcquirer,
    borrower,
    compiler: Statement.makeCompilerSqlite(),
    transactionAcquirer,
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        const pending: {
          acquired?: Acquired;
          ownerAtWaitStart: ConnectionOwner | undefined;
          restore: typeof Effect.interruptible | undefined;
        } = {
          ownerAtWaitStart: undefined,
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired, pending.ownerAtWaitStart);
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
