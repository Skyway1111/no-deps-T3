import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";

import { createCoalescingQueue } from "./core/async.ts";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
}

/** One key at a time, FIFO across keys; updates to a queued or active key merge into its next run. */
export const makeKeyedCoalescingWorker = Effect.fn(
  "KeyedCoalescingWorker.makeKeyedCoalescingWorker",
)(function* <K, V, E, R>(options: {
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Effect.Effect<void, E, R>;
}): Effect.fn.Return<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> {
  // Closing the scope interrupts the active process; the queue then refuses new work.
  const runPromise = yield* FiberSet.makeRuntimePromise<R, void, never>();
  const queue = createCoalescingQueue<K, V>({
    merge: options.merge,
    process: (key, value) =>
      runPromise(Effect.ignoreCause(Effect.suspend(() => options.process(key, value)))),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => void queue.close()));

  return {
    enqueue: (key, value) => Effect.sync(() => queue.enqueue(key, value)),
    drainKey: (key) => Effect.promise(() => queue.drainKey(key)),
  } satisfies KeyedCoalescingWorker<K, V>;
});
