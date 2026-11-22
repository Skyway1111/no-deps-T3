/**
 * Zero-dependency async concurrency primitives:
 * KeyedLock (O(1) FIFO) and CoalescingQueue.
 */

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
