import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";

import { createKeyedLock } from "./core/async.ts";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 * Backed by the O(1) zero-copy FIFO lock in `core/async.ts`.
 */
export const make = Effect.fn("KeyedLock.make")(function* <Key>(): Effect.fn.Return<
  KeyedLock<Key>
> {
  const core = createKeyedLock<Key>();

  const acquire = (key: Key) =>
    Effect.callback<() => void>((resume) => {
      const cancel = core.acquireCallback(key, (release) => {
        resume(Effect.succeed(release));
      });
      return Effect.sync(cancel);
    });

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        () => effect,
        (release) => Effect.sync(release),
      ),
    activeKeys: Effect.sync(() => core.activeKeys()),
  } satisfies KeyedLock<Key>;
});

export interface KeyedRunner<Key> {
  /** Forks `effect` to run once every effect passed earlier for `key` has finished. */
  readonly run: <R>(
    key: Key,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, R>;
}

/**
 * For a stream consumer whose handler waits on a per-key lock: a busy key delays only its own
 * later effects. The forked fiber starts immediately, so it queues on the key's FIFO lock
 * before `run` returns; that keeps each key's effects in `run` order.
 */
export const makeRunner = Effect.fn("KeyedLock.makeRunner")(function* <Key>(): Effect.fn.Return<
  KeyedRunner<Key>,
  never,
  Scope.Scope
> {
  const lock = yield* make<Key>();
  const fibers = yield* FiberSet.make<void, never>();
  return {
    run: (key, effect) =>
      FiberSet.run(fibers, lock.withLock(key, effect), { startImmediately: true }).pipe(
        Effect.asVoid,
      ),
  } satisfies KeyedRunner<Key>;
});
