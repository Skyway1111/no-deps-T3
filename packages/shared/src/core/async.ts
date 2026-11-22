/**
 * Zero-dependency async concurrency primitives:
 * Result<T, E>, AbortScope, KeyedLock (O(1) FIFO), and CoalescingQueue.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function flatMapResult<T, U, E1, E2>(
  r: Result<T, E1>,
  fn: (value: T) => Result<U, E2>,
): Result<U, E1 | E2> {
  return r.ok ? fn(r.value) : r;
}

export function mapError<T, E1, E2>(r: Result<T, E1>, fn: (error: E1) => E2): Result<T, E2> {
  return r.ok ? r : err(fn(r.error));
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

export function trySync<T, E = unknown>(fn: () => T, onError?: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onError ? onError(cause) : (cause as E));
  }
}

export async function tryAsync<T, E = unknown>(
  fn: () => Promise<T>,
  onError?: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError ? onError(cause) : (cause as E));
  }
}

export class AbortScope {
  readonly controller: AbortController;
  private readonly finalizers: Array<() => void | Promise<void>> = [];
  private unlinkParent: (() => void) | null = null;
  private closing: Promise<void> | null = null;

  constructor(parent?: AbortSignal) {
    this.controller = new AbortController();
    if (parent) {
      if (parent.aborted) {
        this.controller.abort(parent.reason);
      } else {
        const onParentAbort = () => {
          void this.close(parent.reason);
        };
        parent.addEventListener("abort", onParentAbort, { once: true });
        this.unlinkParent = () => parent.removeEventListener("abort", onParentAbort);
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  addFinalizer(fn: () => void | Promise<void>): () => void {
    if (this.closing !== null) {
      void Promise.resolve().then(fn);
      return () => {};
    }
    this.finalizers.push(fn);
    return () => {
      const idx = this.finalizers.indexOf(fn);
      if (idx !== -1) this.finalizers.splice(idx, 1);
    };
  }

  fork(): AbortScope {
    const child = new AbortScope(this.signal);
    const remove = this.addFinalizer(() => child.close(this.signal.reason));
    child.addFinalizer(remove);
    return child;
  }

  race<T>(promise: Promise<T>): Promise<T> {
    if (this.aborted) {
      return Promise.reject(
        this.signal.reason instanceof Error
          ? this.signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(
          this.signal.reason instanceof Error
            ? this.signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          this.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  close(reason?: unknown): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.unlinkParent?.();
    this.unlinkParent = null;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
    const fns = this.finalizers.splice(0);
    this.closing = (async () => {
      let firstError: unknown = undefined;
      let hasError = false;
      for (let i = fns.length - 1; i >= 0; i--) {
        try {
          await fns[i]!();
        } catch (error) {
          if (!hasError) {
            firstError = error;
            hasError = true;
          }
        }
      }
      if (hasError) throw firstError;
    })();
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

interface WaiterNode {
  granted: boolean;
  cancelled: boolean;
  readonly grant: (release: () => void) => void;
  next: WaiterNode | null;
}

interface LockBucket {
  held: boolean;
  head: WaiterNode | null;
  tail: WaiterNode | null;
  pending: number;
}

export interface CoreKeyedLock<Key> {
  /**
   * Acquires the lock synchronously if free, or queues in FIFO order.
   * Returns an idempotent cancel function: if cancelled while queued, the waiter
   * is removed and never invoked; if already granted, the permit is released.
   */
  readonly acquireCallback: (key: Key, onGranted: (release: () => void) => void) => () => void;
  readonly acquire: (key: Key, signal?: AbortSignal) => Promise<() => void>;
  readonly withLock: <T>(
    key: Key,
    fn: () => Promise<T> | T,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<T>;
  readonly activeKeys: () => ReadonlyArray<Key>;
  readonly size: () => number;
}

/** O(1) FIFO per-key mutex. Not reentrant. Deletes key buckets once idle. */
export function createKeyedLock<Key>(): CoreKeyedLock<Key> {
  const buckets = new Map<Key, LockBucket>();

  const makeRelease = (key: Key, bucket: LockBucket): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (bucket.head !== null) {
        const next = bucket.head;
        bucket.head = next.next;
        if (bucket.head === null) bucket.tail = null;
        if (next.cancelled) continue;
        bucket.pending -= 1;
        next.granted = true;
        next.grant(makeRelease(key, bucket));
        return;
      }
      bucket.held = false;
      buckets.delete(key);
    };
  };

  const acquireCallback = (key: Key, onGranted: (release: () => void) => void): (() => void) => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { held: true, head: null, tail: null, pending: 0 };
      buckets.set(key, bucket);
      const release = makeRelease(key, bucket);
      onGranted(release);
      return release;
    }

    let grantedRelease: (() => void) | null = null;
    const node: WaiterNode = {
      granted: false,
      cancelled: false,
      grant: (release) => {
        grantedRelease = release;
        onGranted(release);
      },
      next: null,
    };
    if (bucket.tail === null) {
      bucket.head = node;
      bucket.tail = node;
    } else {
      bucket.tail.next = node;
      bucket.tail = node;
    }
    bucket.pending += 1;

    return () => {
      if (node.granted) {
        grantedRelease?.();
        return;
      }
      if (node.cancelled) return;
      node.cancelled = true;
      bucket.pending -= 1;
      if (!bucket.held && bucket.pending === 0) {
        buckets.delete(key);
      }
    };
  };

  const acquire = (key: Key, signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cancel();
        reject(
          signal!.reason instanceof Error
            ? signal!.reason
            : new DOMException("Aborted", "AbortError"),
        );
      };
      const cancel = acquireCallback(key, (release) => {
        if (settled) {
          release();
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      });
      if (!settled && signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };

  const withLock = async <T>(
    key: Key,
    fn: () => Promise<T> | T,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T> => {
    const release = await acquire(key, options?.signal);
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    acquireCallback,
    acquire,
    withLock,
    activeKeys: () => Array.from(buckets.keys()),
    size: () => buckets.size,
  };
}

export interface CoalescingQueueOptions<K, V> {
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Promise<void> | void;
  readonly concurrency?: number | undefined;
  readonly onError?: ((key: K, error: unknown) => void) | undefined;
}

export interface CoalescingQueue<K, V> {
  readonly enqueue: (key: K, value: V) => void;
  readonly drainKey: (key: K) => Promise<void>;
  readonly drainAll: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly pendingCount: () => number;
  readonly activeCount: () => number;
}

export function createCoalescingQueue<K, V>(
  options: CoalescingQueueOptions<K, V>,
): CoalescingQueue<K, V> {
  const maxConcurrency = Math.max(1, options.concurrency ?? 1);
  const latestByKey = new Map<K, V>();
  const queuedOrder: Array<K> = [];
  const queuedKeys = new Set<K>();
  const activeKeys = new Set<K>();
  const keyWaiters = new Map<K, Array<() => void>>();
  const allWaiters: Array<() => void> = [];
  let closed = false;

  const notifyKeyIfIdle = (key: K): void => {
    if (latestByKey.has(key) || queuedKeys.has(key) || activeKeys.has(key)) return;
    const waiters = keyWaiters.get(key);
    if (waiters) {
      keyWaiters.delete(key);
      for (const resolve of waiters) resolve();
    }
    if (latestByKey.size === 0 && queuedKeys.size === 0 && activeKeys.size === 0) {
      const drained = allWaiters.splice(0);
      for (const resolve of drained) resolve();
    }
  };

  const pump = (): void => {
    while (activeKeys.size < maxConcurrency && queuedOrder.length > 0) {
      const key = queuedOrder.shift()!;
      queuedKeys.delete(key);
      if (!latestByKey.has(key)) {
        notifyKeyIfIdle(key);
        continue;
      }
      const value = latestByKey.get(key)!;
      latestByKey.delete(key);
      activeKeys.add(key);

      Promise.resolve()
        .then(() => options.process(key, value))
        .catch((error) => {
          options.onError?.(key, error);
        })
        .finally(() => {
          activeKeys.delete(key);
          if (latestByKey.has(key) && !queuedKeys.has(key)) {
            queuedKeys.add(key);
            queuedOrder.push(key);
          } else {
            notifyKeyIfIdle(key);
          }
          pump();
        });
    }
  };

  const enqueue = (key: K, value: V): void => {
    if (closed) return;
    const existing = latestByKey.get(key);
    latestByKey.set(key, existing === undefined ? value : options.merge(existing, value));
    if (!queuedKeys.has(key) && !activeKeys.has(key)) {
      queuedKeys.add(key);
      queuedOrder.push(key);
      pump();
    }
  };

  const drainKey = (key: K): Promise<void> => {
    if (!latestByKey.has(key) && !queuedKeys.has(key) && !activeKeys.has(key)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let list = keyWaiters.get(key);
      if (list === undefined) {
        list = [];
        keyWaiters.set(key, list);
      }
      list.push(resolve);
    });
  };

  const drainAll = (): Promise<void> => {
    if (latestByKey.size === 0 && queuedKeys.size === 0 && activeKeys.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      allWaiters.push(resolve);
    });
  };

  const close = (): Promise<void> => {
    closed = true;
    return drainAll();
  };

  return {
    enqueue,
    drainKey,
    drainAll,
    close,
    pendingCount: () => latestByKey.size,
    activeCount: () => activeKeys.size,
  };
}
