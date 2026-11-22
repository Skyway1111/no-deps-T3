import * as I from "./internal.ts";
import { Async, chain, exec, execF, Failure, make, settle, type Step } from "./internal.ts";
import * as C from "./Cause.ts";
import * as O from "./Option.ts";
import * as R from "./Result.ts";
import * as D from "./Duration.ts";
import * as Ctx from "./Context.ts";
import * as ScopeM from "./Scope.ts";
import * as Sched from "./Schedule.ts";
import { Clock, sleepMillis } from "./Clock.ts";
import * as Refs from "./References.ts";
import * as T from "./Tracer.ts";
import * as Log from "./Logger.ts";
import { NoSuchElementError, TimeoutError, UnknownError } from "./errors.ts";
import { buildLayer, isLayer, makeMemoMap, type Layer } from "./Layer.ts";

export type Effect<A, E = never, R = never> = I.Effect<A, E, R>;
export declare namespace Effect {
  type Success<T> = T extends I.Effect<infer A, any, any> ? A : never;
  type Error<T> = T extends I.Effect<any, infer E, any> ? E : never;
  type Services<T> = T extends I.Effect<any, any, infer R> ? R : never;
  type Context<T> = Services<T>;
  type AsEffect<T> = T extends I.Effect<infer A, infer E, infer R> ? I.Effect<A, E, R> : never;
}
export type Success<T> = Effect.Success<T>;
export type Error<T> = Effect.Error<T>;
export type Services<T> = Effect.Services<T>;
export const TypeId = I.EffectTypeId;
export const isEffect = I.isEffect;
type Fiber<A, E> = I.Fiber<A, E>;
type Exit<A, E> = I.Exit<A, E>;
type Cause<E> = I.Cause<E>;
type LazyArg<A> = () => A;

const fiberRunOpts = (f: I.Fiber) => ({ inheritFrom: f });
const rethrow = (e: unknown): never => {
  throw I.toFailure(e);
};
/** Run `eff` on `f` with interruption masked (used for finalizers). */
function runMasked<A>(eff: Effect<A, any, any>, f: I.Fiber): Step<A> {
  f.uninterruptible++;
  return settle(
    () => execF(eff, f),
    (a) => (f.uninterruptible--, a),
    (e) => (f.uninterruptible--, rethrow(e)),
  );
}
const isDataFirst = (args: IArguments) => isEffect(args[0]);

// ---------- constructors ----------
export const succeed = <A>(value: A): Effect<A> => make(() => value);
const void_: Effect<void> = succeed(undefined);
export { void_ as void };
export const undefined_: Effect<undefined> = succeed(undefined);
export { undefined_ as undefined };
export const succeedNone: Effect<O.Option<never>> = succeed(O.none());
export const succeedSome = <A>(a: A): Effect<O.Option<A>> => succeed(O.some(a));
/** The Failure is immutable, so it is allocated once per `fail` value rather than per run. */
const failWithFailure = <E>(failure: Failure): Effect<never, E> => make<never, E>(() => failure);
export const fail = <E>(error: E): Effect<never, E> => failWithFailure(new Failure(I.causeFail(error)));
export const failSync = <E>(f: LazyArg<E>): Effect<never, E> => make<never, E>(() => new Failure(I.causeFail(f())));
export const failCause = <E>(cause: Cause<E>): Effect<never, E> => failWithFailure(new Failure(cause));
export const failCauseSync = <E>(f: LazyArg<Cause<E>>): Effect<never, E> => make<never, E>(() => new Failure(f()));
export const die = (defect: unknown): Effect<never> => failWithFailure(new Failure(I.causeDie(defect)));
export const dieMessage = (message: string): Effect<never> => die(new Error(message));
export const sync = <A>(f: LazyArg<A>): Effect<A> => make(() => f());
export const suspend = <A, E, R>(f: LazyArg<Effect<A, E, R>>): Effect<A, E, R> => make((fib) => execF(f(), fib));
export const never: Effect<never> = make((f) => I.interruptibleWait<never>(f, () => {}));
export const interrupt: Effect<never> = make<never>((f) => new Failure(I.causeInterrupt(f.id)));
export const yieldNow: Effect<void> = make(
  (f) =>
    I.interruptibleWait<void>(f, (resolve) => {
      const h = setTimeout(resolve, 0);
      return () => clearTimeout(h);
    }),
);
export const fiber: Effect<Fiber<unknown, unknown>> = make((f) => f);
export const fiberId: Effect<number> = make((f) => f.id);
export const withFiber = <A, E = never, R = never>(f: (fiber: Fiber<unknown, unknown>) => Effect<A, E, R>): Effect<A, E, R> =>
  make((fib) => exec(f(fib), fib));

const tryImpl = <A, E>(
  options: LazyArg<A> | { readonly try: LazyArg<A>; readonly catch: (error: unknown) => E },
): Effect<A, E | UnknownError> =>
  make(() => {
    if (typeof options === "function") {
      try {
        return options();
      } catch (e) {
        return I.failWith(I.causeFail(new UnknownError(e)));
      }
    }
    try {
      return options.try();
    } catch (e) {
      return I.failWith(I.causeFail(options.catch(e)));
    }
  });
export const try_: {
  <A, E>(options: { readonly try: LazyArg<A>; readonly catch: (error: unknown) => E }): Effect<A, E>;
  <A>(thunk: LazyArg<A>): Effect<A, UnknownError>;
} = tryImpl as never;
export { try_ as try };

/** Await a promise from `f`; the AbortSignal (made only if `f` declares it) fires when the fiber is interrupted. */
function awaitPromise<A>(fib: I.Fiber, f: (signal: AbortSignal) => PromiseLike<A>, onReject: (e: unknown) => Failure): Async<A> | Failure {
  const ctl = f.length === 0 ? undefined : new AbortController();
  let p: PromiseLike<A>;
  try {
    p = f(ctl?.signal as AbortSignal);
  } catch (e) {
    return onReject(e);
  }
  const w = new I.Waiter<A>();
  const onInterrupt = () => {
    ctl?.abort();
    w.settle(true, new Failure(I.causeInterrupt(fib.interruptor)));
  };
  fib.onInterrupt(onInterrupt);
  p.then(
    (a) => (fib.offInterrupt(onInterrupt), w.settle(false, I.box(a))),
    (e) => (fib.offInterrupt(onInterrupt), w.settle(true, onReject(e))),
  );
  return w;
}
const dieFailure = (e: unknown) => new Failure(I.causeDie(e));
export const promise = <A>(f: (signal: AbortSignal) => PromiseLike<A>): Effect<A> => make((fib) => awaitPromise(fib, f, dieFailure));
export const tryPromise: {
  <A, E>(options: { readonly try: (signal: AbortSignal) => PromiseLike<A>; readonly catch: (error: unknown) => E }): Effect<A, E>;
  <A>(f: (signal: AbortSignal) => PromiseLike<A>): Effect<A, UnknownError>;
} = (<A, E>(o: ((s: AbortSignal) => PromiseLike<A>) | { try: (s: AbortSignal) => PromiseLike<A>; catch: (e: unknown) => E }) =>
  typeof o === "function"
    ? make((fib) => awaitPromise(fib, o, (e) => new Failure(I.causeFail(new UnknownError(e)))))
    : make((fib) => awaitPromise(fib, o.try, (e) => new Failure(I.causeFail(o.catch(e)))))) as never;

/** `register(resume, signal)`; may return a cleanup Effect run on interruption. */
export const callback = <A, E = never, R = never>(
  register: (resume: (effect: Effect<A, E, R>) => void, signal: AbortSignal) => void | Effect<void, never, R>,
): Effect<A, E, R> =>
  make((fib) => {
    let resumed: Effect<A, E, R> | undefined;
    let wake: ((e: Effect<A, E, R>) => void) | undefined;
    const ctl = new AbortController();
    const resume = (e: Effect<A, E, R>) => {
      if (resumed) return;
      resumed = e;
      wake?.(e);
    };
    let cleanup: void | Effect<void, never, R>;
    try {
      cleanup = register(resume, ctl.signal);
    } catch (e) {
      return I.failWith(I.causeDie(e));
    }
    if (resumed) return exec(resumed, fib);
    const waited = I.interruptibleWait<Effect<A, E, R>>(fib, (res) => {
      wake = res;
      return () => ctl.abort();
    });
    return new Async(
      waited.p.then(
        (e) => I.toThen(exec(I.unbox(e) as Effect<A, E, R>, fib)),
        (err) => {
          if (cleanup) return I.toThen(chain(runMasked(cleanup, fib), () => rethrow(err)));
          return rethrow(err);
        },
      ),
    ) as Async<A>;
  });
export const async = callback;

// ---------- generators ----------
/** Advance `it` until it returns, fails, or suspends; yields the return value, the Failure, or the pending Async. */
function advance(it: Iterator<any, any>, fib: I.Fiber, input: unknown): unknown {
  let state = it.next(input);
  while (!state.done) {
    const r = execF(state.value, fib);
    if (r instanceof Async || r instanceof Failure) return r;
    state = it.next(r);
  }
  return state.value;
}
function stepGen(it: Iterator<any, any>, fib: I.Fiber, input: unknown): Step<any> | Failure {
  const r = advance(it, fib, input);
  return r instanceof Async ? resumeGen(it, fib, r) : r;
}
/** One Promise per suspended generator run, instead of a nested Promise per async step. */
function resumeGen(it: Iterator<any, any>, fib: I.Fiber, pending: Async): Async<any> {
  return new Async(
    new Promise((resolve, reject) => {
      const resume = (v: unknown) => {
        let r: unknown;
        try {
          r = advance(it, fib, I.unbox(v));
        } catch (e) {
          return reject(e);
        }
        if (r instanceof Async) r.listen(resume, reject);
        else if (r instanceof Failure) reject(r);
        else resolve(I.box(r));
      };
      pending.listen(resume, reject);
    }),
  );
}
type GenE<Eff> = [Eff] extends [never] ? never : Eff extends I.Effect<any, infer E, any> ? E : never;
type GenR<Eff> = [Eff] extends [never] ? never : Eff extends I.Effect<any, any, infer R> ? R : never;
export const gen: {
  <Eff extends I.Effect<any, any, any>, AEff>(f: () => Generator<Eff, AEff, never>): Effect<AEff, GenE<Eff>, GenR<Eff>>;
  <Self, Eff extends I.Effect<any, any, any>, AEff>(
    options: { readonly self: Self },
    f: (this: Self) => Generator<Eff, AEff, never>,
  ): Effect<AEff, GenE<Eff>, GenR<Eff>>;
} = function (a: any, b?: any) {
  const self = b === undefined ? undefined : a?.self ?? a;
  const body = b === undefined ? a : b;
  return make((fib) => stepGen(body.call(self), fib, undefined));
} as never;

type FnReturn<Eff, AEff> = Effect<AEff, GenE<Eff>, GenR<Eff>>;
export interface FnOptions {
  readonly attributes?: Record<string, unknown>;
  readonly kind?: T.SpanKind;
  readonly root?: boolean;
  readonly captureStackTrace?: boolean;
}
export interface Fn {
  <Eff extends I.Effect<any, any, any>, AEff, Args extends Array<any>>(
    body: (...args: Args) => Generator<Eff, AEff, never>,
  ): (...args: Args) => FnReturn<Eff, AEff>;
  <Eff extends I.Effect<any, any, any>, AEff, Args extends Array<any>, Out>(
    body: (...args: Args) => Generator<Eff, AEff, never>,
    a: (_: FnReturn<Eff, AEff>, ...args: NoInfer<Args>) => Out,
  ): (...args: Args) => Out;
  <Eff extends I.Effect<any, any, any>, AEff, Args extends Array<any>, A, Out>(
    body: (...args: Args) => Generator<Eff, AEff, never>,
    a: (_: FnReturn<Eff, AEff>, ...args: NoInfer<Args>) => A,
    b: (_: A, ...args: NoInfer<Args>) => Out,
  ): (...args: Args) => Out;
  <Eff extends I.Effect<any, any, any>, AEff, Args extends Array<any>, A, B, Out>(
    body: (...args: Args) => Generator<Eff, AEff, never>,
    a: (_: FnReturn<Eff, AEff>, ...args: NoInfer<Args>) => A,
    b: (_: A, ...args: NoInfer<Args>) => B,
    c: (_: B, ...args: NoInfer<Args>) => Out,
  ): (...args: Args) => Out;
  <Eff extends I.Effect<any, any, any>, AEff, Args extends Array<any>, A, B, C, Out>(
    body: (...args: Args) => Generator<Eff, AEff, never>,
    a: (_: FnReturn<Eff, AEff>, ...args: NoInfer<Args>) => A,
    b: (_: A, ...args: NoInfer<Args>) => B,
    c: (_: B, ...args: NoInfer<Args>) => C,
    d: (_: C, ...args: NoInfer<Args>) => Out,
  ): (...args: Args) => Out;
  <A, E, R, Args extends Array<any>>(body: (...args: Args) => Effect<A, E, R>): (...args: Args) => Effect<A, E, R>;
  <A, E, R, Args extends Array<any>, Out>(
    body: (...args: Args) => Effect<A, E, R>,
    a: (_: Effect<A, E, R>, ...args: NoInfer<Args>) => Out,
  ): (...args: Args) => Out;
}
function makeFn(name: string | undefined, options: FnOptions | undefined, body: Function, pipeables: ReadonlyArray<Function>): Function {
  return function (this: unknown, ...args: Array<unknown>) {
    const self = this;
    let eff: Effect<unknown, unknown, unknown> = make((fib) => {
      const out = body.apply(self, args);
      if (isEffect(out)) return execF(out, fib);
      return stepGen(out, fib, undefined);
    });
    for (const p of pipeables) eff = p(eff, ...args);
    return name === undefined ? eff : withSpan(eff, name, options);
  };
}
export const fn: Fn & ((name: string, options?: FnOptions) => Fn) = function (nameOrBody: any, ...rest: Array<any>) {
  if (typeof nameOrBody === "string") {
    const options = rest[0] as FnOptions | undefined;
    return (body: Function, ...pipeables: Array<Function>) => makeFn(nameOrBody, options, body, pipeables);
  }
  return makeFn(undefined, undefined, nameOrBody, rest);
} as never;
export const fnUntraced: Fn = ((body: Function, ...pipeables: Array<Function>) => makeFn(undefined, undefined, body, pipeables)) as never;

// ---------- sequencing ----------
export const map: {
  <A, B>(f: (a: A) => B): <E, R>(self: Effect<A, E, R>) => Effect<B, E, R>;
  <A, E, R, B>(self: Effect<A, E, R>, f: (a: A) => B): Effect<B, E, R>;
} = I.dual(2, <A, B>(self: Effect<A, any, any>, f: (a: A) => B) => make((fib) => chain(execF(self, fib), f)));
export const flatMap: {
  <A, B, E1, R1>(f: (a: A) => Effect<B, E1, R1>): <E, R>(self: Effect<A, E, R>) => Effect<B, E1 | E, R1 | R>;
  <A, E, R, B, E1, R1>(self: Effect<A, E, R>, f: (a: A) => Effect<B, E1, R1>): Effect<B, E | E1, R | R1>;
} = I.dual(2, <A>(self: Effect<A, any, any>, f: (a: A) => Effect<any, any, any>) =>
  make((fib) => chain<A, unknown>(execF(self, fib), (a) => execF(f(a), fib))));
const resolveThen = (x: unknown, a: unknown, fib: I.Fiber): Step<unknown> | Failure => {
  const v = typeof x === "function" ? x(a) : x;
  return isEffect(v) ? execF(v, fib) : v;
};
type AndThenOut<X, A> = X extends (a: any) => infer B ? B : X;
type ResolveA<B> = B extends I.Effect<infer A, any, any> ? A : B;
type ResolveE<B> = B extends I.Effect<any, infer E, any> ? E : never;
type ResolveR<B> = B extends I.Effect<any, any, infer R> ? R : never;
export const andThen: {
  <A, X>(f: X | ((a: A) => X)): <E, R>(self: Effect<A, E, R>) => Effect<ResolveA<AndThenOut<X, A>>, E | ResolveE<AndThenOut<X, A>>, R | ResolveR<AndThenOut<X, A>>>;
  <A, E, R, X>(self: Effect<A, E, R>, f: X | ((a: A) => X)): Effect<ResolveA<AndThenOut<X, A>>, E | ResolveE<AndThenOut<X, A>>, R | ResolveR<AndThenOut<X, A>>>;
} = I.dual(2, (self: Effect<any, any, any>, x: unknown) => make((fib) => chain(execF(self, fib), (a) => resolveThen(x, a, fib))));
export const tap: {
  <A, X>(f: X | ((a: NoInfer<A>) => X)): <E, R>(self: Effect<A, E, R>) => Effect<A, E | ResolveE<AndThenOut<X, A>>, R | ResolveR<AndThenOut<X, A>>>;
  <A, E, R, X>(self: Effect<A, E, R>, f: X | ((a: NoInfer<A>) => X)): Effect<A, E | ResolveE<AndThenOut<X, A>>, R | ResolveR<AndThenOut<X, A>>>;
} = I.dual(2, (self: Effect<any, any, any>, x: unknown) =>
  make((fib) => chain(execF(self, fib), (a) => chain(resolveThen(x, a, fib), () => a))));
export const as: {
  <B>(value: B): <A, E, R>(self: Effect<A, E, R>) => Effect<B, E, R>;
  <A, E, R, B>(self: Effect<A, E, R>, value: B): Effect<B, E, R>;
} = I.dual(2, (self: Effect<any, any, any>, b: unknown) => make((fib) => chain(execF(self, fib), () => b)));
export const asVoid = <A, E, R>(self: Effect<A, E, R>): Effect<void, E, R> => as(self, undefined);
export const asSome = <A, E, R>(self: Effect<A, E, R>): Effect<O.Option<A>, E, R> => map(self, O.some);
export const flatten = <A, E, R, E2, R2>(self: Effect<Effect<A, E, R>, E2, R2>): Effect<A, E | E2, R | R2> => flatMap(self, (x) => x);
export const zip: {
  <B, E2, R2>(that: Effect<B, E2, R2>, options?: { readonly concurrent?: boolean }): <A, E, R>(self: Effect<A, E, R>) => Effect<[A, B], E | E2, R | R2>;
  <A, E, R, B, E2, R2>(self: Effect<A, E, R>, that: Effect<B, E2, R2>, options?: { readonly concurrent?: boolean }): Effect<[A, B], E | E2, R | R2>;
} = I.dual(isDataFirstPair, (a: Effect<any, any, any>, b: Effect<any, any, any>, o?: { concurrent?: boolean }) =>
  o?.concurrent ? all([a, b], { concurrency: 2 }) : flatMap(a, (x) => map(b, (y) => [x, y])));
export const zipWith: {
  <B, E2, R2, A, C>(that: Effect<B, E2, R2>, f: (a: A, b: B) => C, options?: { readonly concurrent?: boolean }): <E, R>(self: Effect<A, E, R>) => Effect<C, E | E2, R | R2>;
  <A, E, R, B, E2, R2, C>(self: Effect<A, E, R>, that: Effect<B, E2, R2>, f: (a: A, b: B) => C, options?: { readonly concurrent?: boolean }): Effect<C, E | E2, R | R2>;
} = I.dual(isDataFirstPair, (a: Effect<any, any, any>, b: Effect<any, any, any>, f: (a: any, b: any) => any, o?: { concurrent?: boolean }) =>
  map(zip(a, b, o), ([x, y]: [any, any]) => f(x, y)));
function isDataFirstPair(args: IArguments): boolean {
  return isEffect(args[0]) && isEffect(args[1]);
}
export const when: {
  <E2 = never, R2 = never>(condition: Effect<boolean, E2, R2> | LazyArg<boolean>): <A, E, R>(self: Effect<A, E, R>) => Effect<O.Option<A>, E | E2, R | R2>;
  <A, E, R, E2 = never, R2 = never>(self: Effect<A, E, R>, condition: Effect<boolean, E2, R2> | LazyArg<boolean>): Effect<O.Option<A>, E | E2, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, cond: Effect<boolean, any, any> | LazyArg<boolean>) =>
  make((fib) => chain(isEffect(cond) ? exec(cond, fib) : cond(), (b) => (b ? chain(exec(self, fib), O.some) : O.none()))));

// ---------- error handling ----------
type Handled = Step<any> | Failure | typeof SKIP;
/** Recover failures `handle` accepts; it returns SKIP to let the failure propagate unchanged. */
function catchWith<A>(self: Effect<A, any, any>, handle: (cause: Cause<unknown>, fib: I.Fiber) => Handled): Effect<any, any, any> {
  const recover = (e: unknown, fib: I.Fiber) => {
    const failure = I.toFailure(e);
    const r = handle(failure.cause, fib);
    return r === SKIP ? failure : r;
  };
  return make((fib) => {
    const r = execF(self, fib);
    if (r instanceof Failure) return recover(r, fib);
    if (r instanceof Async) return new Async(r.p.then(undefined, (e) => I.toThen(recover(e, fib))));
    return r;
  });
}
const SKIP: unique symbol = Symbol("skip");
const firstFail = (cause: Cause<unknown>): I.Fail<unknown> | undefined => {
  for (const r of cause.reasons) if (r._tag === "Fail") return r;
  return undefined;
};
const catchErr = (self: Effect<any, any, any>, f: (e: any, fib: I.Fiber) => Handled) =>
  catchWith(self, (cause, fib) => {
    const fl = firstFail(cause);
    return fl ? f(fl.error, fib) : SKIP;
  });
const catch_: {
  <E, A2, E2, R2>(f: (e: E) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, f: (e: E) => Effect<A2, E2, R2>): Effect<A2 | A, E2, R2 | R>;
} = I.dual(2, (self: Effect<any, any, any>, f: (e: any) => Effect<any, any, any>) => catchErr(self, (e, fib) => execF(f(e), fib)));
export { catch_ as catch };
export const catchAll = catch_;
export const catchCause: {
  <E, A2, E2, R2>(f: (cause: Cause<E>) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, f: (cause: Cause<E>) => Effect<A2, E2, R2>): Effect<A | A2, E2, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: (c: Cause<any>) => Effect<any, any, any>) => catchWith(self, (c, fib) => execF(f(c), fib)));
export const catchCauseIf: {
  <E, A2, E2, R2>(pred: (cause: Cause<E>) => boolean, f: (cause: Cause<E>) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E | E2, R2 | R>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, pred: (cause: Cause<E>) => boolean, f: (cause: Cause<E>) => Effect<A2, E2, R2>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(3, (self: Effect<any, any, any>, pred: (c: Cause<any>) => boolean, f: (c: Cause<any>) => Effect<any, any, any>) =>
  catchWith(self, (c, fib) => (pred(c) ? execF(f(c), fib) : SKIP)));
export const catchDefect: {
  <A2, E2, R2>(f: (defect: unknown) => Effect<A2, E2, R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A2 | A, E | E2, R2 | R>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, f: (defect: unknown) => Effect<A2, E2, R2>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: (d: unknown) => Effect<any, any, any>) =>
  catchWith(self, (c, fib) => {
    if (c.reasons.some((r) => r._tag === "Fail")) return SKIP;
    const d = c.reasons.find((r) => r._tag === "Die") as I.Die | undefined;
    return d ? execF(f(d.defect), fib) : SKIP;
  }));
type Tagged = { readonly _tag: string };
type TagOf<E> = E extends Tagged ? E["_tag"] : never;
export const catchTag: {
  <E, const K extends TagOf<E> | ReadonlyArray<TagOf<E>>, A2, E2, R2, A3 = never, E3 = Exclude<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>, R3 = never>(
    k: K,
    f: (e: Extract<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>) => Effect<A2, E2, R2>,
    orElse?: (e: Exclude<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>) => Effect<A3, E3, R3>,
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | A2 | A3, E2 | E3, R | R2 | R3>;
  <A, E, R, const K extends TagOf<E> | ReadonlyArray<TagOf<E>>, A2, E2, R2, A3 = never, E3 = Exclude<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>, R3 = never>(
    self: Effect<A, E, R>,
    k: K,
    f: (e: Extract<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>) => Effect<A2, E2, R2>,
    orElse?: (e: Exclude<E, { _tag: K extends ReadonlyArray<any> ? K[number] : K }>) => Effect<A3, E3, R3>,
  ): Effect<A | A2 | A3, E2 | E3, R | R2 | R3>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, k: string | ReadonlyArray<string>, f: (e: any) => Effect<any, any, any>, orElse?: (e: any) => Effect<any, any, any>) => {
  const match = typeof k === "string" ? (t: unknown) => t === k : (t: unknown) => k.includes(t as string);
  return catchErr(self, (e, fib) =>
    typeof e === "object" && e !== null && match((e as Tagged)._tag) ? execF(f(e), fib) : orElse ? execF(orElse(e), fib) : SKIP);
});
export const catchTags: {
  <E, Cases extends { [K in TagOf<E>]+?: (e: Extract<E, { _tag: K }>) => Effect<any, any, any> }>(
    cases: Cases,
  ): <A, R>(self: Effect<A, E, R>) => Effect<
    A | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<infer A2, any, any> ? A2 : never }[keyof Cases],
    Exclude<E, { _tag: keyof Cases }> | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<any, infer E2, any> ? E2 : never }[keyof Cases],
    R | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<any, any, infer R2> ? R2 : never }[keyof Cases]
  >;
  <A, E, R, Cases extends { [K in TagOf<E>]+?: (e: Extract<E, { _tag: K }>) => Effect<any, any, any> }>(
    self: Effect<A, E, R>,
    cases: Cases,
  ): Effect<
    A | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<infer A2, any, any> ? A2 : never }[keyof Cases],
    Exclude<E, { _tag: keyof Cases }> | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<any, infer E2, any> ? E2 : never }[keyof Cases],
    R | { [K in keyof Cases]: Cases[K] extends (...a: any) => Effect<any, any, infer R2> ? R2 : never }[keyof Cases]
  >;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, cases: Record<string, (e: any) => Effect<any, any, any>>, orElse?: (e: any) => Effect<any, any, any>) =>
  catchErr(self, (e, fib) => {
    const h = typeof e === "object" && e !== null ? cases[(e as Tagged)._tag] : undefined;
    return h ? execF(h(e), fib) : orElse ? execF(orElse(e), fib) : SKIP;
  }));
export const catchIf: {
  <E, A2, E2, R2>(pred: (e: NoInfer<E>) => boolean, f: (e: NoInfer<E>) => Effect<A2, E2, R2>, orElse?: (e: NoInfer<E>) => Effect<any, any, any>): <A, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, pred: (e: E) => boolean, f: (e: E) => Effect<A2, E2, R2>, orElse?: (e: E) => Effect<any, any, any>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, pred: (e: any) => boolean, f: (e: any) => Effect<any, any, any>, orElse?: (e: any) => Effect<any, any, any>) =>
  catchErr(self, (e, fib) => (pred(e) ? execF(f(e), fib) : orElse ? execF(orElse(e), fib) : SKIP)));
export const catchReason: {
  (errorTag: string, reasonTag: string, f: (reason: any, error: any) => Effect<any, any, any>, orElse?: (reason: any, error: any) => Effect<any, any, any>): <A, E, R>(self: Effect<A, E, R>) => Effect<any, any, any>;
  <A, E, R>(self: Effect<A, E, R>, errorTag: string, reasonTag: string, f: (reason: any, error: any) => Effect<any, any, any>, orElse?: (reason: any, error: any) => Effect<any, any, any>): Effect<any, any, any>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, errorTag: string, reasonTag: string, f: (r: any, e: any) => Effect<any, any, any>, orElse?: (r: any, e: any) => Effect<any, any, any>) =>
  catchErr(self, (e, fib) => {
    if (e?._tag !== errorTag) return SKIP;
    if (e.reason?._tag === reasonTag) return execF(f(e.reason, e), fib);
    return orElse ? execF(orElse(e.reason, e), fib) : SKIP;
  }));
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A, R>(self: Effect<A, E, R>) => Effect<A, E2, R>;
  <A, E, R, E2>(self: Effect<A, E, R>, f: (e: E) => E2): Effect<A, E2, R>;
} = I.dual(2, (self: Effect<any, any, any>, f: (e: any) => any) =>
  catchWith(self, (cause) => (cause.reasons.some((r) => r._tag === "Fail") ? new Failure(C.map(cause, f)) : SKIP)));
export const mapBoth: {
  <E, E2, A, A2>(o: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }): <R>(self: Effect<A, E, R>) => Effect<A2, E2, R>;
  <A, E, R, E2, A2>(self: Effect<A, E, R>, o: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }): Effect<A2, E2, R>;
} = I.dual(2, (self: Effect<any, any, any>, o: { onFailure: (e: any) => any; onSuccess: (a: any) => any }) => map(mapError(self, o.onFailure), o.onSuccess));
export const mapErrorCause = <A, E, R, E2>(self: Effect<A, E, R>, f: (c: Cause<E>) => Cause<E2>): Effect<A, E2, R> =>
  catchWith(self, (c) => new Failure(f(c as Cause<E>)));
export const flip = <A, E, R>(self: Effect<A, E, R>): Effect<E, A, R> =>
  make((fib) =>
    settle(
      () => execF(self, fib),
      (a) => I.failWith(I.causeFail(a)),
      (e) => {
        const c = I.toCause(e);
        const fl = firstFail(c);
        return fl ? (fl.error as E) : I.failWith(c);
      },
    ),
  );
export const orDie = <A, E, R>(self: Effect<A, E, R>): Effect<A, never, R> =>
  catchWith(self, (c) => {
    const fl = firstFail(c);
    return fl ? new Failure(I.causeDie(fl.error)) : SKIP;
  }) as Effect<A, never, R>;
export const orElseSucceed: {
  <E, A2>(f: (e: NoInfer<E>) => A2): <A, R>(self: Effect<A, E, R>) => Effect<A | A2, never, R>;
  <A, E, R, A2>(self: Effect<A, E, R>, f: (e: E) => A2): Effect<A | A2, never, R>;
} = I.dual(2, (self: Effect<any, any, any>, f: (e: any) => any) => catchErr(self, (e) => f(e)));
export const orElse: {
  <E, A2, E2, R2>(that: (e: E) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A | A2, E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: (e: E) => Effect<A2, E2, R2>): Effect<A | A2, E2, R | R2>;
} = catch_;
export const tapError: {
  <E, X>(f: (e: NoInfer<E>) => X): <A, R>(self: Effect<A, E, R>) => Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
  <A, E, R, X>(self: Effect<A, E, R>, f: (e: E) => X): Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
} = I.dual(2, (self: Effect<any, any, any>, f: (e: any) => any) =>
  catchWith(self, (c, fib) => {
    const fl = firstFail(c);
    return fl ? chain(resolveThen(f, fl.error, fib), () => new Failure(c)) : SKIP;
  }));
export const tapErrorTag: {
  <E, K extends TagOf<E>, X>(k: K, f: (e: Extract<E, { _tag: K }>) => X): <A, R>(self: Effect<A, E, R>) => Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
  <A, E, R, K extends TagOf<E>, X>(self: Effect<A, E, R>, k: K, f: (e: Extract<E, { _tag: K }>) => X): Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
} = I.dual(3, (self: Effect<any, any, any>, k: string, f: (e: any) => any) =>
  catchWith(self, (c, fib) => {
    const fl = firstFail(c);
    return fl && (fl.error as Tagged)?._tag === k ? chain(resolveThen(f, fl.error, fib), () => new Failure(c)) : SKIP;
  }));
export const tapCause: {
  <E, X>(f: (c: Cause<NoInfer<E>>) => X): <A, R>(self: Effect<A, E, R>) => Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
  <A, E, R, X>(self: Effect<A, E, R>, f: (c: Cause<E>) => X): Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
} = I.dual(2, (self: Effect<any, any, any>, f: (c: Cause<any>) => any) =>
  catchWith(self, (c, fib) => chain(resolveThen(f, c, fib), () => new Failure(c))));
export const tapDefect: {
  <X>(f: (d: unknown) => X): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
  <A, E, R, X>(self: Effect<A, E, R>, f: (d: unknown) => X): Effect<A, E | ResolveE<X>, R | ResolveR<X>>;
} = I.dual(2, (self: Effect<any, any, any>, f: (d: unknown) => any) =>
  catchWith(self, (c, fib) => {
    const d = c.reasons.find((r) => r._tag === "Die") as I.Die | undefined;
    return d ? chain(resolveThen(f, d.defect, fib), () => new Failure(c)) : SKIP;
  }));
type IgnoreOpts = { readonly log?: boolean | Refs.LogLevel | "Unhandled"; readonly message?: string };
export const ignore: {
  <A, E, R>(self: Effect<A, E, R>, options?: IgnoreOpts): Effect<void, never, R>;
  (options?: IgnoreOpts): <A, E, R>(self: Effect<A, E, R>) => Effect<void, never, R>;
} = function (a?: any, b?: any): any {
  if (!isEffect(a)) return (self: Effect<any, any, any>) => ignore(self, a);
  const o = b as IgnoreOpts | undefined;
  return catchWith(asVoid(a), (c, fib) => {
    if (!c.reasons.some((r) => r._tag === "Fail")) return SKIP;
    if (o?.log) Log.emit(fib, o.log === true || o.log === "Unhandled" ? "Warn" : o.log, o.message ?? "Ignored failure", c);
    return undefined;
  });
} as never;
export const ignoreCause: {
  <A, E, R>(self: Effect<A, E, R>, options?: IgnoreOpts): Effect<void, never, R>;
  (options?: IgnoreOpts): <A, E, R>(self: Effect<A, E, R>) => Effect<void, never, R>;
} = function (a?: any, b?: any): any {
  if (!isEffect(a)) return (self: Effect<any, any, any>) => ignoreCause(self, a);
  const o = b as IgnoreOpts | undefined;
  return catchWith(asVoid(a), (c, fib) => {
    if (o?.log) Log.emit(fib, o.log === true || o.log === "Unhandled" ? "Warn" : o.log, o.message ?? "Ignored cause", c);
    return undefined;
  });
} as never;
export const exit = <A, E, R>(self: Effect<A, E, R>): Effect<Exit<A, E>, never, R> =>
  make((fib) => settle(() => execF(self, fib), I.exitSucceed, (e) => I.exitFailCause(I.toCause(e)) as Exit<A, E>));
export const result = <A, E, R>(self: Effect<A, E, R>): Effect<R.Result<A, E>, never, R> =>
  make((fib) => settle(() => execF(self, fib), (a) => R.succeed(a), (e) => {
    const c = I.toCause(e);
    const fl = firstFail(c);
    return fl ? R.fail(fl.error as E) : I.failWith(c);
  }));
export const option = <A, E, R>(self: Effect<A, E, R>): Effect<O.Option<A>, never, R> =>
  make((fib) => settle(() => execF(self, fib), O.some, (e) => {
    const c = I.toCause(e);
    return firstFail(c) ? O.none() : I.failWith(c);
  }));
export const isSuccess = <A, E, R>(self: Effect<A, E, R>): Effect<boolean, never, R> => map(exit(self), (e) => e._tag === "Success");
export const isFailure = <A, E, R>(self: Effect<A, E, R>): Effect<boolean, never, R> => map(exit(self), (e) => e._tag === "Failure");
export const match: {
  <E, A2, A, A3>(o: { readonly onFailure: (e: E) => A2; readonly onSuccess: (a: A) => A3 }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>;
  <A, E, R, A2, A3>(self: Effect<A, E, R>, o: { readonly onFailure: (e: E) => A2; readonly onSuccess: (a: A) => A3 }): Effect<A2 | A3, never, R>;
} = I.dual(2, (self: Effect<any, any, any>, o: { onFailure: (e: any) => any; onSuccess: (a: any) => any }) =>
  make((fib) => settle(() => execF(self, fib), o.onSuccess, (e) => {
    const c = I.toCause(e);
    const fl = firstFail(c);
    return fl ? o.onFailure(fl.error) : new Failure(c);
  })));
export const matchEffect: {
  <E, A2, E2, R2, A, A3, E3, R3>(o: { readonly onFailure: (e: E) => Effect<A2, E2, R2>; readonly onSuccess: (a: A) => Effect<A3, E3, R3> }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, E2 | E3, R | R2 | R3>;
  <A, E, R, A2, E2, R2, A3, E3, R3>(self: Effect<A, E, R>, o: { readonly onFailure: (e: E) => Effect<A2, E2, R2>; readonly onSuccess: (a: A) => Effect<A3, E3, R3> }): Effect<A2 | A3, E2 | E3, R | R2 | R3>;
} = I.dual(2, (self: Effect<any, any, any>, o: { onFailure: (e: any) => Effect<any, any, any>; onSuccess: (a: any) => Effect<any, any, any> }) =>
  make((fib) => settle(() => execF(self, fib), (a) => execF(o.onSuccess(a), fib), (e) => {
    const c = I.toCause(e);
    const fl = firstFail(c);
    return fl ? execF(o.onFailure(fl.error), fib) : new Failure(c);
  })));
export const matchCause: {
  <E, A2, A, A3>(o: { readonly onFailure: (c: Cause<E>) => A2; readonly onSuccess: (a: A) => A3 }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>;
  <A, E, R, A2, A3>(self: Effect<A, E, R>, o: { readonly onFailure: (c: Cause<E>) => A2; readonly onSuccess: (a: A) => A3 }): Effect<A2 | A3, never, R>;
} = I.dual(2, (self: Effect<any, any, any>, o: { onFailure: (c: any) => any; onSuccess: (a: any) => any }) =>
  make((fib) => settle(() => execF(self, fib), o.onSuccess, (e) => o.onFailure(I.toCause(e)))));
export const matchCauseEffect: {
  <E, A2, E2, R2, A, A3, E3, R3>(o: { readonly onFailure: (c: Cause<E>) => Effect<A2, E2, R2>; readonly onSuccess: (a: A) => Effect<A3, E3, R3> }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, E2 | E3, R | R2 | R3>;
  <A, E, R, A2, E2, R2, A3, E3, R3>(self: Effect<A, E, R>, o: { readonly onFailure: (c: Cause<E>) => Effect<A2, E2, R2>; readonly onSuccess: (a: A) => Effect<A3, E3, R3> }): Effect<A2 | A3, E2 | E3, R | R2 | R3>;
} = I.dual(2, (self: Effect<any, any, any>, o: { onFailure: (c: any) => Effect<any, any, any>; onSuccess: (a: any) => Effect<any, any, any> }) =>
  make((fib) => settle(() => execF(self, fib), (a) => execF(o.onSuccess(a), fib), (e) => execF(o.onFailure(I.toCause(e)), fib))));
export const filterOrFail: {
  <A, B extends A, E2>(refinement: (a: NoInfer<A>) => a is B, orFailWith: (a: NoInfer<A>) => E2): <E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R>;
  <A, E2>(pred: (a: NoInfer<A>) => boolean, orFailWith: (a: NoInfer<A>) => E2): <E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R>;
  <A, B extends A>(refinement: (a: NoInfer<A>) => a is B): <E, R>(self: Effect<A, E, R>) => Effect<B, E | NoSuchElementError, R>;
  <A>(pred: (a: NoInfer<A>) => boolean): <E, R>(self: Effect<A, E, R>) => Effect<A, E | NoSuchElementError, R>;
  <A, E, R, B extends A, E2>(self: Effect<A, E, R>, refinement: (a: NoInfer<A>) => a is B, orFailWith: (a: NoInfer<A>) => E2): Effect<B, E | E2, R>;
  <A, E, R, E2>(self: Effect<A, E, R>, pred: (a: NoInfer<A>) => boolean, orFailWith: (a: NoInfer<A>) => E2): Effect<A, E | E2, R>;
  <A, E, R>(self: Effect<A, E, R>, pred: (a: NoInfer<A>) => boolean): Effect<A, E | NoSuchElementError, R>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, pred: (a: any) => boolean, orFail?: (a: any) => any) =>
  map(self, (a) => (pred(a) ? a : I.failWith(I.causeFail(orFail ? orFail(a) : new NoSuchElementError())))));
export const filterOrElse: {
  <A, A2, E2, R2>(pred: (a: NoInfer<A>) => boolean, orElse: (a: NoInfer<A>) => Effect<A2, E2, R2>): <E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, pred: (a: NoInfer<A>) => boolean, orElse: (a: NoInfer<A>) => Effect<A2, E2, R2>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(3, (self: Effect<any, any, any>, pred: (a: any) => boolean, orElse: (a: any) => Effect<any, any, any>) =>
  make((fib) => chain(exec(self, fib), (a) => (pred(a) ? a : exec(orElse(a), fib)))));
export const filterMapOrFail: {
  <A, B, E2>(f: (a: A) => O.Option<B>, orFailWith: (a: A) => E2): <E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R>;
  <A, E, R, B, E2>(self: Effect<A, E, R>, f: (a: A) => O.Option<B>, orFailWith: (a: A) => E2): Effect<B, E | E2, R>;
} = I.dual(3, (self: Effect<any, any, any>, f: (a: any) => O.Option<any>, orFail: (a: any) => any) =>
  map(self, (a) => {
    const o = f(a);
    return o._tag === "Some" ? o.value : I.failWith(I.causeFail(orFail(a)));
  }));
export const fromResult = <A, E>(r: R.Result<A, E>): Effect<A, E> =>
  make(() => (r._tag === "Success" ? r.success : I.failWith(I.causeFail(r.failure))));
/** `fromOption(option, onNone?)` or data-last `fromOption(onNone)(option)`. */
export const fromOption: {
  <A>(option: O.Option<A>): Effect<A, NoSuchElementError>;
  <A, E>(option: O.Option<A>, onNone: LazyArg<E>): Effect<A, E>;
  <E>(onNone: LazyArg<E>): <A>(option: O.Option<A>) => Effect<A, E>;
} = function (a: any, onNone?: LazyArg<unknown>): any {
  if (typeof a === "function") return (o: O.Option<unknown>) => fromOption(o, a);
  return make(() => (a._tag === "Some" ? a.value : I.failWith(I.causeFail(onNone ? onNone() : new NoSuchElementError()))));
} as never;
export const fromNullishOr = <A>(a: A): Effect<NonNullable<A>, NoSuchElementError> =>
  make(() => (a == null ? I.failWith(I.causeFail(new NoSuchElementError())) : (a as NonNullable<A>)));
export const fromExit = <A, E>(e: Exit<A, E>): Effect<A, E> => e;

// ---------- resource safety ----------
export const ensuring: {
  <X, R1>(finalizer: Effect<X, never, R1>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R | R1>;
  <A, E, R, X, R1>(self: Effect<A, E, R>, finalizer: Effect<X, never, R1>): Effect<A, E, R | R1>;
} = I.dual(2, (self: Effect<any, any, any>, fin: Effect<any, any, any>) =>
  make((fib) =>
    settle(
      () => exec(self, fib),
      (a) => chain(runMasked(fin, fib), () => a),
      (e) => chain(runMasked(fin, fib), () => rethrow(e)),
    ),
  ));
export const onExit: {
  <A, E, X, R2>(f: (exit: Exit<A, E>) => Effect<X, never, R2>): <R>(self: Effect<A, E, R>) => Effect<A, E, R | R2>;
  <A, E, R, X, R2>(self: Effect<A, E, R>, f: (exit: Exit<A, E>) => Effect<X, never, R2>): Effect<A, E, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: (exit: Exit<any, any>) => Effect<any, any, any>) =>
  make((fib) =>
    settle(
      () => exec(self, fib),
      (a) => chain(runMasked(f(I.exitSucceed(a)), fib), () => a),
      (e) => chain(runMasked(f(I.exitFailCause(I.toCause(e))), fib), () => rethrow(e)),
    ),
  ));
export const onError: {
  <E, X, R2>(f: (cause: Cause<E>) => Effect<X, never, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R | R2>;
  <A, E, R, X, R2>(self: Effect<A, E, R>, f: (cause: Cause<E>) => Effect<X, never, R2>): Effect<A, E, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: (c: Cause<any>) => Effect<any, any, any>) =>
  onExit(self, (e) => (e._tag === "Failure" ? f(e.cause) : void_) as Effect<unknown, never, any>));
export const onInterrupt: {
  <X, R2>(f: (interruptors: ReadonlySet<number>) => Effect<X, never, R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R | R2>;
  <A, E, R, X, R2>(self: Effect<A, E, R>, f: (interruptors: ReadonlySet<number>) => Effect<X, never, R2>): Effect<A, E, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: Effect<any, any, any> | ((s: ReadonlySet<number>) => Effect<any, any, any>)) =>
  onExit(self, (e) =>
    (e._tag === "Failure" && C.hasInterrupts(e.cause) ? (isEffect(f) ? f : (f as (s: ReadonlySet<number>) => Effect<any, any, any>)(C.filterInterruptors(e.cause))) : void_) as Effect<unknown, never, any>));
const currentScope = (fib: I.Fiber): ScopeM.ScopeImpl => {
  const s = fib.context.map.get(ScopeM.Scope.key);
  if (!s) I.serviceNotFound(ScopeM.Scope.key);
  return s as ScopeM.ScopeImpl;
};
export const scope: Effect<ScopeM.Scope, never, ScopeM.Scope> = make((fib) => currentScope(fib));
export const addFinalizer = <R>(finalizer: (exit: Exit<unknown, unknown>) => Effect<unknown, never, R>): Effect<void, never, R | ScopeM.Scope> =>
  make((fib) => {
    const ctx = fib.context;
    const r = currentScope(fib).add((exit) => provideContext(finalizer(exit), ctx));
    return typeof r === "function" ? undefined : chain(runMasked(r, fib), () => undefined);
  });
export const acquireRelease = <A, E, R, X, R2>(
  acquire: Effect<A, E, R>,
  release: (a: A, exit: Exit<unknown, unknown>) => Effect<X, never, R2>,
): Effect<A, E, R | R2 | ScopeM.Scope> =>
  make((fib) => {
    const sc = currentScope(fib);
    const ctx = fib.context;
    return chain(runMasked(acquire, fib), (a) => {
      const r = sc.add((exit) => provideContext(release(a, exit), ctx));
      return typeof r === "function" ? a : chain(runMasked(r, fib), () => a);
    });
  });
export const acquireUseRelease = <A, E, R, A2, E2, R2, X, R3>(
  acquire: Effect<A, E, R>,
  use: (a: A) => Effect<A2, E2, R2>,
  release: (a: A, exit: Exit<A2, E2>) => Effect<X, never, R3>,
): Effect<A2, E | E2, R | R2 | R3> =>
  make((fib) =>
    chain(runMasked(acquire, fib), (a) =>
      settle(
        () => exec(use(a), fib),
        (b) => chain(runMasked(release(a, I.exitSucceed(b)), fib), () => b),
        (e) => chain(runMasked(release(a, I.exitFailCause(I.toCause(e)) as Exit<A2, E2>), fib), () => rethrow(e)),
      ),
    ),
  );
export const scoped = <A, E, R>(self: Effect<A, E, R>): Effect<A, E, Exclude<R, ScopeM.Scope>> =>
  make((fib) => exec(ScopeM.useScope(new ScopeM.ScopeImpl(), self), fib));
export const scopedWith = <A, E, R>(f: (scope: ScopeM.Scope) => Effect<A, E, R>): Effect<A, E, R> =>
  make((fib) => {
    const s = new ScopeM.ScopeImpl();
    return exec(ScopeM.useScope(s, f(s)), fib);
  });

// ---------- interruption ----------
export const uninterruptible = <A, E, R>(self: Effect<A, E, R>): Effect<A, E, R> =>
  make((fib) => {
    fib.uninterruptible++;
    return settle(
      () => exec(self, fib),
      (a) => {
        fib.uninterruptible--;
        if (fib.interrupted && fib.uninterruptible === 0) I.failWith(I.causeInterrupt(fib.interruptor));
        return a;
      },
      (e) => (fib.uninterruptible--, rethrow(e)),
    );
  });
export const interruptible = <A, E, R>(self: Effect<A, E, R>): Effect<A, E, R> =>
  make((fib) => {
    const saved = fib.uninterruptible;
    fib.uninterruptible = 0;
    return settle(
      () => exec(self, fib),
      (a) => ((fib.uninterruptible = saved), a),
      (e) => ((fib.uninterruptible = saved), rethrow(e)),
    );
  });
export const uninterruptibleMask = <A, E, R>(
  f: (restore: <AX, EX, RX>(effect: Effect<AX, EX, RX>) => Effect<AX, EX, RX>) => Effect<A, E, R>,
): Effect<A, E, R> =>
  make((fib) => {
    const outer = fib.uninterruptible;
    const restore = <AX, EX, RX>(eff: Effect<AX, EX, RX>): Effect<AX, EX, RX> =>
      make((fib2) => {
        const saved = fib2.uninterruptible;
        fib2.uninterruptible = outer;
        return settle(
          () => exec(eff, fib2),
          (a) => ((fib2.uninterruptible = saved), a),
          (e) => ((fib2.uninterruptible = saved), rethrow(e)),
        );
      });
    return exec(uninterruptible(f(restore)), fib);
  });
export const abortSignal: Effect<AbortSignal> = make((fib) => {
  const ctl = new AbortController();
  if (fib.interrupted) ctl.abort();
  else fib.onInterrupt(() => ctl.abort());
  return ctl.signal;
});

// ---------- fibers ----------
type ForkOpts = { readonly startImmediately?: boolean; readonly uninterruptible?: boolean | "inherit" };
const forkWith = (self: Effect<any, any, any>, fib: I.Fiber, parent: I.Fiber | undefined, o?: ForkOpts) =>
  I.runFiber(self, fib.context, parent, { inheritFrom: fib, uninterruptible: o?.uninterruptible === true || (o?.uninterruptible === "inherit" && fib.uninterruptible > 0) });
const forkCombinator = (pick: (fib: I.Fiber) => I.Fiber | undefined) =>
  function (a?: any, b?: any): any {
    if (!isEffect(a)) return (self: Effect<any, any, any>) => make((fib) => forkWith(self, fib, pick(fib), a));
    return make((fib) => forkWith(a, fib, pick(fib), b));
  };
type ForkFn = {
  <A, E, R>(self: Effect<A, E, R>, options?: ForkOpts): Effect<Fiber<A, E>, never, R>;
  (options?: ForkOpts): <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>;
};
export const forkChild: ForkFn = forkCombinator((fib) => fib) as never;
export const fork = forkChild;
export const forkDetach: ForkFn = forkCombinator(() => undefined) as never;
export const forkDaemon = forkDetach;
export const forkIn: {
  (scope: ScopeM.Scope, options?: ForkOpts): <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>;
  <A, E, R>(self: Effect<A, E, R>, scope: ScopeM.Scope, options?: ForkOpts): Effect<Fiber<A, E>, never, R>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, sc: ScopeM.Scope, o?: ForkOpts) =>
  make((fib) => {
    const child = forkWith(self, fib, undefined, o);
    const un = (sc as ScopeM.ScopeImpl).add(() => make((f2) => (child.interruptAsFork(f2.id), I.chain(child.awaitStep(undefined), () => undefined))));
    if (typeof un === "function") child.addObserver(un);
    else child.interruptAsFork(fib.id);
    return child;
  }));
export const forkScoped: {
  <A, E, R>(self: Effect<A, E, R>, options?: ForkOpts): Effect<Fiber<A, E>, never, R | ScopeM.Scope>;
  (options?: ForkOpts): <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R | ScopeM.Scope>;
} = function (a?: any, b?: any): any {
  if (!isEffect(a)) return (self: Effect<any, any, any>) => forkScoped(self, a);
  return make((fib) => exec(forkIn(a, currentScope(fib), b), fib));
} as never;

/** Run `effects` as child fibers with at most `limit` running; fail fast. Returns sync when every child finished sync. */
function runConcurrent(effects: ReadonlyArray<Effect<any, any, any>>, limit: number, fib: I.Fiber, discard: boolean, mode: "default" | "result"): Step<Array<any> | void> {
  const n = effects.length;
  const out: Array<any> = discard ? [] : new Array(n);
  if (n === 0) return discard ? undefined : out;
  let next = 0, active = 0, finished = 0;
  let failure: Cause<unknown> | undefined;
  let resolveP: ((v: unknown) => void) | undefined, rejectP: ((e: unknown) => void) | undefined;
  let settled = false, syncResult: { ok: boolean; v: unknown } | undefined;
  const running = new Set<I.Fiber>();
  let launching = false, relaunch = false;
  const finish = (ok: boolean, v: unknown) => {
    if (settled) return;
    settled = true;
    unInt();
    if (resolveP) ok ? resolveP(I.box(v)) : rejectP!(v);
    else syncResult = { ok, v };
  };
  const checkDone = () => {
    if (failure) {
      if (running.size === 0) finish(false, new Failure(failure));
    } else if (finished === n) finish(true, discard ? undefined : out);
    else launch();
  };
  const launch = () => {
    if (launching) return void (relaunch = true);
    launching = true;
    do {
      relaunch = false;
      while (!failure && active < limit && next < n) {
        const i = next++;
        active++;
        const child = I.runFiber(effects[i]!, fib.context, fib);
        if (child.exit && mode === "default" && child.exit._tag === "Success") {
          active--;
          finished++;
          if (!discard) out[i] = child.exit.value;
          if (finished === n) checkDone();
          continue;
        }
        running.add(child);
        child.addObserver((exit) => {
          running.delete(child);
          active--;
          finished++;
          if (mode === "result") {
            if (!discard) out[i] = exit._tag === "Success" ? R.succeed(exit.value) : resultOfCause(exit.cause);
            if (exit._tag === "Failure" && !firstFail(exit.cause) && !failure) failInternal(exit.cause);
          } else if (exit._tag === "Failure") {
            if (!failure) failInternal(exit.cause);
          } else if (!discard) out[i] = exit.value;
          checkDone();
        });
      }
    } while (relaunch);
    launching = false;
  };
  const failInternal = (cause: Cause<unknown>) => {
    failure = cause;
    for (const c of running) c.interruptAsFork(fib.id);
  };
  const unInt = fib.onInterrupt(() => {
    if (!failure) failInternal(I.causeInterrupt(fib.interruptor));
    else for (const c of running) c.interruptAsFork(fib.id);
    checkDone();
  });
  launch();
  if (syncResult) {
    if (syncResult.ok) return syncResult.v as Array<any>;
    throw syncResult.v;
  }
  return new Async(
    new Promise((res, rej) => {
      resolveP = res as (v: unknown) => void;
      rejectP = rej;
    }),
  ) as Async<Array<any>>;
}
const resultOfCause = (c: Cause<unknown>) => {
  const fl = firstFail(c);
  return fl ? R.fail(fl.error) : R.fail(C.squash(c));
};
type Concurrency = number | "unbounded" | "inherit";
const limitOf = (c: Concurrency | undefined): number => (c === undefined ? 1 : c === "unbounded" || c === "inherit" ? Infinity : Math.max(1, c));
function runSequential(effects: ReadonlyArray<Effect<any, any, any>>, fib: I.Fiber, discard: boolean, mode: "default" | "result"): Step<Array<any> | void> {
  const out: Array<any> = [];
  let i = 0;
  const loop = (): Step<Array<any> | void> => {
    while (i < effects.length) {
      const eff = mode === "result" ? result(effects[i++]!) : effects[i++]!;
      const r = exec(eff, fib);
      if (r instanceof Async) return chain(r, (v) => (discard || out.push(v), loop()));
      if (!discard) out.push(r);
    }
    return discard ? undefined : out;
  };
  return loop();
}
type AllInput = Iterable<Effect<any, any, any>> | Record<string, Effect<any, any, any>>;
type AllOpts = { readonly concurrency?: Concurrency; readonly discard?: boolean; readonly mode?: "default" | "result" };
type AllA<T, O> = O extends { discard: true } ? void
  : T extends ReadonlyArray<any> ? { -readonly [K in keyof T]: O extends { mode: "result" } ? R.Result<Success<T[K]>, Error<T[K]>> : Success<T[K]> }
  : T extends Iterable<infer X> ? Array<O extends { mode: "result" } ? R.Result<Success<X>, Error<X>> : Success<X>>
  : { -readonly [K in keyof T]: O extends { mode: "result" } ? R.Result<Success<T[K]>, Error<T[K]>> : Success<T[K]> };
type AllE<T, O> = O extends { mode: "result" } ? never : T extends Iterable<infer X> ? Error<X> : { [K in keyof T]: Error<T[K]> }[keyof T];
type AllR<T> = T extends Iterable<infer X> ? Services<X> : { [K in keyof T]: Services<T[K]> }[keyof T];
export const all = <const T extends AllInput, O extends AllOpts = {}>(input: T, options?: O): Effect<AllA<T, O>, AllE<T, O>, AllR<T>> =>
  make((fib) => {
    const discard = options?.discard === true;
    const mode = options?.mode ?? "default";
    const limit = limitOf(options?.concurrency);
    if (Symbol.iterator in input) {
      const effs = Array.isArray(input) ? input : [...(input as Iterable<Effect<any, any, any>>)];
      return (limit === 1 ? runSequential(effs, fib, discard, mode) : runConcurrent(effs, limit, fib, discard, mode)) as never;
    }
    const keys = Object.keys(input);
    const effs = keys.map((k) => (input as Record<string, Effect<any, any, any>>)[k]!);
    const r = limit === 1 ? runSequential(effs, fib, discard, mode) : runConcurrent(effs, limit, fib, discard, mode);
    if (discard) return r as never;
    return chain(r, (arr) => {
      const o: Record<string, unknown> = {};
      keys.forEach((k, i) => (o[k] = (arr as Array<unknown>)[i]));
      return o;
    }) as never;
  });
export const forEach: {
  <B, E, R, S extends Iterable<any>>(f: (a: S extends Iterable<infer A> ? A : never, i: number) => Effect<B, E, R>, options?: { readonly concurrency?: Concurrency; readonly discard?: false }): (self: S) => Effect<Array<B>, E, R>;
  <B, E, R, S extends Iterable<any>>(f: (a: S extends Iterable<infer A> ? A : never, i: number) => Effect<B, E, R>, options: { readonly concurrency?: Concurrency; readonly discard: true }): (self: S) => Effect<void, E, R>;
  <A, B, E, R>(self: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options?: { readonly concurrency?: Concurrency; readonly discard?: false }): Effect<Array<B>, E, R>;
  <A, B, E, R>(self: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options: { readonly concurrency?: Concurrency; readonly discard: true }): Effect<void, E, R>;
} = I.dual((args) => typeof args[0] !== "function", (self: Iterable<any>, f: (a: any, i: number) => Effect<any, any, any>, o?: AllOpts) =>
  make((fib) => {
    const limit = limitOf(o?.concurrency);
    const discard = o?.discard === true;
    if (limit === 1) {
      const out: Array<any> = [];
      const it = self[Symbol.iterator]();
      let i = 0;
      const loop = (): Step<any> => {
        for (let s = it.next(); !s.done; s = it.next()) {
          const r = exec(f(s.value, i++), fib);
          if (r instanceof Async) return chain(r, (v) => (discard || out.push(v), loop()));
          if (!discard) out.push(r);
        }
        return discard ? undefined : out;
      };
      return loop();
    }
    return runConcurrent(Array.from(self, (a, i) => f(a, i)), limit, fib, discard, "default");
  }));
export const filter: {
  <A, E, R>(pred: (a: A, i: number) => Effect<boolean, E, R>, options?: { readonly concurrency?: Concurrency }): (self: Iterable<A>) => Effect<Array<A>, E, R>;
  <A, E, R>(self: Iterable<A>, pred: (a: A, i: number) => Effect<boolean, E, R>, options?: { readonly concurrency?: Concurrency }): Effect<Array<A>, E, R>;
} = I.dual((args) => typeof args[0] !== "function", (self: Iterable<any>, pred: (a: any, i: number) => Effect<boolean, any, any>, o?: AllOpts) => {
  const arr = Array.from(self);
  return map(forEach(arr, pred, o as never), (bs: Array<boolean>) => arr.filter((_, i) => bs[i]));
});
export const partition: {
  <A, B, E, R>(f: (a: A, i: number) => Effect<B, E, R>, options?: { readonly concurrency?: Concurrency }): (self: Iterable<A>) => Effect<[excluded: Array<E>, satisfying: Array<B>], never, R>;
  <A, B, E, R>(self: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options?: { readonly concurrency?: Concurrency }): Effect<[excluded: Array<E>, satisfying: Array<B>], never, R>;
} = I.dual((args) => typeof args[0] !== "function", (self: Iterable<any>, f: (a: any, i: number) => Effect<any, any, any>, o?: AllOpts) =>
  map(forEach(self, (a, i) => result(f(a, i)), o as never), (rs: Array<R.Result<any, any>>) => {
    const l: Array<any> = [], r: Array<any> = [];
    for (const x of rs) x._tag === "Success" ? r.push(x.success) : l.push(x.failure);
    return [l, r];
  }));
export const findFirst: {
  <A, E, R>(pred: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>): (self: Iterable<A>) => Effect<O.Option<A>, E, R>;
  <A, E, R>(self: Iterable<A>, pred: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>): Effect<O.Option<A>, E, R>;
} = I.dual(2, (self: Iterable<any>, pred: (a: any, i: number) => Effect<boolean, any, any>) =>
  make((fib) => {
    const it = self[Symbol.iterator]();
    let i = 0;
    const loop = (): Step<O.Option<any>> => {
      for (let s = it.next(); !s.done; s = it.next()) {
        const v = s.value;
        const r = exec(pred(v, i++), fib);
        if (r instanceof Async) return chain(r, (b) => (b ? O.some(v) : loop()));
        if (r) return O.some(v);
      }
      return O.none();
    };
    return loop();
  }));
export const firstSuccessOf = <Eff extends Effect<any, any, any>>(effects: Iterable<Eff>): Effect<Success<Eff>, Error<Eff>, Services<Eff>> =>
  suspend(() => {
    const arr = [...effects];
    if (arr.length === 0) return dieMessage("firstSuccessOf: empty");
    return arr.slice(1).reduce<Effect<any, any, any>>((acc, e) => catch_(acc, () => e), arr[0]!) as never;
  });

// ---------- time ----------
export const sleep = (duration: D.Input): Effect<void> => sleepMillis(D.toMillis(duration));
export const delay: {
  (duration: D.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, duration: D.Input): Effect<A, E, R>;
} = I.dual(2, (self: Effect<any, any, any>, d: D.Input) => andThen(sleep(d), self));
export const timed = <A, E, R>(self: Effect<A, E, R>): Effect<[duration: D.Duration, result: A], E, R> =>
  make((fib) => {
    const start = performance.now();
    return chain(exec(self, fib), (a) => [D.millis(performance.now() - start), a] as [D.Duration, A]);
  });

/** Race `self` (as a child fiber) against a timer; `onTimeout` decides the result. */
function withTimer<A>(self: Effect<A, any, any>, ms: number, onTimeout: (fib: I.Fiber) => Step<any>): Effect<any, any, any> {
  return make((fib) => {
    if (!Number.isFinite(ms)) return exec(self, fib);
    const child = I.runFiber(self, fib.context, fib, fiberRunOpts(fib));
    if (child.exit) return exec(child.exit, fib);
    const clock = I.lookup(fib.context, Clock.key) as import("./Clock.ts").Clock;
    const timer = I.runFiber(make((f2) => clock.sleepStep(ms, f2)), fib.context, fib);
    return new Async(
      new Promise<unknown>((resolve, reject) => {
        let done = false;
        const unInt = fib.onInterrupt(() => {
          done = true;
          timer.interruptAsFork(fib.id);
          child.interruptAsFork(fib.id);
          child.addObserver(() => reject(new Failure(I.causeInterrupt(fib.interruptor))));
        });
        child.addObserver((exit) => {
          if (done) return;
          done = true;
          unInt();
          timer.interruptAsFork(fib.id);
          resolve(I.toThen(settle(() => execF(exit, fib), (a) => a, rethrow)));
        });
        timer.addObserver((exit) => {
          if (done || exit._tag === "Failure") return;
          done = true;
          unInt();
          child.interruptAsFork(fib.id);
          child.addObserver(() => {
            try {
              resolve(I.toThen(onTimeout(fib)));
            } catch (e) {
              reject(e);
            }
          });
        });
      }),
    );
  });
}
export const timeout: {
  (duration: D.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | TimeoutError, R>;
  <A, E, R>(self: Effect<A, E, R>, duration: D.Input): Effect<A, E | TimeoutError, R>;
} = I.dual(2, (self: Effect<any, any, any>, d: D.Input) => withTimer(self, D.toMillis(d), () => I.failWith(I.causeFail(new TimeoutError()))));
export const timeoutOption: {
  (duration: D.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<O.Option<A>, E, R>;
  <A, E, R>(self: Effect<A, E, R>, duration: D.Input): Effect<O.Option<A>, E, R>;
} = I.dual(2, (self: Effect<any, any, any>, d: D.Input) => withTimer(map(self, O.some), D.toMillis(d), () => O.none()));
export const timeoutOrElse: {
  <A2, E2, R2>(o: { readonly duration: D.Input; readonly orElse: LazyArg<Effect<A2, E2, R2>> }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, o: { readonly duration: D.Input; readonly orElse: LazyArg<Effect<A2, E2, R2>> }): Effect<A | A2, E | E2, R | R2>;
} = I.dual(2, (self: Effect<any, any, any>, o: { duration: D.Input; orElse: LazyArg<Effect<any, any, any>> }) =>
  withTimer(self, D.toMillis(o.duration), (fib) => exec(o.orElse(), fib)));

/** Race effects as children; `pick` decides when an exit wins. Losers are interrupted and awaited. */
function raceImpl(effects: ReadonlyArray<Effect<any, any, any>>, firstExitWins: boolean): Effect<any, any, any> {
  return make((fib) => {
    if (effects.length === 0) return I.failWith(I.causeDie(new Error("race: no effects")));
    const kids: Array<I.Fiber> = [];
    return new Async(
      new Promise<unknown>((resolve, reject) => {
        let winner: I.Exit<any, any> | undefined;
        let failures: Array<I.Reason<unknown>> = [];
        let remaining = effects.length;
        const settleAll = () => {
          let pending = 0;
          const done = () => {
            if (--pending > 0) return;
            if (winner!._tag === "Success") resolve(I.box(winner!.value));
            else reject(new Failure(winner!.cause));
          };
          pending++;
          for (const k of kids) if (!k.exit) {
            pending++;
            k.interruptAsFork(fib.id);
            k.addObserver(done);
          }
          done();
        };
        const unInt = fib.onInterrupt(() => {
          if (winner) return;
          winner = I.exitFailCause(I.causeInterrupt(fib.interruptor));
          settleAll();
        });
        for (const eff of effects) {
          if (winner) break;
          const k = I.runFiber(eff, fib.context, fib, fiberRunOpts(fib));
          kids.push(k);
          k.addObserver((exit) => {
            remaining--;
            if (winner) return;
            if (exit._tag === "Success" || firstExitWins) {
              winner = exit;
            } else {
              failures = failures.concat(exit.cause.reasons);
              if (remaining > 0) return;
              winner = I.exitFailCause(I.makeCause(failures));
            }
            unInt();
            settleAll();
          });
        }
      }),
    );
  });
}
export const race: {
  <A2, E2, R2>(that: Effect<A2, E2, R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(2, (a: Effect<any, any, any>, b: Effect<any, any, any>) => raceImpl([a, b], false));
export const raceFirst: {
  <A2, E2, R2>(that: Effect<A2, E2, R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>): Effect<A | A2, E | E2, R | R2>;
} = I.dual(2, (a: Effect<any, any, any>, b: Effect<any, any, any>) => raceImpl([a, b], true));
export const raceAll = <Eff extends Effect<any, any, any>>(effects: Iterable<Eff>): Effect<Success<Eff>, Error<Eff>, Services<Eff>> => raceImpl([...effects], false);
export const raceAllFirst = <Eff extends Effect<any, any, any>>(effects: Iterable<Eff>): Effect<Success<Eff>, Error<Eff>, Services<Eff>> => raceImpl([...effects], true);

// ---------- repetition ----------
type RetryOptions<E> = {
  readonly while?: (e: E) => boolean | Effect<boolean, any, any>;
  readonly until?: (e: E) => boolean | Effect<boolean, any, any>;
  readonly times?: number;
  readonly schedule?: Sched.Schedule<any, E, any, any>;
};
const testPred = (p: ((x: any) => boolean | Effect<boolean, any, any>) | undefined, x: unknown, fib: I.Fiber, dflt: boolean): Step<boolean> => {
  if (!p) return dflt;
  const r = p(x);
  return typeof r === "boolean" ? r : exec(r, fib);
};
const scheduleOf = (x: Sched.Schedule<any, any, any, any> | RetryOptions<any> | ((s: any) => Sched.Schedule<any, any, any, any>)) =>
  typeof x === "function" ? x((s: unknown) => s) : Sched.isSchedule(x) ? x : x.schedule;
export const retry: {
  <E, O extends RetryOptions<E>>(options: O): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <B, E, Error, Env>(policy: Sched.Schedule<B, NoInfer<E>, Error, Env> | (($: <O, SE, R>(_: Sched.Schedule<O, NoInfer<E>, SE, R>) => Sched.Schedule<O, E, SE, R>) => Sched.Schedule<B, NoInfer<E>, Error, Env>)): <A, R>(self: Effect<A, E, R>) => Effect<A, E | Error, R | Env>;
  <A, E, R, O extends RetryOptions<E>>(self: Effect<A, E, R>, options: O): Effect<A, E, R>;
  <A, E, R, B, Error, Env>(self: Effect<A, E, R>, policy: Sched.Schedule<B, NoInfer<E>, Error, Env>): Effect<A, E | Error, R | Env>;
} = I.dual(2, (self: Effect<any, any, any>, x: any) =>
  make((fib) => {
    const sched = scheduleOf(x);
    const opts: RetryOptions<any> = Sched.isSchedule(x) || typeof x === "function" ? {} : x;
    const step = sched?.start();
    let attempts = 0;
    const loop = (): Step<any> =>
      settle(() => execF(self, fib), (a) => a, (e) => {
        const c = I.toCause(e);
        const fl = firstFail(c);
        if (!fl) return I.failWith(c);
        if (opts.times !== undefined && attempts >= opts.times) return I.failWith(c);
        attempts++;
        return chain(testPred(opts.while, fl.error, fib, true), (w) => {
          if (!w) return I.failWith(c);
          return chain(testPred(opts.until, fl.error, fib, false), (u) => {
            if (u) return I.failWith(c);
            if (!step) return loop();
            return chain(Sched.stepAndSleep(step, fl.error, fib, sleepMillis), (m) => (m ? loop() : I.failWith(c)));
          });
        });
      });
    return loop();
  }));
export const repeat: {
  <A, O extends RetryOptions<A>>(options: O): <E, R>(self: Effect<A, E, R>) => Effect<O extends { schedule: Sched.Schedule<infer Out, any, any, any> } ? Out : A, E, R>;
  <Output, Input, Error, Env>(schedule: Sched.Schedule<Output, NoInfer<Input>, Error, Env> | (($: <O, E, R>(_: Sched.Schedule<O, NoInfer<Input>, E, R>) => Sched.Schedule<O, Input, E, R>) => Sched.Schedule<Output, NoInfer<Input>, Error, Env>)): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>;
  <A, E, R, O extends RetryOptions<A>>(self: Effect<A, E, R>, options: O): Effect<O extends { schedule: Sched.Schedule<infer Out, any, any, any> } ? Out : A, E, R>;
  <Input, E, R, Output, Error, Env>(self: Effect<Input, E, R>, schedule: Sched.Schedule<Output, NoInfer<Input>, Error, Env>): Effect<Output, E | Error, R | Env>;
} = I.dual(2, (self: Effect<any, any, any>, x: any) =>
  make((fib) => {
    const sched = scheduleOf(x);
    const opts: RetryOptions<any> = Sched.isSchedule(x) || typeof x === "function" ? {} : x;
    const step = sched?.start();
    let count = 0;
    let lastOut: unknown;
    const loop = (): Step<any> =>
      chain(exec(self, fib), (a) => {
        if (opts.times !== undefined && count >= opts.times) return step ? lastOut : a;
        count++;
        return chain(testPred(opts.while, a, fib, true), (w) => {
          if (!w) return step ? lastOut : a;
          return chain(testPred(opts.until, a, fib, false), (u) => {
            if (u) return step ? lastOut : a;
            if (!step) return opts.times === undefined && !opts.while && !opts.until ? a : loop();
            return chain(Sched.stepAndSleep(step, a, fib, sleepMillis), (m) => {
              if (!m) return lastOut === undefined && !sched ? a : lastOut ?? m;
              lastOut = m.output;
              return loop();
            });
          });
        });
      });
    return loop();
  }));
export const forever = <A, E, R>(self: Effect<A, E, R>): Effect<never, E, R> =>
  make((fib) => {
    let n = 0;
    const loop = (): Step<never> => {
      for (;;) {
        const r = exec(self, fib);
        if (r instanceof Async) return chain(r, loop);
        if (++n % 2048 === 0) return chain(exec(yieldNow, fib), loop);
      }
    };
    return loop();
  });

// ---------- context ----------
const withContext = <A>(fib: I.Fiber, ctx: I.Context<any>, run: () => Step<A>): Step<A> => {
  const prev = fib.context;
  fib.context = ctx;
  return settle(run, (a) => ((fib.context = prev), a), (e) => ((fib.context = prev), rethrow(e)));
};
export const context = <R = never>(): Effect<I.Context<R>, never, R> => make((fib) => fib.context);
export const contextWith = <R, A>(f: (ctx: I.Context<R>) => A): Effect<A, never, R> => make((fib) => f(fib.context));
export const provideContext: {
  <R2>(ctx: I.Context<R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, R2>>;
  <A, E, R, R2>(self: Effect<A, E, R>, ctx: I.Context<R2>): Effect<A, E, Exclude<R, R2>>;
} = I.dual(2, (self: Effect<any, any, any>, ctx: I.Context<any>) =>
  make((fib) => withContext(fib, I.contextMerge(fib.context, ctx), () => exec(self, fib))));
export const updateContext: {
  <R2, R>(f: (ctx: I.Context<R2>) => I.Context<NoInfer<R>>): <A, E>(self: Effect<A, E, R>) => Effect<A, E, R2>;
  <A, E, R, R2>(self: Effect<A, E, R>, f: (ctx: I.Context<R2>) => I.Context<NoInfer<R>>): Effect<A, E, R2>;
} = I.dual(2, (self: Effect<any, any, any>, f: (c: I.Context<any>) => I.Context<any>) =>
  make((fib) => withContext(fib, f(fib.context), () => exec(self, fib))));
export const provideService: {
  <Id, S>(key: I.Key<Id, S>, service: NoInfer<S>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Id>>;
  <A, E, R, Id, S>(self: Effect<A, E, R>, key: I.Key<Id, S>, service: NoInfer<S>): Effect<A, E, Exclude<R, Id>>;
} = I.dual(3, (self: Effect<any, any, any>, key: I.Key<any, any>, service: unknown) =>
  make((fib) => withContext(fib, I.contextAdd(fib.context, key.key, service), () => exec(self, fib))));
export const provideServiceEffect: {
  <Id, S, E2, R2>(key: I.Key<Id, S>, service: Effect<NoInfer<S>, E2, R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, Exclude<R, Id> | R2>;
  <A, E, R, Id, S, E2, R2>(self: Effect<A, E, R>, key: I.Key<Id, S>, service: Effect<NoInfer<S>, E2, R2>): Effect<A, E | E2, Exclude<R, Id> | R2>;
} = I.dual(3, (self: Effect<any, any, any>, key: I.Key<any, any>, service: Effect<any, any, any>) =>
  make((fib) => chain(exec(service, fib), (s) => withContext(fib, I.contextAdd(fib.context, key.key, s), () => exec(self, fib)))));
export const updateService: {
  <Id, S>(key: I.Key<Id, S>, f: (s: NoInfer<S>) => NoInfer<S>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R | Id>;
  <A, E, R, Id, S>(self: Effect<A, E, R>, key: I.Key<Id, S>, f: (s: NoInfer<S>) => NoInfer<S>): Effect<A, E, R | Id>;
} = I.dual(3, (self: Effect<any, any, any>, key: I.Key<any, any>, f: (s: any) => any) =>
  make((fib) => chain(exec(key, fib), (s) => withContext(fib, I.contextAdd(fib.context, key.key, f(s)), () => exec(self, fib)))));
export const service = <Id, S>(key: I.Key<Id, S>): Effect<S, never, Id> => key;
export const serviceOption = <Id, S>(key: I.Key<Id, S>): Effect<O.Option<S>> =>
  make((fib) => (I.hasService(fib.context, key.key) ? O.some(I.lookup(fib.context, key.key) as S) : O.none()));
type LayerOut<L> = L extends Layer<infer ROut, any, any> ? ROut : never;
type LayerErr<L> = L extends Layer<any, infer E, any> ? E : never;
type LayerIn<L> = L extends Layer<any, any, infer RIn> ? RIn : never;
export const provide: {
  <const Layers extends readonly [Layer<never, any, any>, ...Array<Layer<never, any, any>>]>(layers: Layers): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | LayerErr<Layers[number]>, Exclude<R, LayerOut<Layers[number]>> | LayerIn<Layers[number]>>;
  <ROut, E2, RIn>(layer: Layer<ROut, E2, RIn>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, Exclude<R, ROut> | RIn>;
  <R2>(context: I.Context<R2>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, R2>>;
  <A, E, R, const Layers extends readonly [Layer<never, any, any>, ...Array<Layer<never, any, any>>]>(self: Effect<A, E, R>, layers: Layers): Effect<A, E | LayerErr<Layers[number]>, Exclude<R, LayerOut<Layers[number]>> | LayerIn<Layers[number]>>;
  <A, E, R, ROut, E2, RIn>(self: Effect<A, E, R>, layer: Layer<ROut, E2, RIn>): Effect<A, E | E2, Exclude<R, ROut> | RIn>;
  <A, E, R, R2>(self: Effect<A, E, R>, context: I.Context<R2>): Effect<A, E, Exclude<R, R2>>;
} = I.dual(2, (self: Effect<any, any, any>, x: Layer<any, any, any> | ReadonlyArray<Layer<any, any, any>> | I.Context<any>) => {
  if (I.isContext(x)) return provideContext(self, x);
  const layers = Array.isArray(x) ? x : [x as Layer<any, any, any>];
  return make((fib) => {
    const sc = new ScopeM.ScopeImpl();
    const memo = makeMemoMap();
    const built = layers.reduce<Step<I.Context<any>>>(
      (acc, l) => chain(acc, (ctx) => chain(withContext(fib, I.contextMerge(fib.context, ctx), () => buildLayer(l, memo, sc, fib)), (c2) => I.contextMerge(ctx, c2))),
      I.emptyContext,
    );
    return exec(ScopeM.useScope(sc, make((f2) => chain(built, (ctx) => withContext(f2, I.contextMerge(f2.context, ctx), () => exec(self, f2))))), fib);
  });
});
export { isLayer };

// ---------- tracing ----------
const parentOf = (fib: I.Fiber): O.Option<T.AnySpan> => {
  if (fib.span) return O.some(fib.span as T.AnySpan);
  const p = fib.context.map.get(T.ParentSpanKey);
  return p ? O.some(p) : O.none();
};
function startSpan(fib: I.Fiber, name: string, o?: (T.SpanOptions & FnOptions) | T.SpanOptions): T.Span {
  const tracer = I.lookup(fib.context, T.Tracer.key) as T.Tracer;
  const parent = o?.parent ? O.some(o.parent) : o?.root ? O.none<T.AnySpan>() : parentOf(fib);
  const span = tracer.span({
    name, parent, annotations: I.emptyContext, links: o?.links ? [...o.links] : [],
    startTime: tracer === T.nativeTracer ? 0n : BigInt(Date.now()) * 1_000_000n,
    kind: o?.kind ?? "internal", root: o?.root ?? false, sampled: o?.sampled ?? true,
  });
  const ann = I.lookup(fib.context, Refs.TracerSpanAnnotations.key) as Record<string, unknown>;
  for (const k in ann) span.attribute(k, ann[k]);
  if (o?.attributes) for (const k in o.attributes) span.attribute(k, o.attributes[k]);
  return span;
}
const endSpan = (span: T.Span, exit: I.Exit<unknown, unknown>, native: boolean) => span.end(native ? 0n : BigInt(Date.now()) * 1_000_000n, exit);
export const withSpan: {
  (name: string, options?: T.SpanOptions): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, T.ParentSpan>>;
  <A, E, R>(self: Effect<A, E, R>, name: string, options?: T.SpanOptions): Effect<A, E, Exclude<R, T.ParentSpan>>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, name: string, o?: T.SpanOptions) =>
  make((fib) => {
    if (!(I.lookup(fib.context, Refs.TracerEnabled.key) as boolean)) return exec(self, fib);
    const span = startSpan(fib, name, o);
    const native = span instanceof T.NativeSpan;
    const prev = fib.span;
    fib.span = span;
    return settle(
      () => exec(self, fib),
      (a) => ((fib.span = prev), endSpan(span, I.exitSucceed(a), native), a),
      (e) => ((fib.span = prev), endSpan(span, I.exitFailCause(I.toCause(e)), native), rethrow(e)),
    );
  }));
export const useSpan = <A, E, R>(name: string, ...args: [f: (span: T.Span) => Effect<A, E, R>] | [options: T.SpanOptions, f: (span: T.Span) => Effect<A, E, R>]): Effect<A, E, R> =>
  make((fib) => {
    const [o, f] = args.length === 1 ? [undefined, args[0]] : args;
    const span = startSpan(fib, name, o);
    const native = span instanceof T.NativeSpan;
    return settle(() => execF(f(span), fib), (a) => (endSpan(span, I.exitSucceed(a), native), a), (e) => (endSpan(span, I.exitFailCause(I.toCause(e)), native), rethrow(e)));
  });
export const makeSpan = (name: string, options?: T.SpanOptions): Effect<T.Span> => make((fib) => startSpan(fib, name, options));
export const currentSpan: Effect<T.Span, NoSuchElementError> = make((fib) =>
  fib.span ? (fib.span as T.Span) : I.failWith(I.causeFail(new NoSuchElementError())));
export const currentParentSpan: Effect<T.AnySpan, NoSuchElementError> = make((fib) => {
  const p = parentOf(fib);
  return p._tag === "Some" ? p.value : I.failWith(I.causeFail(new NoSuchElementError()));
});
export const annotateCurrentSpan: {
  (key: string, value: unknown): Effect<void>;
  (values: Record<string, unknown>): Effect<void>;
} = (a: string | Record<string, unknown>, v?: unknown): Effect<void> =>
  make((fib) => {
    const span = fib.span as T.Span | undefined;
    if (!span?.attribute) return;
    if (typeof a === "string") span.attribute(a, v);
    else for (const k in a) span.attribute(k, a[k]);
  });
const annotateRef = (refKey: string) =>
  function (this: unknown): any {
    const args = arguments;
    const dataFirst = isEffect(args[0]);
    const k = dataFirst ? args[1] : args[0];
    const v = dataFirst ? args[2] : args[1];
    const apply = (self: Effect<any, any, any>) =>
      make((fib) => {
        const cur = I.lookup(fib.context, refKey) as Record<string, unknown>;
        const next = typeof k === "string" ? { ...cur, [k]: v } : { ...cur, ...k };
        return withContext(fib, I.contextAdd(fib.context, refKey, next), () => exec(self, fib));
      });
    return dataFirst ? apply(args[0]) : apply;
  };
type Annotate = {
  (key: string, value: unknown): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  (values: Record<string, unknown>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, key: string, value: unknown): Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, values: Record<string, unknown>): Effect<A, E, R>;
};
export const annotateSpans: Annotate = annotateRef(Refs.TracerSpanAnnotations.key);
export const annotateLogs: Annotate = annotateRef(Refs.CurrentLogAnnotations.key);
export const annotateLogsScoped: {
  (key: string, value: unknown): Effect<void, never, ScopeM.Scope>;
  (values: Record<string, unknown>): Effect<void, never, ScopeM.Scope>;
} = (k: string | Record<string, unknown>, v?: unknown): Effect<void, never, ScopeM.Scope> =>
  make((fib) => {
    const cur = I.lookup(fib.context, Refs.CurrentLogAnnotations.key) as Record<string, unknown>;
    fib.context = I.contextAdd(fib.context, Refs.CurrentLogAnnotations.key, typeof k === "string" ? { ...cur, [k]: v } : { ...cur, ...k });
  });
export const withParentSpan: {
  (span: T.AnySpan): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, T.ParentSpan>>;
  <A, E, R>(self: Effect<A, E, R>, span: T.AnySpan): Effect<A, E, Exclude<R, T.ParentSpan>>;
} = I.dual(2, (self: Effect<any, any, any>, span: T.AnySpan) =>
  make((fib) => {
    const prev = fib.span;
    fib.span = span;
    return settle(() => execF(self, fib), (a) => ((fib.span = prev), a), (e) => ((fib.span = prev), rethrow(e)));
  }));
export const linkSpans: {
  (span: T.AnySpan, attributes?: Record<string, unknown>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, span: T.AnySpan, attributes?: Record<string, unknown>): Effect<A, E, R>;
} = I.dual(isDataFirst, (self: Effect<any, any, any>, span: T.AnySpan, attributes?: Record<string, unknown>) =>
  make((fib) => {
    const cur = I.lookup(fib.context, Refs.TracerSpanLinks.key) as ReadonlyArray<unknown>;
    return withContext(fib, I.contextAdd(fib.context, Refs.TracerSpanLinks.key, [...cur, { span, attributes: attributes ?? {} }]), () => exec(self, fib));
  }));
const withRef = (key: string) =>
  I.dual(2, (self: Effect<any, any, any>, value: unknown) => make((fib) => withContext(fib, I.contextAdd(fib.context, key, value), () => exec(self, fib))));
export const withTracer: {
  (tracer: T.Tracer): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, tracer: T.Tracer): Effect<A, E, R>;
} = withRef(T.Tracer.key);
export const withTracerEnabled: {
  (enabled: boolean): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, enabled: boolean): Effect<A, E, R>;
} = withRef(Refs.TracerEnabled.key);
export const withTracerTiming: {
  (enabled: boolean): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, enabled: boolean): Effect<A, E, R>;
} = withRef(Refs.TracerTimingEnabled.key);

// ---------- logging ----------
const logAt = (level: Refs.LogLevel | undefined) => (...messages: ReadonlyArray<unknown>): Effect<void> =>
  make((fib) => {
    const lvl = level ?? (I.lookup(fib.context, Refs.CurrentLogLevel.key) as Refs.LogLevel);
    const min = I.lookup(fib.context, Refs.MinimumLogLevel.key) as Refs.LogLevel;
    if (Refs.logLevelRank[lvl] < Refs.logLevelRank[min]) return;
    let cause: Cause<unknown> = I.causeEmpty;
    const msgs: Array<unknown> = [];
    for (const m of messages) I.isCause(m) ? (cause = C.combine(cause, m)) : msgs.push(m);
    Log.emit(fib, lvl, msgs.length === 1 ? msgs[0] : msgs, cause);
  });
export const log = logAt(undefined);
export const logTrace = logAt("Trace");
export const logDebug = logAt("Debug");
export const logInfo = logAt("Info");
export const logWarning = logAt("Warn");
export const logError = logAt("Error");
export const logFatal = logAt("Fatal");
export const logWithLevel = (level: Refs.LogLevel, ...messages: ReadonlyArray<unknown>) => logAt(level)(...messages);
export const withLogger: {
  <M, O>(logger: Log.Logger<M, O>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R, M, O>(self: Effect<A, E, R>, logger: Log.Logger<M, O>): Effect<A, E, R>;
} = I.dual(2, (self: Effect<any, any, any>, logger: Log.Logger<any, any>) =>
  make((fib) => {
    const cur = I.lookup(fib.context, Log.CurrentLoggers.key) as ReadonlySet<unknown>;
    return withContext(fib, I.contextAdd(fib.context, Log.CurrentLoggers.key, new Set([...cur, logger])), () => exec(self, fib));
  }));
export const withLogSpan: {
  (label: string): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
  <A, E, R>(self: Effect<A, E, R>, label: string): Effect<A, E, R>;
} = I.dual(2, (self: Effect<any, any, any>, label: string) =>
  make((fib) => {
    const cur = I.lookup(fib.context, Refs.CurrentLogSpans.key) as ReadonlyArray<[string, number]>;
    return withContext(fib, I.contextAdd(fib.context, Refs.CurrentLogSpans.key, [...cur, [label, Date.now()]]), () => exec(self, fib));
  }));

// ---------- caching ----------
/** Memoize the first Exit; concurrent callers share the in-flight run. */
function memoExit<A, E, R>(self: Effect<A, E, R>, ttl: number): [Effect<A, E, R>, Effect<void>] {
  let cached: { exit?: Exit<A, E>; at: number; inflight?: I.Fiber<A, E> } | undefined;
  const get = make<A, E, R>((fib) => {
    if (cached?.exit && Date.now() - cached.at < ttl) return exec(cached.exit, fib);
    if (!cached?.inflight || cached.inflight.exit) {
      const f = I.runFiber(self, fib.context);
      cached = { at: Date.now(), inflight: f };
      f.addObserver((exit) => cached?.inflight === f && (cached = { exit, at: Date.now() }));
    }
    return chain(cached!.inflight ? cached!.inflight.awaitStep(fib) : cached!.exit!, (exit) => exec(exit, fib));
  });
  return [get, sync(() => void (cached = undefined))];
}
export const cached = <A, E, R>(self: Effect<A, E, R>): Effect<Effect<A, E, R>> => sync(() => memoExit(self, Infinity)[0]);
export const cachedWithTTL: {
  (ttl: D.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>;
  <A, E, R>(self: Effect<A, E, R>, ttl: D.Input): Effect<Effect<A, E, R>>;
} = I.dual(2, (self: Effect<any, any, any>, ttl: D.Input) => sync(() => memoExit(self, D.toMillis(ttl))[0]));
export const cachedInvalidateWithTTL: {
  (ttl: D.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<[Effect<A, E, R>, Effect<void>]>;
  <A, E, R>(self: Effect<A, E, R>, ttl: D.Input): Effect<[Effect<A, E, R>, Effect<void>]>;
} = I.dual(2, (self: Effect<any, any, any>, ttl: D.Input) => sync(() => memoExit(self, D.toMillis(ttl))));
export const once = <A, E, R>(self: Effect<A, E, R>): Effect<Effect<void, E, R>> => map(cached(self), asVoid);

// ---------- running ----------
export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
}
const failureToError = (cause: Cause<unknown>): unknown => {
  const e = C.squash(cause);
  if (e instanceof Error) return e;
  const err = new Error(I.prettyCause(cause));
  (err as any).cause = e;
  return err;
};
export const runForkWith = <R>(ctx: I.Context<R>) => <A, E>(self: Effect<A, E, R>, options?: RunOptions): Fiber<A, E> => {
  const f = I.runFiber(self, ctx);
  if (options?.signal) {
    if (options.signal.aborted) f.interruptAsFork(undefined);
    else options.signal.addEventListener("abort", () => f.interruptAsFork(undefined), { once: true });
  }
  return f;
};
export const runFork = runForkWith(I.emptyContext);
export const runPromiseExitWith = <R>(ctx: I.Context<R>) => {
  const fork = runForkWith(ctx);
  return <A, E>(self: Effect<A, E, R>, options?: RunOptions): Promise<Exit<A, E>> =>
    new Promise((resolve) => fork(self, options).addObserver(resolve));
};
export const runPromiseExit = runPromiseExitWith(I.emptyContext);
export const runPromiseWith = <R>(ctx: I.Context<R>) => {
  const fork = runForkWith(ctx);
  return <A, E>(self: Effect<A, E, R>, options?: RunOptions): Promise<A> =>
    new Promise((resolve, reject) =>
      fork(self, options).addObserver((exit) => (exit._tag === "Success" ? resolve(exit.value) : reject(failureToError(exit.cause)))));
};
export const runPromise = runPromiseWith(I.emptyContext);
export const runSyncExitWith = <R>(ctx: I.Context<R>) => <A, E>(self: Effect<A, E, R>): Exit<A, E> => {
  const f = I.runFiber(self, ctx);
  if (f.exit) return f.exit;
  f.interruptAsFork(undefined);
  return I.exitFailCause(I.causeDie(new Error("Effect.runSync: cannot run an asynchronous effect synchronously")));
};
export const runSyncExit = runSyncExitWith(I.emptyContext);
export const runSyncWith = <R>(ctx: I.Context<R>) => {
  const runExit = runSyncExitWith(ctx);
  return <A, E>(self: Effect<A, E, R>): A => {
    const exit = runExit(self);
    if (exit._tag === "Success") return exit.value;
    throw failureToError(exit.cause);
  };
};
export const runSync = runSyncWith(I.emptyContext);
export const runCallbackWith = <R>(ctx: I.Context<R>) => <A, E>(self: Effect<A, E, R>, options?: RunOptions & { readonly onExit?: (exit: Exit<A, E>) => void }): (() => void) => {
  const f = runForkWith(ctx)(self, options);
  if (options?.onExit) f.addObserver(options.onExit);
  return () => f.interruptAsFork(undefined);
};
export const runCallback = runCallbackWith(I.emptyContext);
