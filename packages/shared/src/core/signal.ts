/**
 * Zero-dependency fine-grained reactivity (Signal / Computed / Effect / batch)
 * plus a minimal Store, shallow equality, and persistence helper.
 */

type EqualityFn<T> = (a: T, b: T) => boolean;

interface DependencyNode {
  readonly subs: Set<SubscriberNode>;
}

interface SubscriberNode {
  readonly deps: Set<DependencyNode>;
  markDirty(): void;
  notify(): void;
}

let activeSubscriber: SubscriberNode | null = null;
let batchDepth = 0;
const pendingSubscribers = new Set<SubscriberNode>();
const pendingListeners = new Set<() => void>();

function markDownstreamDirty(subs: Set<SubscriberNode>): void {
  for (const sub of subs) {
    sub.markDirty();
    pendingSubscribers.add(sub);
  }
}

function flushNotifications(): void {
  if (batchDepth > 0) return;
  while (pendingSubscribers.size > 0 || pendingListeners.size > 0) {
    if (pendingSubscribers.size > 0) {
      const subs = Array.from(pendingSubscribers);
      pendingSubscribers.clear();
      for (const sub of subs) sub.notify();
    }
    if (pendingListeners.size > 0) {
      const listeners = Array.from(pendingListeners);
      pendingListeners.clear();
      for (const listener of listeners) listener();
    }
  }
}

function trackDependency(node: DependencyNode): void {
  if (activeSubscriber === null) return;
  node.subs.add(activeSubscriber);
  activeSubscriber.deps.add(node);
}

function unlinkSubscriber(sub: SubscriberNode): void {
  for (const dep of sub.deps) dep.subs.delete(sub);
  sub.deps.clear();
}

export interface ReadonlySignal<T> {
  get(): T;
  peek(): T;
  subscribe(listener: () => void): () => void;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(next: T | ((prev: T) => T)): void;
}

export interface Computed<T> extends ReadonlySignal<T> {
  dispose(): void;
}

export function batch<T>(fn: () => T): T {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) flushNotifications();
  }
}

export function untracked<T>(fn: () => T): T {
  const prev = activeSubscriber;
  activeSubscriber = null;
  try {
    return fn();
  } finally {
    activeSubscriber = prev;
  }
}

export function signal<T>(initial: T, equals: EqualityFn<T> = Object.is): Signal<T> {
  let value = initial;
  const subs = new Set<SubscriberNode>();
  const listeners = new Set<() => void>();
  const node: DependencyNode = { subs };

  return {
    get(): T {
      trackDependency(node);
      return value;
    },
    peek(): T {
      return value;
    },
    set(next: T | ((prev: T) => T)): void {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (equals(value, resolved)) return;
      value = resolved;
      markDownstreamDirty(subs);
      for (const listener of listeners) pendingListeners.add(listener);
      flushNotifications();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function computed<T>(fn: () => T, equals: EqualityFn<T> = Object.is): Computed<T> {
  let value!: T;
  let initialized = false;
  let dirty = true;
  let computing = false;
  const subs = new Set<SubscriberNode>();
  const listeners = new Set<() => void>();
  const depNode: DependencyNode = { subs };

  const recompute = (): T => {
    if (computing) throw new Error("Cycle detected in computed signal");
    computing = true;
    unlinkSubscriber(subNode);
    const prev = activeSubscriber;
    activeSubscriber = subNode;
    try {
      const next = fn();
      const changed = !initialized || !equals(value, next);
      value = next;
      initialized = true;
      dirty = false;
      if (changed) {
        markDownstreamDirty(subs);
        for (const listener of listeners) pendingListeners.add(listener);
      }
      return value;
    } finally {
      activeSubscriber = prev;
      computing = false;
    }
  };

  const subNode: SubscriberNode = {
    deps: new Set(),
    markDirty(): void {
      if (dirty) return;
      dirty = true;
      markDownstreamDirty(subs);
    },
    notify(): void {
      if (!dirty) return;
      if (subs.size > 0 || listeners.size > 0) {
        recompute();
      }
    },
  };

  return {
    get(): T {
      if (dirty) recompute();
      trackDependency(depNode);
      return value;
    },
    peek(): T {
      if (dirty) recompute();
      return value;
    },
    subscribe(listener: () => void): () => void {
      if (dirty) recompute();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      unlinkSubscriber(subNode);
      subs.clear();
      listeners.clear();
      dirty = true;
    },
  };
}

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: (() => void) | void;
  let disposed = false;

  const run = (): void => {
    if (disposed) return;
    if (typeof cleanup === "function") {
      cleanup();
      cleanup = undefined;
    }
    unlinkSubscriber(subNode);
    const prev = activeSubscriber;
    activeSubscriber = subNode;
    try {
      cleanup = fn();
    } finally {
      activeSubscriber = prev;
    }
  };

  const subNode: SubscriberNode = {
    deps: new Set(),
    markDirty(): void {},
    notify: run,
  };

  run();

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof cleanup === "function") {
      cleanup();
      cleanup = undefined;
    }
    unlinkSubscriber(subNode);
    pendingSubscribers.delete(subNode);
  };
}

export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (a instanceof Date && b instanceof Date) {
    return Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !Object.is(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  if (keysA.length !== Object.keys(objB).length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]!;
    if (!Object.hasOwn(objB, key) || !Object.is(objA[key], objB[key])) return false;
  }
  return true;
}

export type SetStateInternal<T> = {
  (partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: false): void;
  (state: T | ((state: T) => T), replace: true): void;
};

export interface StoreApi<T> {
  readonly setState: SetStateInternal<T>;
  readonly getState: () => T;
  readonly getInitialState: () => T;
  readonly subscribe: (listener: (state: T, prevState: T) => void) => () => void;
}

export type StateCreator<T> = (
  set: SetStateInternal<T>,
  get: () => T,
  api: StoreApi<T>,
) => T;

export interface StateStorage {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => unknown;
  removeItem: (name: string) => unknown;
}

export interface StorageValue<S> {
  state: S;
  version?: number;
}

export interface PersistStorage<S> {
  getItem: (name: string) => StorageValue<S> | null | Promise<StorageValue<S> | null>;
  setItem: (name: string, value: StorageValue<S>) => unknown;
  removeItem: (name: string) => unknown;
}

export interface PersistOptions<S, PersistedState = S> {
  name: string;
  storage?: PersistStorage<PersistedState> | undefined;
  partialize?: ((state: S) => PersistedState) | undefined;
  version?: number | undefined;
  migrate?: ((persistedState: unknown, version: number) => PersistedState | Promise<PersistedState>) | undefined;
  merge?: ((persistedState: unknown, currentState: S) => S) | undefined;
  onRehydrateStorage?: ((state: S) => ((state?: S, error?: unknown) => void) | void) | undefined;
  skipHydration?: boolean | undefined;
}

export interface PersistApi<S, PersistedState = S> {
  setOptions: (options: Partial<PersistOptions<S, PersistedState>>) => void;
  clearStorage: () => void | Promise<void>;
  rehydrate: () => Promise<void> | void;
  hasHydrated: () => boolean;
  onHydrate: (fn: (state: S) => void) => () => void;
  onFinishHydration: (fn: (state: S) => void) => () => void;
  getOptions: () => Partial<PersistOptions<S, PersistedState>>;
}

export type PersistedStoreApi<S, PersistedState = S> = StoreApi<S> & {
  readonly persist: PersistApi<S, PersistedState>;
};

export interface PersistedStateCreator<S, PersistedState = S> extends StateCreator<S> {
  readonly __persisted?: PersistedState;
}

// biome-ignore lint/suspicious/noExplicitAny: matches JSON storage's untyped deserialization boundary
export function createJSONStorage<S = any>(
  getStorage: () => StateStorage,
  options?: {
    reviver?: (key: string, value: unknown) => unknown;
    replacer?: (key: string, value: unknown) => unknown;
  },
): PersistStorage<S> | undefined {
  let storage: StateStorage | undefined;
  try {
    storage = getStorage();
  } catch {
    return undefined;
  }
  const parse = (raw: string | null): StorageValue<S> | null => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw, options?.reviver) as StorageValue<S>;
    } catch {
      return null;
    }
  };
  return {
    getItem(name) {
      const value = storage.getItem(name);
      return value instanceof Promise ? value.then(parse) : parse(value);
    },
    setItem(name, value) {
      return storage.setItem(name, JSON.stringify(value, options?.replacer));
    },
    removeItem(name) {
      return storage.removeItem(name);
    },
  };
}

function defaultStorage<S>(): PersistStorage<S> | undefined {
  return createJSONStorage<S>(() => {
    if (typeof localStorage === "undefined") {
      throw new Error("localStorage is unavailable");
    }
    return localStorage;
  });
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function persist<S, PersistedState = S>(
  initializer: StateCreator<S>,
  baseOptions: PersistOptions<S, PersistedState>,
): PersistedStateCreator<S, PersistedState> {
  return (set, get, api) => {
    let options: PersistOptions<S, PersistedState> = {
      storage: defaultStorage<PersistedState>(),
      partialize: (state: S) => state as unknown as PersistedState,
      version: 0,
      merge: (persistedState: unknown, currentState: S) => ({
        ...currentState,
        ...(persistedState as object),
      }),
      ...baseOptions,
    };

    let hydrated = false;
    const hydrateListeners = new Set<(state: S) => void>();
    const finishHydrationListeners = new Set<(state: S) => void>();

    const persistState = (): void => {
      const storage = options.storage;
      if (!storage) return;
      const state = options.partialize ? options.partialize(get()) : (get() as unknown as PersistedState);
      void storage.setItem(options.name, {
        state,
        ...(options.version !== undefined ? { version: options.version } : {}),
      });
    };

    const persistedSet: SetStateInternal<S> = ((partial: unknown, replace?: boolean) => {
      (set as (p: unknown, r?: boolean) => void)(partial, replace);
      persistState();
    }) as SetStateInternal<S>;

    const baseSetState = api.setState;
    Object.defineProperty(api, "setState", {
      value: ((partial: unknown, replace?: boolean) => {
        (baseSetState as (p: unknown, r?: boolean) => void)(partial, replace);
        persistState();
      }) as SetStateInternal<S>,
      configurable: true,
      writable: true,
    });

    const rehydrate = (): Promise<void> | void => {
      const storage = options.storage;
      if (!storage) return;
      hydrated = false;
      const current = get();
      for (const listener of hydrateListeners) listener(current);
      const postRehydrate = options.onRehydrateStorage?.(current) ?? undefined;

      const finish = (state?: S, error?: unknown): void => {
        hydrated = true;
        postRehydrate?.(state, error);
        const latest = get();
        for (const listener of finishHydrationListeners) listener(latest);
      };

      const applyStored = (
        stored: StorageValue<PersistedState> | null,
      ): Promise<void> | void => {
        if (!stored) {
          finish(get());
          return;
        }
        const targetVersion = options.version ?? 0;
        const storedVersion = stored.version ?? 0;
        const applyMigrated = (migrated: unknown, writeBack: boolean): void => {
          const merged = options.merge
            ? options.merge(migrated, get())
            : ({ ...get(), ...(migrated as object) } as S);
          (baseSetState as (p: unknown, r?: boolean) => void)(merged, true);
          if (writeBack) persistState();
          finish(get());
        };

        if (storedVersion !== targetVersion) {
          if (!options.migrate) {
            finish(get());
            return;
          }
          const migrated = options.migrate(stored.state, storedVersion);
          if (isThenable<PersistedState>(migrated)) {
            return Promise.resolve(migrated).then(
              (resolved) => applyMigrated(resolved, true),
              (error) => finish(undefined, error),
            );
          }
          applyMigrated(migrated, true);
          return;
        }
        applyMigrated(stored.state, false);
      };

      try {
        const stored = storage.getItem(options.name);
        if (isThenable<StorageValue<PersistedState> | null>(stored)) {
          return Promise.resolve(stored).then(
            (resolved) => applyStored(resolved),
            (error) => finish(undefined, error),
          );
        }
        return applyStored(stored);
      } catch (error) {
        finish(undefined, error);
      }
    };

    const persistApi: PersistApi<S, PersistedState> = {
      setOptions(next) {
        options = { ...options, ...next };
      },
      clearStorage() {
        return options.storage?.removeItem(options.name) as void | Promise<void>;
      },
      rehydrate,
      hasHydrated: () => hydrated,
      onHydrate(fn) {
        hydrateListeners.add(fn);
        return () => {
          hydrateListeners.delete(fn);
        };
      },
      onFinishHydration(fn) {
        finishHydrationListeners.add(fn);
        return () => {
          finishHydrationListeners.delete(fn);
        };
      },
      getOptions: () => options,
    };

    (api as { persist?: PersistApi<S, PersistedState> }).persist = persistApi;

    const initialState = initializer(persistedSet, get, api);
    // Store initial state before hydration so getInitialState() reflects pre-hydration defaults.
    (baseSetState as (p: unknown, r?: boolean) => void)(initialState, true);
    if (!options.skipHydration) {
      void rehydrate();
    }
    return get();
  };
}

function createStoreImpl<T>(creator: StateCreator<T>): StoreApi<T> {
  let state!: T;
  let initialState!: T;
  let initialized = false;
  const listeners = new Set<(state: T, prevState: T) => void>();

  const setState: SetStateInternal<T> = ((
    partial: T | Partial<T> | ((s: T) => T | Partial<T>),
    replace?: boolean,
  ) => {
    const nextPartial = typeof partial === "function"
      ? (partial as (s: T) => T | Partial<T>)(state)
      : partial;
    if (initialized && Object.is(nextPartial, state)) return;
    const prevState = state;
    state =
      replace || nextPartial === null || typeof nextPartial !== "object"
        ? (nextPartial as T)
        : Object.assign({}, state, nextPartial);
    if (!initialized) {
      initialState = state;
      initialized = true;
      return;
    }
    for (const listener of listeners) listener(state, prevState);
  }) as SetStateInternal<T>;

  const getState = (): T => state;
  const getInitialState = (): T => initialState;
  const subscribe = (listener: (s: T, prev: T) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const api: StoreApi<T> = { setState, getState, getInitialState, subscribe };
  const created = creator(setState, getState, api);
  if (!initialized) {
    state = created;
    initialState = created;
    initialized = true;
  } else {
    state = created;
  }
  return api;
}

export interface CreateStoreFn {
  <T, P>(initializer: PersistedStateCreator<T, P>): PersistedStoreApi<T, P>;
  <T>(initializer: StateCreator<T>): StoreApi<T>;
  <T>(): {
    <P>(initializer: PersistedStateCreator<T, P>): PersistedStoreApi<T, P>;
    (initializer: StateCreator<T>): StoreApi<T>;
  };
}

export const createStore: CreateStoreFn = ((initializer?: StateCreator<unknown>) =>
  initializer ? createStoreImpl(initializer) : createStoreImpl) as CreateStoreFn;

// biome-ignore lint/suspicious/noExplicitAny: StoreApi<T> is invariant in T via setState
export type UseBoundStore<S extends StoreApi<any>> = {
  (): S extends StoreApi<infer T> ? T : never;
  <U>(selector: (state: S extends StoreApi<infer T> ? T : never) => U): U;
} & S;

export interface ReactHooksBinding {
  readonly useSyncExternalStore: <Snapshot>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot?: () => Snapshot,
  ) => Snapshot;
  readonly useRef: <T>(initialValue: T) => { current: T };
}

export interface CreateHookFn {
  <T, P>(initializer: PersistedStateCreator<T, P>): UseBoundStore<PersistedStoreApi<T, P>>;
  <T>(initializer: StateCreator<T>): UseBoundStore<StoreApi<T>>;
  <T>(): {
    <P>(initializer: PersistedStateCreator<T, P>): UseBoundStore<PersistedStoreApi<T, P>>;
    (initializer: StateCreator<T>): UseBoundStore<StoreApi<T>>;
  };
}

export interface BoundReactStoreHooks {
  readonly useStore: {
    <T>(api: StoreApi<T>): T;
    <T, U>(api: StoreApi<T>, selector: (state: T) => U): U;
  };
  readonly create: CreateHookFn;
  readonly useShallow: <S, U>(selector: (state: S) => U) => (state: S) => U;
  readonly useSignal: <T>(sig: ReadonlySignal<T>) => T;
}

const identity = <T>(x: T): T => x;

export function bindReactStoreHooks(react: ReactHooksBinding): BoundReactStoreHooks {
  function useStore<T, U = T>(
    api: StoreApi<T>,
    selector: (state: T) => U = identity as unknown as (state: T) => U,
  ): U {
    return react.useSyncExternalStore(
      api.subscribe,
      () => selector(api.getState()),
      () => selector(api.getInitialState()),
    );
  }

  function createBound<T>(initializer: StateCreator<T>): UseBoundStore<StoreApi<T>> {
    const api = createStoreImpl(initializer);
    const useBound = <U = T>(selector?: (state: T) => U) =>
      useStore(api, (selector ?? identity) as (state: T) => U);
    return Object.assign(useBound, api) as UseBoundStore<StoreApi<T>>;
  }

  const create: CreateHookFn = ((initializer?: StateCreator<unknown>) =>
    initializer ? createBound(initializer) : createBound) as CreateHookFn;

  function useShallow<S, U>(selector: (state: S) => U): (state: S) => U {
    const prev = react.useRef<U | undefined>(undefined);
    return (state: S): U => {
      const next = selector(state);
      if (prev.current !== undefined && shallow(prev.current, next)) {
        return prev.current;
      }
      prev.current = next;
      return next;
    };
  }

  function useSignal<T>(sig: ReadonlySignal<T>): T {
    return react.useSyncExternalStore(
      (onChange) => sig.subscribe(onChange),
      () => sig.peek(),
      () => sig.peek(),
    );
  }

  return { useStore, create, useShallow, useSignal };
}
