import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as D from "../Duration.ts";
import * as C from "../Cause.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as ScopeM from "../Scope.ts";
import * as SubRef from "../SubscriptionRef.ts";
import * as AR from "./AsyncResult.ts";
import * as registryModule from "./AtomRegistry.ts";
import { AtomRegistry, type Registry, type Node } from "./AtomRegistry.ts";
import type * as Reactivity from "./Reactivity.ts";

export const TypeId: unique symbol = Symbol.for("effect/reactivity/Atom") as never;
export const WritableTypeId: unique symbol = Symbol.for("effect/reactivity/Atom/Writable") as never;
export const SerializableTypeId: unique symbol = Symbol.for("effect/reactivity/Atom/Serializable") as never;
export type AtomRegistryT = import("./AtomRegistry.ts").AtomRegistry;

export interface Atom<A> extends I.Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly keepAlive: boolean;
  readonly lazy: boolean;
  readonly read: (get: AtomContext) => A;
  equals(value: A, next: A): boolean;
  readonly refresh?: (f: <B>(atom: Atom<B>) => void) => void;
  readonly label?: readonly [name: string, stack: string];
  readonly idleTTL?: number;
  readonly initialValueTarget?: Atom<A>;
  /** `read` never lets its context escape, so the registry reuses one context across runs. */
  readonly privateContext?: boolean;
}
export interface Writable<R, W = R> extends Atom<R> {
  readonly [WritableTypeId]: typeof WritableTypeId;
  readonly write: (ctx: WriteContext<R>, value: W) => void;
}
export type Type<T> = T extends Atom<infer A> ? A : never;
export type WriteType<T> = T extends Writable<any, infer W> ? W : never;
export type Success<T> = Type<T> extends AR.AsyncResult<infer A, any> ? A : never;
export type Failure<T> = Type<T> extends AR.AsyncResult<any, infer E> ? E : never;
export declare namespace Atom {
  type Type<T> = import("./Atom.ts").Type<T>;
}
export interface AtomContext {
  <A>(atom: Atom<A>): A;
  get<A>(this: AtomContext, atom: Atom<A>): A;
  result<A, E>(this: AtomContext, atom: Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean }): I.Effect<A, E>;
  resultOnce<A, E>(this: AtomContext, atom: Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean }): I.Effect<A, E>;
  once<A>(this: AtomContext, atom: Atom<A>): A;
  addFinalizer(this: AtomContext, f: () => void): void;
  mount<A>(this: AtomContext, atom: Atom<A>): void;
  refresh<A>(this: AtomContext, atom: Atom<A>): void;
  refreshSelf(this: AtomContext): void;
  self<A>(this: AtomContext): O.Option<A>;
  setSelf<A>(this: AtomContext, a: A): void;
  set<R, W>(this: AtomContext, atom: Writable<R, W>, value: W): void;
  setResult<A, E, W>(this: AtomContext, atom: Writable<AR.AsyncResult<A, E>, W>, value: W): I.Effect<A, E>;
  some<A>(this: AtomContext, atom: Atom<O.Option<A>>): I.Effect<A>;
  someOnce<A>(this: AtomContext, atom: Atom<O.Option<A>>): I.Effect<A>;
  stream<A>(this: AtomContext, atom: Atom<A>, options?: { readonly withoutInitialValue?: boolean; readonly bufferSize?: number }): Stream.Stream<A>;
  streamResult<A, E>(this: AtomContext, atom: Atom<AR.AsyncResult<A, E>>, options?: { readonly withoutInitialValue?: boolean; readonly bufferSize?: number }): Stream.Stream<A, E>;
  subscribe<A>(this: AtomContext, atom: Atom<A>, f: (_: A) => void, options?: { readonly immediate?: boolean }): void;
  readonly registry: AtomRegistryT;
}
export type Context = AtomContext;
export type FnContext = AtomContext;
export interface WriteContext<A> {
  get<T>(this: WriteContext<A>, atom: Atom<T>): T;
  refreshSelf(this: WriteContext<A>): void;
  setSelf(this: WriteContext<A>, a: A): void;
  set<R, W>(this: WriteContext<A>, atom: Writable<R, W>, value: W): void;
}

const proto = {
  [TypeId]: TypeId,
  ...I.PipeProto,
  equals(a: unknown, b: unknown) {
    return I.equals(a, b);
  },
  toString(this: Atom<unknown>) {
    return this.label ? `Atom(${this.label[0]})` : "Atom";
  },
};
const writableProto = { ...proto, [WritableTypeId]: WritableTypeId };
export const readable = <A>(read: (get: AtomContext) => A, refresh?: (f: <B>(atom: Atom<B>) => void) => void): Atom<A> =>
  Object.assign(Object.create(proto), { keepAlive: false, lazy: true, read, refresh });
export const writable = <R, W>(read: (get: AtomContext) => R, write: (ctx: WriteContext<R>, value: W) => void, refresh?: (f: <B>(atom: Atom<B>) => void) => void): Writable<R, W> =>
  Object.assign(Object.create(writableProto), { keepAlive: false, lazy: true, read, write, refresh });
export const isAtom = (u: unknown): u is Atom<unknown> => typeof u === "object" && u !== null && TypeId in u;
export const isWritable = <R, W>(atom: Atom<R>): atom is Writable<R, W> => WritableTypeId in atom;
const modify = <A extends Atom<any>>(self: A, patch: object): A => Object.assign(Object.create(Object.getPrototypeOf(self)), self, patch);

// ---------- effect-backed atoms ----------
/** Run `eff` for the node's lifetime; sync results return immediately. */
function runEffect<A, E>(get: AtomContext, eff: I.Effect<A, E, any>, options: { readonly initialValue?: A; readonly uninterruptible?: boolean } | undefined, ctx?: I.Context<any>): AR.AsyncResult<A, E> {
  const scope = new ScopeM.ScopeImpl();
  const base = ctx ?? I.emptyContext;
  const context = I.contextAdd(I.contextAdd(base, AtomRegistry.key, get.registry), ScopeM.Scope.key, scope);
  const fiber = I.runFiber(eff, context, undefined, { uninterruptible: options?.uninterruptible });
  get.addFinalizer(() => {
    fiber.interruptAsFork(undefined);
    I.runFiber(I.make((f) => scope.closeStep(I.exitVoid, f)), I.emptyContext);
  });
  if (fiber.exit) return AR.fromExit(fiber.exit);
  const prev = get.self<AR.AsyncResult<A, E>>();
  fiber.addObserver((exit) => {
    if (exit._tag === "Failure" && C.hasInterruptsOnly(exit.cause)) return;
    get.setSelf(AR.fromExitWithPrevious(exit, prev));
  });
  return prev._tag === "Some" ? AR.waiting(prev.value) : options?.initialValue !== undefined ? AR.success(options.initialValue, { waiting: true }) : AR.initial(true);
}
/** Consume `stream`, publishing each element as a waiting Success until it ends. */
function runStream<A, E>(get: AtomContext, stream: Stream.Stream<A, E, any>, options: { readonly initialValue?: A } | undefined, ctx?: I.Context<any>): AR.AsyncResult<A, E | C.NoSuchElementError> {
  let last: { v: A } | undefined;
  let syncPhase = true;
  let syncValue: AR.AsyncResult<A, E | C.NoSuchElementError> | undefined;
  const publish = (r: AR.AsyncResult<A, E | C.NoSuchElementError>) => (syncPhase ? (syncValue = r) : get.setSelf(r));
  const eff = I.make<void, E>((f) =>
    I.exec(Stream.runForEachArray(stream, (chunk) => I.make(() => {
      last = { v: chunk[chunk.length - 1]! };
      publish(AR.success(last.v, { waiting: true }));
    })), f));
  const scope = new ScopeM.ScopeImpl();
  const context = I.contextAdd(I.contextAdd(ctx ?? I.emptyContext, AtomRegistry.key, get.registry), ScopeM.Scope.key, scope);
  const fiber = I.runFiber(eff, context);
  const finish = (exit: I.Exit<void, E>) => {
    if (exit._tag === "Failure") {
      if (C.hasInterruptsOnly(exit.cause)) return;
      publish(AR.failure(exit.cause, { previousSuccess: last ? O.some(AR.success(last.v)) : O.none() }));
    } else publish(last ? AR.success(last.v) : AR.fail(new C.NoSuchElementError()));
  };
  get.addFinalizer(() => {
    fiber.interruptAsFork(undefined);
    I.runFiber(I.make((f) => scope.closeStep(I.exitVoid, f)), I.emptyContext);
  });
  if (fiber.exit) finish(fiber.exit);
  else fiber.addObserver(finish);
  syncPhase = false;
  if (syncValue) return syncValue;
  const prev = get.self<AR.AsyncResult<A, E>>();
  return prev._tag === "Some" ? AR.waiting(prev.value) : options?.initialValue !== undefined ? AR.success(options.initialValue, { waiting: true }) : AR.initial(true);
}
const resolveCreate = (get: AtomContext, x: unknown, options: any, ctx?: I.Context<any>): any => {
  const v = typeof x === "function" && !isAtom(x) && !I.isEffect(x) ? x(get) : x;
  if (Stream.isStream(v)) return runStream(get, v, options, ctx);
  if (I.isEffect(v)) return runEffect(get, v, options, ctx);
  return v;
};
export const make: {
  <A, E>(create: (get: AtomContext) => I.Effect<A, E, ScopeM.Scope | AtomRegistryT>, options?: { readonly initialValue?: A; readonly uninterruptible?: boolean }): Atom<AR.AsyncResult<A, E>>;
  <A, E>(effect: I.Effect<A, E, ScopeM.Scope | AtomRegistryT>, options?: { readonly initialValue?: A; readonly uninterruptible?: boolean }): Atom<AR.AsyncResult<A, E>>;
  <A, E>(create: (get: AtomContext) => Stream.Stream<A, E, AtomRegistryT>, options?: { readonly initialValue?: A }): Atom<AR.AsyncResult<A, E | C.NoSuchElementError>>;
  <A, E>(stream: Stream.Stream<A, E, AtomRegistryT>, options?: { readonly initialValue?: A }): Atom<AR.AsyncResult<A, E | C.NoSuchElementError>>;
  <A>(create: (get: AtomContext) => A): Atom<A>;
  <A>(initialValue: A): Writable<A>;
} = (x: unknown, options?: unknown): any => {
  if (typeof x === "function" && !I.isEffect(x)) return readable((get) => resolveCreate(get, x, options));
  if (I.isEffect(x) || Stream.isStream(x)) return readable((get) => resolveCreate(get, x, options));
  return state(x);
};
const state = <A>(initial: A): Writable<A> => writable(() => initial, (ctx, v: A) => ctx.setSelf(v));

// ---------- modifiers ----------
export const keepAlive = <A extends Atom<any>>(self: A): A => modify(self, { keepAlive: true });
export const setLazy: { (lazy: boolean): <A extends Atom<any>>(self: A) => A; <A extends Atom<any>>(self: A, lazy: boolean): A } = I.dual(2, <A extends Atom<any>>(self: A, lazy: boolean) => modify(self, { lazy }));
export const setIdleTTL: { (d: D.Input): <A extends Atom<any>>(self: A) => A; <A extends Atom<any>>(self: A, d: D.Input): A } =
  I.dual(2, <A extends Atom<any>>(self: A, d: D.Input) => modify(self, { idleTTL: D.toMillis(d) }));
export const withLabel: { (name: string): <A extends Atom<any>>(self: A) => A; <A extends Atom<any>>(self: A, name: string): A } =
  I.dual(2, <A extends Atom<any>>(self: A, name: string) => modify(self, { label: [name, ""] }));
export const withEquality: {
  <A>(equals: (value: A, next: A) => boolean): <T extends Atom<A>>(self: T) => T;
  <T extends Atom<any>>(self: T, equals: (value: Type<T>, next: Type<T>) => boolean): T;
} = I.dual(2, <T extends Atom<any>>(self: T, equals: (a: any, b: any) => boolean) => modify(self, { equals }));
export const initialValue: {
  <A>(value: A): (self: Atom<A>) => readonly [Atom<A>, A];
  <A>(self: Atom<A>, value: A): readonly [Atom<A>, A];
} = I.dual(2, <A>(self: Atom<A>, value: A) => [self, value] as const);
export const transform: {
  <R extends Atom<any>, B>(f: (get: AtomContext, atom: R) => B, options?: { readonly initialValueTarget?: Atom<B> }): (self: R) => [R] extends [Writable<infer _, infer RW>] ? Writable<B, RW> : Atom<B>;
  <R extends Atom<any>, B>(self: R, f: (get: AtomContext, atom: R) => B, options?: { readonly initialValueTarget?: Atom<B> }): [R] extends [Writable<infer _, infer RW>] ? Writable<B, RW> : Atom<B>;
} = I.dual((args) => isAtom(args[0]), (self: Atom<any>, f: (get: AtomContext, a: Atom<any>) => any) =>
  isWritable(self)
    ? writable((get) => f(get, self), (ctx, v) => ctx.set(self as Writable<any, any>, v), (r) => r(self))
    : readable((get) => f(get, self), (r) => r(self)));
export const map: {
  <R extends Atom<any>, B>(f: (_: Type<R>) => B): (self: R) => [R] extends [Writable<infer _, infer RW>] ? Writable<B, RW> : Atom<B>;
  <R extends Atom<any>, B>(self: R, f: (_: Type<R>) => B): [R] extends [Writable<infer _, infer RW>] ? Writable<B, RW> : Atom<B>;
} = I.dual(2, (self: Atom<any>, f: (a: any) => any) => Object.assign(transform(self, (get) => f(get(self))), { privateContext: true }));
export const mapResult: {
  <R extends Atom<AR.AsyncResult<any, any>>, B>(f: (_: AR.AsyncResult.Success<Type<R>>) => B): (self: R) => Atom<AR.AsyncResult<B, AR.AsyncResult.Failure<Type<R>>>>;
  <R extends Atom<AR.AsyncResult<any, any>>, B>(self: R, f: (_: AR.AsyncResult.Success<Type<R>>) => B): Atom<AR.AsyncResult<B, AR.AsyncResult.Failure<Type<R>>>>;
} = I.dual(2, (self: Atom<AR.AsyncResult<any, any>>, f: (a: any) => any) => map(self, (r: AR.AsyncResult<any, any>) => AR.map(r, f)));
export const debounce: { (d: D.Input): <A extends Atom<any>>(self: A) => A; <A extends Atom<any>>(self: A, d: D.Input): A } =
  I.dual(2, <A extends Atom<any>>(self: A, d: D.Input): A => {
    const ms = D.toMillis(d);
    return transform(self, (get) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      get.addFinalizer(() => clearTimeout(timer));
      get.subscribe(self, (v) => {
        clearTimeout(timer);
        timer = setTimeout(() => get.setSelf(v), ms);
      });
      return get.once(self);
    }) as never;
  });
export const withRefresh: { (d: D.Input): <A extends Atom<any>>(self: A) => A; <A extends Atom<any>>(self: A, d: D.Input): A } =
  I.dual(2, <A extends Atom<any>>(self: A, d: D.Input): A => {
    const ms = D.toMillis(d);
    return transform(self, (get) => {
      const h = setTimeout(() => get.refresh(self), ms);
      get.addFinalizer(() => clearTimeout(h));
      return get(self);
    }) as never;
  });
export const makeRefreshOnSignal = <_>(signal: Atom<_>) => <A extends Atom<any>>(self: A): A =>
  transform(self, (get) => {
    get.subscribe(signal, () => get.refresh(self));
    return get(self);
  }) as never;
export const refreshOnWindowFocus = <A extends Atom<any>>(self: A): A => self;
/** Stale-while-revalidate: refresh on mount when the last success is older than `staleTime`. */
export const swr: {
  (options: { readonly staleTime: D.Input; readonly revalidateOnMount?: boolean; readonly revalidateOnFocus?: boolean | "always"; readonly focusSignal?: Atom<any> }): <R extends Atom<AR.AsyncResult<any, any>>>(self: R) => R;
  <R extends Atom<AR.AsyncResult<any, any>>>(self: R, options: { readonly staleTime: D.Input; readonly revalidateOnMount?: boolean; readonly revalidateOnFocus?: boolean | "always"; readonly focusSignal?: Atom<any> }): R;
} = I.dual(2, <R extends Atom<AR.AsyncResult<any, any>>>(self: R, o: { staleTime: D.Input; revalidateOnMount?: boolean; focusSignal?: Atom<any> }): R => {
  const stale = D.toMillis(o.staleTime);
  return transform(self, (get) => {
    const r = get(self);
    if (o.revalidateOnMount && r._tag === "Success" && Date.now() - r.timestamp > stale && !r.waiting) queueMicrotask(() => get.refresh(self));
    if (o.focusSignal) get.subscribe(o.focusSignal, () => {
      const cur = get.once(self);
      if (cur._tag === "Success" && Date.now() - cur.timestamp > stale) get.refresh(self);
    });
    return r;
  }) as never;
});

// ---------- families ----------
/** Memoize `f` by structural key; entries are weakly held so unused atoms can be collected. */
export const family = <Arg, T extends object>(f: (arg: Arg) => T): ((arg: Arg) => T) => {
  const buckets = new Map<number, Array<{ arg: Arg; ref: WeakRef<T> }>>();
  const registry = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<number>((h) => {
      const b = buckets.get(h);
      if (!b) return;
      const live = b.filter((e) => e.ref.deref() !== undefined);
      live.length ? buckets.set(h, live) : buckets.delete(h);
    })
    : undefined;
  const keyHash = (a: Arg) => (typeof a === "object" && a !== null && !I.isEqual(a) ? I.hashString(I.safeJson(a)) : I.hash(a));
  const same = (a: Arg, b: Arg) => I.equals(a, b) || (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !I.isEqual(a) && I.safeJson(a) === I.safeJson(b));
  return (arg) => {
    const h = keyHash(arg);
    const b = buckets.get(h);
    if (b) for (const e of b) if (same(e.arg, arg)) {
      const v = e.ref.deref();
      if (v) return v;
    }
    const v = f(arg);
    const entry = { arg, ref: new WeakRef(v) };
    if (b) b.push(entry);
    else buckets.set(h, [entry]);
    registry?.register(v, h);
    return v;
  };
};

// ---------- function atoms ----------
export const Reset: unique symbol = Symbol.for("effect/reactivity/Atom/Reset") as never;
export type Reset = typeof Reset;
export const Interrupt: unique symbol = Symbol.for("effect/reactivity/Atom/Interrupt") as never;
export type Interrupt = typeof Interrupt;
export interface AtomResultFn<Arg, A, E = never> extends Writable<AR.AsyncResult<A, E>, Arg | Reset | Interrupt> {}
const fnRuns = new WeakMap<object, { fiber: I.Fiber<any, any>; scope: ScopeM.ScopeImpl }>();
function makeFn<Arg, A, E>(body: (arg: Arg, get: AtomContext) => unknown, options: { readonly initialValue?: A; readonly concurrent?: boolean } | undefined, ctxAtom?: Atom<AR.AsyncResult<I.Context<any>, any>>, reactivityKeys?: unknown): AtomResultFn<Arg, A, E> {
  const init: AR.AsyncResult<A, E> = options?.initialValue !== undefined ? AR.success(options.initialValue) : AR.initial();
  return writable<AR.AsyncResult<A, E>, Arg | Reset | Interrupt>(
    (get) => {
      if (ctxAtom) get(ctxAtom);
      get.addFinalizer(() => {
        const run = fnRuns.get(get as object);
        run?.fiber.interruptAsFork(undefined);
      });
      return get.self<AR.AsyncResult<A, E>>().pipe(O.getOrElse(() => init));
    },
    (ctx, arg) => {
      const node = (ctx as unknown as { "~node": Node<AR.AsyncResult<A, E>> })["~node"];
      const key = node as object;
      const prevRun = fnRuns.get(key);
      if (arg === Reset || arg === Interrupt) {
        prevRun?.fiber.interruptAsFork(undefined);
        if (arg === Reset) ctx.setSelf(init);
        else {
          const cur = ctx.get(node.atom);
          if (cur.waiting) ctx.setSelf(AR.failure(C.interrupt(), { previousSuccess: cur._tag === "Success" ? O.some(cur) : O.none() }));
        }
        return;
      }
      if (prevRun && !options?.concurrent) prevRun.fiber.interruptAsFork(undefined);
      const reg = node.registry;
      let base: I.Context<any> = I.emptyContext;
      if (ctxAtom) {
        const rt = reg.get(ctxAtom);
        if (rt._tag !== "Success") return ctx.setSelf(rt._tag === "Failure" ? (rt as unknown as AR.AsyncResult<A, E>) : AR.initial(true));
        base = rt.value;
      }
      const scope = new ScopeM.ScopeImpl();
      const getCtx = fnContext(reg, node);
      const out = body(arg, getCtx);
      const prev = O.some(ctx.get(node.atom));
      const context = I.contextAdd(I.contextAdd(base, AtomRegistry.key, reg), ScopeM.Scope.key, scope);
      let eff: I.Effect<any, any, any>;
      if (Stream.isStream(out)) {
        let last: { v: A } | undefined;
        eff = I.make((f) => I.chain(I.exec(Stream.runForEach(out, (a: A) => I.make(() => {
          last = { v: a };
          ctx.setSelf(AR.success(a, { waiting: true }));
        })), f), () => (last ? last.v : I.failWith(I.causeFail(new C.NoSuchElementError())))));
      } else eff = out as I.Effect<any, any, any>;
      const fiber = I.runFiber(eff, context);
      fnRuns.set(key, { fiber, scope });
      const done = (exit: I.Exit<A, E>) => {
        if (fnRuns.get(key)?.fiber === fiber) fnRuns.delete(key);
        I.runFiber(I.make((f) => scope.closeStep(I.exitVoid, f)), I.emptyContext);
        if (exit._tag === "Failure" && C.hasInterruptsOnly(exit.cause) && fiber.interrupted) return;
        if (exit._tag === "Success" && reactivityKeys) (reg as unknown as { invalidateKeys?: (k: unknown) => void }).invalidateKeys?.(reactivityKeys);
        node.setValue(AR.fromExitWithPrevious(exit, prev));
      };
      if (fiber.exit) done(fiber.exit as I.Exit<A, E>);
      else {
        ctx.setSelf(AR.waitingFrom(prev));
        fiber.addObserver(done as (e: I.Exit<unknown, unknown>) => void);
      }
    },
  ) as AtomResultFn<Arg, A, E>;
}
function fnContext(reg: Registry, node: Node<any>): AtomContext {
  const get = (<B>(atom: Atom<B>) => reg.get(atom)) as unknown as Record<string, unknown>;
  Object.assign(get, {
    get: (atom: Atom<any>) => reg.get(atom),
    once: (atom: Atom<any>) => reg.get(atom),
    registry: reg,
    addFinalizer: () => {},
    mount: (atom: Atom<any>) => void reg.mount(atom),
    refresh: (atom: Atom<any>) => reg.refresh(atom),
    refreshSelf: () => reg.refreshNode(node),
    self: () => O.some(node.value),
    setSelf: (a: unknown) => node.setValue(a),
    set: (atom: Writable<any, any>, v: unknown) => reg.set(atom, v),
    result: (atom: Atom<AR.AsyncResult<any, any>>, o?: { suspendOnWaiting?: boolean }) => getResultLazy(reg, atom, o),
    resultOnce: (atom: Atom<AR.AsyncResult<any, any>>, o?: { suspendOnWaiting?: boolean }) => getResultLazy(reg, atom, o),
    subscribe: (atom: Atom<any>, f: (a: any) => void, o?: { immediate?: boolean }) => void reg.subscribe(atom, f, o),
  });
  return get as unknown as AtomContext;
}
const getResultLazy = (reg: Registry, atom: Atom<AR.AsyncResult<any, any>>, o?: { suspendOnWaiting?: boolean }) => registryModule.getResult(reg, atom, o);
export const fn: {
  <Arg>(): <E, A>(fn: (arg: Arg, get: FnContext) => I.Effect<A, E, ScopeM.Scope | AtomRegistryT> | Stream.Stream<A, E, AtomRegistryT>, options?: { readonly initialValue?: A; readonly concurrent?: boolean }) => AtomResultFn<Arg, A, E>;
  <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => I.Effect<A, E, ScopeM.Scope | AtomRegistryT> | Stream.Stream<A, E, AtomRegistryT>, options?: { readonly initialValue?: A; readonly concurrent?: boolean }): AtomResultFn<Arg, A, E>;
} = function (body?: any, options?: any): any {
  if (body === undefined) return (b: any, o: any) => makeFn(b, o);
  return makeFn(body, options);
} as never;
export const fnSync: {
  <Arg>(): <A>(fn: (arg: Arg, get: FnContext) => A, options?: { readonly initialValue?: A }) => Writable<O.Option<A> | A, Arg>;
  <A, Arg = void>(fn: (arg: Arg, get: FnContext) => A, options?: { readonly initialValue?: A }): Writable<O.Option<A> | A, Arg>;
} = function (body?: any, options?: any): any {
  const mk = (b: (arg: unknown, get: AtomContext) => unknown, o?: { initialValue?: unknown }) =>
    writable((get) => get.self().pipe(O.getOrElse(() => (o?.initialValue !== undefined ? o.initialValue : O.none()))), (ctx, arg) => {
      const node = (ctx as unknown as { "~node": Node<unknown> })["~node"];
      ctx.setSelf(o?.initialValue !== undefined ? b(arg, fnContext(node.registry, node)) : O.some(b(arg, fnContext(node.registry, node))));
    });
  return body === undefined ? mk : mk(body, options);
} as never;

// ---------- runtimes ----------
export interface AtomRuntime<R, ER = never> extends Atom<AR.AsyncResult<I.Context<R>, ER>> {
  readonly layer: Atom<Layer.Layer<R, ER>>;
  readonly atom: {
    <A, E>(create: ((get: AtomContext) => I.Effect<A, E, ScopeM.Scope | R | AtomRegistryT | Reactivity.Reactivity>) | I.Effect<A, E, ScopeM.Scope | R | AtomRegistryT | Reactivity.Reactivity>, options?: { readonly initialValue?: A; readonly uninterruptible?: boolean }): Atom<AR.AsyncResult<A, E | ER>>;
    <A, E>(create: ((get: AtomContext) => Stream.Stream<A, E, AtomRegistryT | Reactivity.Reactivity | R>) | Stream.Stream<A, E, AtomRegistryT | Reactivity.Reactivity | R>, options?: { readonly initialValue?: A }): Atom<AR.AsyncResult<A, E | ER | C.NoSuchElementError>>;
  };
  readonly fn: {
    <Arg>(): <E, A>(fn: (arg: Arg, get: FnContext) => I.Effect<A, E, ScopeM.Scope | AtomRegistryT | Reactivity.Reactivity | R> | Stream.Stream<A, E, AtomRegistryT | Reactivity.Reactivity | R>, options?: { readonly initialValue?: A; readonly reactivityKeys?: unknown; readonly concurrent?: boolean }) => AtomResultFn<Arg, A, E | ER>;
    <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => I.Effect<A, E, ScopeM.Scope | AtomRegistryT | Reactivity.Reactivity | R> | Stream.Stream<A, E, AtomRegistryT | Reactivity.Reactivity | R>, options?: { readonly initialValue?: A; readonly reactivityKeys?: unknown; readonly concurrent?: boolean }): AtomResultFn<Arg, A, E | ER>;
  };
  readonly subscriptionRef: <A, E>(create: I.Effect<SubRef.SubscriptionRef<A>, E, ScopeM.Scope | R | AtomRegistryT> | ((get: AtomContext) => I.Effect<SubRef.SubscriptionRef<A>, E, ScopeM.Scope | R | AtomRegistryT>)) => Writable<AR.AsyncResult<A, E | ER>, A>;
}
export interface RuntimeFactory {
  <R, E>(create: Layer.Layer<R, E, AtomRegistryT | Reactivity.Reactivity> | ((get: AtomContext) => Layer.Layer<R, E, AtomRegistryT | Reactivity.Reactivity>)): AtomRuntime<R, E>;
  readonly memoMap: Atom<Layer.MemoMap>;
  readonly addGlobalLayer: <A, E>(layer: Layer.Layer<A, E, AtomRegistryT | Reactivity.Reactivity>) => void;
  readonly withReactivity: (keys: unknown) => <A extends Atom<any>>(atom: A) => A;
}
export type RegistryRuntimeFactory = RuntimeFactory;
const globalLayers: Array<Layer.Any> = [];
const memoMapAtom = keepAlive(readable(() => Layer.makeMemoMap()));
const mkRuntime = <R, E>(create: Layer.Layer<R, E, any> | ((get: AtomContext) => Layer.Layer<R, E, any>)): AtomRuntime<R, E> => {
  const layerAtom = keepAlive(readable((get) => (typeof create === "function" ? create(get) : create)));
  const self = readable<AR.AsyncResult<I.Context<R>, E>>((get) => {
    const layer = get(layerAtom);
    const memo = get(memoMapAtom);
    const all = globalLayers.length ? Layer.provideMerge(layer, Layer.mergeAll(...(globalLayers as [Layer.Any]))) : layer;
    return runEffect(get, I.make<I.Context<R>, E>((f) => Layer.buildLayer(all, memo, f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl, f)), undefined);
  }) as AtomRuntime<R, E>;
  const withCtx = <A>(get: AtomContext, f: (ctx: I.Context<any>) => A): A | AR.AsyncResult<never, E> => {
    const rt = get(self);
    if (rt._tag === "Initial") return AR.initial(true) as never;
    if (rt._tag === "Failure") return rt as never;
    return f(rt.value);
  };
  Object.assign(self, {
    layer: layerAtom,
    atom: (create: unknown, options?: unknown) => readable((get) => withCtx(get, (ctx) => {
      const v = typeof create === "function" && !I.isEffect(create) ? (create as (g: AtomContext) => unknown)(get) : create;
      return Stream.isStream(v) ? runStream(get, v, options as never, ctx) : runEffect(get, v as I.Effect<any, any, any>, options as never, ctx);
    })),
    fn: function (body?: any, options?: any): any {
      const mk = (b: any, o: any) => makeFn(b, o, self as Atom<AR.AsyncResult<I.Context<any>, any>>, o?.reactivityKeys);
      return body === undefined ? mk : mk(body, options);
    },
    subscriptionRef: (create: unknown) => subscriptionRefImpl(create, self as Atom<AR.AsyncResult<I.Context<any>, any>>),
  });
  return self;
};
export const runtime: RuntimeFactory = Object.assign(mkRuntime, {
  memoMap: memoMapAtom,
  addGlobalLayer: (layer: Layer.Any) => void globalLayers.push(layer),
  withReactivity: (_keys: unknown) => <A extends Atom<any>>(atom: A) => atom,
}) as never;
export const context = (_options?: { readonly memoMap?: Layer.MemoMap }): RuntimeFactory => runtime;

// ---------- refs ----------
function subscriptionRefImpl(create: unknown, ctxAtom?: Atom<AR.AsyncResult<I.Context<any>, any>>): Writable<any, any> {
  const refAtom = readable((get) => {
    const v = typeof create === "function" && !I.isEffect(create) ? (create as (g: AtomContext) => unknown)(get) : create;
    if (v instanceof SubRef.SubscriptionRef) return AR.success(v);
    if (!ctxAtom) return runEffect(get, v as I.Effect<any, any, any>, undefined);
    const rt = get(ctxAtom);
    return rt._tag === "Success" ? runEffect(get, v as I.Effect<any, any, any>, undefined, rt.value) : rt;
  });
  const plain = typeof create !== "function" || I.isEffect(create) ? create instanceof SubRef.SubscriptionRef : false;
  return writable(
    (get) => {
      const r = get(refAtom) as AR.AsyncResult<SubRef.SubscriptionRef<any>, any>;
      if (r._tag !== "Success") return r;
      const ref = r.value;
      get.addFinalizer(ref.listen((a) => get.setSelf(plain ? a : AR.success(a))));
      return plain ? ref.value : AR.success(ref.value);
    },
    (ctx, value) => {
      const r = ctx.get(refAtom) as AR.AsyncResult<SubRef.SubscriptionRef<any>, any>;
      if (r._tag === "Success") r.value.setUnsafe(value);
    },
  );
}
export const subscriptionRef: {
  <A>(ref: SubRef.SubscriptionRef<A> | ((get: AtomContext) => SubRef.SubscriptionRef<A>)): Writable<A>;
  <A, E>(effect: I.Effect<SubRef.SubscriptionRef<A>, E, ScopeM.Scope | AtomRegistryT> | ((get: AtomContext) => I.Effect<SubRef.SubscriptionRef<A>, E, ScopeM.Scope | AtomRegistryT>)): Writable<AR.AsyncResult<A, E>, A>;
} = ((create: unknown) => subscriptionRefImpl(create)) as never;

// ---------- serialization ----------
export interface Serializable<S> {
  readonly [SerializableTypeId]: { readonly key: string; readonly encode: (value: unknown) => unknown; readonly decode: (value: unknown) => unknown };
  readonly _S?: S;
}
export const isSerializable = (self: Atom<any>): self is Atom<any> & Serializable<any> => SerializableTypeId in self;
export const serializable: {
  <R extends Atom<any>, S>(options: { readonly key: string; readonly schema: S }): (self: R) => R & Serializable<S>;
  <R extends Atom<any>, S>(self: R, options: { readonly key: string; readonly schema: S }): R & Serializable<S>;
} = I.dual(2, (self: Atom<any>, o: { key: string; schema: unknown }) => {
  return modify(self, {
    serializableKey: o.key,
    [SerializableTypeId]: { key: o.key, encode: (v: unknown) => v, decode: (v: unknown) => v },
    decodeSerializable: (v: unknown) => v,
  });
});
export type InitialValueOptions = {};
export const get = <A>(self: Atom<A>): I.Effect<A, never, AtomRegistryT> => I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => r.get(self)));
export const set: {
  <W>(value: W): <R>(self: Writable<R, W>) => I.Effect<void, never, AtomRegistryT>;
  <R, W>(self: Writable<R, W>, value: W): I.Effect<void, never, AtomRegistryT>;
} = I.dual(2, (self: Writable<any, any>, value: unknown) => I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => r.set(self, value))));
export const update: {
  <R, W>(f: (_: R) => W): (self: Writable<R, W>) => I.Effect<void, never, AtomRegistryT>;
  <R, W>(self: Writable<R, W>, f: (_: R) => W): I.Effect<void, never, AtomRegistryT>;
} = I.dual(2, (self: Writable<any, any>, g: (r: any) => any) => I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => r.update(self, g))));
export const refresh = <A>(self: Atom<A>): I.Effect<void, never, AtomRegistryT> => I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => r.refresh(self)));
export const toStream = <A>(self: Atom<A>): Stream.Stream<A, never, AtomRegistryT> =>
  Stream.unwrap(I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => registryModule.toStream(r, self)))) as never;
export const getResult = <A, E>(self: Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean }): I.Effect<A, E, AtomRegistryT> =>
  I.make((f) => I.chain(I.exec(AtomRegistry, f), (r) => I.exec(registryModule.getResult(r, self, options), f)));
