import { CONSUMER, CONTEXT, createElement, FORWARD_REF, MEMO } from "./jsx-runtime.ts";
import { current, depsChanged, enqueue, hook, inTransition, isServer, Phase, queueEffect, readContext, startTransition, transitionFlush } from "./reconciler.ts";

export { startTransition };
type Deps = readonly unknown[] | undefined;
type Thenable<T> = PromiseLike<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T; reason?: unknown };

export function useReducer<S, A>(reducer: (s: S, a: A) => S, initialArg: any, init?: (arg: any) => S): [S, (a: A) => void] {
  const h = hook();
  const f = current!;
  if (!h.dispatch) {
    h.base = h.state = init ? init(initialArg) : initialArg;
    h.queue = [];
    h.dispatch = (action: A) => {
      const t = inTransition();
      if (h.basic && !t && !h.queue.length && typeof action !== "function" && Object.is(action, h.state)) return;
      h.queue.push({ action, t });
      enqueue(f, t);
    };
  }
  if (h.queue.length) {
    // Urgent renders skip transition updates but keep them queued, replaying everything from `base` later.
    let state = h.base;
    let skipped = false;
    for (const u of h.queue) if (!u.t || transitionFlush) state = reducer(state, u.action);
    else skipped = true;
    h.state = state;
    if (skipped) enqueue(f, true);
    else (h.base = state), (h.queue.length = 0);
  }
  return [h.state, h.dispatch];
}

const basicReducer = (s: any, a: any) => (typeof a === "function" ? a(s) : a);

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
  const r = useReducer(basicReducer, initial, typeof initial === "function" ? (initial as () => S) : undefined);
  current!.hooks![current!.hi - 1]!.basic = true;
  return r;
}

export const useEffect = (cb: () => unknown, deps?: Deps) => queueEffect(hook(), Phase.Passive, cb, deps);
export const useLayoutEffect = (cb: () => unknown, deps?: Deps) => queueEffect(hook(), Phase.Layout, cb, deps);
export const useInsertionEffect = (cb: () => unknown, deps?: Deps) => queueEffect(hook(), Phase.Insertion, cb, deps);

export function useMemo<T>(fn: () => T, deps: Deps): T {
  const h = hook();
  if (!("value" in h) || depsChanged(h.deps, deps)) (h.value = fn()), (h.deps = deps);
  return h.value;
}

export const useCallback = <T>(fn: T, deps: Deps): T => useMemo(() => fn, deps);

export function useRef<T>(initial?: T): { current: T } {
  const h = hook();
  return (h.ref ??= { current: initial });
}

export const useContext = <T>(ctx: Context<T>): T => readContext(ctx);

export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T {
  const value = (isServer && getServerSnapshot ? getServerSnapshot : getSnapshot)();
  const h = hook();
  h.value = value;
  h.get = getSnapshot;
  const f = current!;
  useLayoutEffect(() => {
    const check = () => !Object.is(h.value, h.get()) && enqueue(f);
    check();
    return subscribe(check);
  }, [subscribe]);
  return value;
}

export function useTransition(): [boolean, (fn: () => unknown) => void] {
  const [pending, setPending] = useState(false);
  const h = hook();
  h.start ??= (fn: () => unknown) => {
    setPending(true);
    startTransition(() => {
      const r: any = fn();
      if (r && typeof r.then === "function") {
        const done = () => startTransition(() => setPending(false));
        r.then(done, done);
      } else setPending(false);
    });
  };
  return [pending, h.start];
}

export function useDeferredValue<T>(value: T, initialValue?: T): T {
  const [deferred, setDeferred] = useState(initialValue === undefined ? value : initialValue);
  useEffect(() => {
    if (!Object.is(deferred, value)) startTransition(() => setDeferred(value));
  }, [value, deferred]);
  return deferred;
}

let ids = 0;
export function useId(): string {
  const h = hook();
  return (h.id ??= `_r_${(ids++).toString(32)}_`);
}

export function useEffectEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const h = hook();
  h.fn = fn;
  return (h.call ??= (...args: A) => h.fn(...args));
}

export function useImperativeHandle<T>(ref: any, create: () => T, deps?: Deps): void {
  useLayoutEffect(
    () => {
      if (!ref) return;
      const value = create();
      if (typeof ref !== "function") {
        ref.current = value;
        return () => void (ref.current = null);
      }
      const cleanup = ref(value);
      return () => (typeof cleanup === "function" ? cleanup() : ref(null));
    },
    deps && [...deps, ref],
  );
}

export const useDebugValue = (_value: unknown, _format?: (v: any) => any): void => {};

export function use<T>(usable: Thenable<T> | Context<T>): T {
  if ((usable as Context<T>).$$typeof === CONTEXT) return readContext(usable);
  const t = usable as Thenable<T>;
  if (t.status === "fulfilled") return t.value as T;
  if (t.status === "rejected") throw t.reason;
  if (!t.status) {
    t.status = "pending";
    t.then(
      (v) => ((t.status = "fulfilled"), (t.value = v)),
      (e) => ((t.status = "rejected"), (t.reason = e)),
    );
  }
  throw t;
}

// ---------------------------------------------------------------- component helpers

export interface Context<T> {
  $$typeof: symbol;
  _id: symbol;
  _currentValue: T;
  Provider: Context<T>;
  Consumer: { $$typeof: symbol; _context: Context<T> };
  displayName?: string;
}

export function createContext<T>(defaultValue: T): Context<T> {
  const ctx = { $$typeof: CONTEXT, _id: Symbol(), _currentValue: defaultValue } as Context<T>;
  ctx.Provider = ctx;
  ctx.Consumer = { $$typeof: CONSUMER, _context: ctx };
  return ctx;
}

export const memo = <P>(type: (p: P) => any, compare?: (a: P, b: P) => boolean) => ({ $$typeof: MEMO, type, compare: compare ?? null }) as any;

export const forwardRef = <T, P>(render: (props: P, ref: T) => any) => ({ $$typeof: FORWARD_REF, render }) as any;

export function lazy<P>(load: () => Promise<{ default: (p: P) => any } | ((p: P) => any)>): (p: P) => any {
  let promise: Thenable<any> | undefined;
  return function Lazy(props: P) {
    const mod = use((promise ??= load()));
    return createElement(mod.default ?? mod, props);
  };
}

export const createRef = <T>(): { current: T | null } => ({ current: null });

export class Component<P = any, S = any> {
  declare props: P;
  declare state: S;
  declare context: unknown;
  declare _f: any;
  declare _q: unknown[] | undefined;
  declare _cb: Array<() => void> | undefined;
  declare _force: boolean;
  constructor(props: P, context?: unknown) {
    this.props = props;
    this.context = context;
  }
  setState(partial: Partial<S> | ((s: S, p: P) => Partial<S> | null) | null, callback?: () => void): void {
    (this._q ??= []).push(partial);
    if (callback) (this._cb ??= []).push(callback);
    if (this._f) enqueue(this._f);
  }
  forceUpdate(callback?: () => void): void {
    this._force = true;
    if (callback) (this._cb ??= []).push(callback);
    if (this._f) enqueue(this._f);
  }
}
(Component.prototype as any).isReactComponent = {};

export class PureComponent<P = any, S = any> extends Component<P, S> {}
(PureComponent.prototype as any).isPureReactComponent = true;
