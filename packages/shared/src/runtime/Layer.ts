import * as I from "./internal.ts";
import { chain, exec, settle, type Step } from "./internal.ts";
import * as ScopeM from "./Scope.ts";
import { layerHooks } from "./Logger.ts";

export const TypeId: unique symbol = Symbol.for("effect/Layer") as never;
type Build<ROut> = (memo: MemoMap, scope: ScopeM.ScopeImpl, fib: I.Fiber) => Step<I.Context<ROut>>;
export interface Layer<in ROut, out E = never, out RIn = never> extends I.Pipeable {
  readonly [TypeId]: { readonly _ROut: (_: ROut) => void; readonly _E: (_: never) => E; readonly _RIn: (_: never) => RIn };
  readonly build: Build<any>;
  readonly memoize: boolean;
}
export type Any = Layer<any, any, any>;
export declare namespace Layer {
  type Success<T> = T extends Layer<infer R, any, any> ? R : never;
  type Error<T> = T extends Layer<any, infer E, any> ? E : never;
  type Services<T> = T extends Layer<any, any, infer R> ? R : never;
  type Any = Layer<any, any, any>;
}
export type Success<T> = Layer.Success<T>;
export type Error<T> = Layer.Error<T>;
export type Services<T> = Layer.Services<T>;

/** Memoizes layers by identity within one build; async builds are shared. */
export interface MemoMap {
  readonly map: Map<Any, Step<I.Context<any>>>;
}
export const makeMemoMap = (): MemoMap => ({ map: new Map() });
export const makeMemoMapUnsafe = makeMemoMap;

const proto = { [TypeId]: {}, ...I.PipeProto };
const mk = <ROut, E, RIn>(build: Build<ROut>, memoize = true): Layer<ROut, E, RIn> => Object.assign(Object.create(proto), { build, memoize });
export const isLayer = (u: unknown): u is Any => typeof u === "object" && u !== null && TypeId in u;

/** Build `layer`, reusing a memoized result for the same layer object. */
export function buildLayer(layer: Any, memo: MemoMap, scope: ScopeM.ScopeImpl, fib: I.Fiber): Step<I.Context<any>> {
  if (!layer.memoize) return layer.build(memo, scope, fib);
  const hit = memo.map.get(layer);
  if (hit !== undefined) return hit instanceof I.Async ? new I.Async(hit.p) : hit;
  const r = layer.build(memo, scope, fib);
  if (r instanceof I.Async) {
    const shared = new I.Async(r.p);
    memo.map.set(layer, shared);
    r.p.catch(() => memo.map.delete(layer));
  } else memo.map.set(layer, r);
  return r;
}
export const fromBuild = <ROut, E = never, RIn = never>(
  build: (memo: MemoMap, scope: ScopeM.Scope, fib: I.Fiber) => Step<I.Context<ROut>>,
): Layer<ROut, E, RIn> => mk(build as Build<ROut>);
layerHooks.fromBuild = (run) => mk((_, __, fib) => run(fib));

/** Run `eff` with the layer scope as the current Scope. */
const inScope = <A>(eff: I.Effect<A, any, any>, scope: ScopeM.ScopeImpl, fib: I.Fiber): Step<A> => {
  const prev = fib.context;
  fib.context = I.contextAdd(prev, ScopeM.Scope.key, scope);
  return settle(() => exec(eff, fib), (a) => ((fib.context = prev), a), (e) => ((fib.context = prev), I.failWith(I.toCause(e))));
};
const single = (key: string, svc: unknown) => I.makeContext(new Map([[key, svc]]));

export const succeed: {
  <Id, S>(key: I.Key<Id, S>): (service: NoInfer<S>) => Layer<Id>;
  <Id, S>(key: I.Key<Id, S>, service: NoInfer<S>): Layer<Id>;
} = function (key: I.Key<any, any>, ...rest: Array<unknown>): any {
  const of = (svc: unknown) => {
    const ctx = single(key.key, svc);
    return mk(() => ctx);
  };
  return rest.length === 0 ? of : of(rest[0]);
} as never;
export const sync: {
  <Id, S>(key: I.Key<Id, S>): (f: () => NoInfer<S>) => Layer<Id>;
  <Id, S>(key: I.Key<Id, S>, f: () => NoInfer<S>): Layer<Id>;
} = function (key: I.Key<any, any>, ...rest: Array<unknown>): any {
  const of = (f: () => unknown) => mk(() => single(key.key, f()));
  return rest.length === 0 ? of : of(rest[0] as () => unknown);
} as never;
export const effect: {
  <Id, S>(key: I.Key<Id, S>): <E, R>(effect: I.Effect<NoInfer<S>, E, R>) => Layer<Id, E, Exclude<R, ScopeM.Scope>>;
  <Id, S, E, R>(key: I.Key<Id, S>, effect: I.Effect<NoInfer<S>, E, R>): Layer<Id, E, Exclude<R, ScopeM.Scope>>;
} = function (key: I.Key<any, any>, ...rest: Array<unknown>): any {
  const of = (eff: I.Effect<any, any, any>) => mk((_, scope, fib) => chain(inScope(eff, scope, fib), (svc) => single(key.key, svc)));
  return rest.length === 0 ? of : of(rest[0] as I.Effect<any, any, any>);
} as never;
export const scoped = effect;
export const effectDiscard = <X, E, R>(eff: I.Effect<X, E, R>): Layer<never, E, Exclude<R, ScopeM.Scope>> =>
  mk((_, scope, fib) => chain(inScope(eff, scope, fib), () => I.emptyContext));
export const scopedDiscard = effectDiscard;
export const effectContext = <ROut, E, R>(eff: I.Effect<I.Context<ROut>, E, R>): Layer<ROut, E, Exclude<R, ScopeM.Scope>> =>
  mk((_, scope, fib) => inScope(eff, scope, fib));
export const scopedContext = effectContext;
export const succeedContext = <ROut>(ctx: I.Context<ROut>): Layer<ROut> => mk(() => ctx);
export const syncContext = <ROut>(f: () => I.Context<ROut>): Layer<ROut> => mk(() => f());
export const empty: Layer<never> = mk(() => I.emptyContext);
export const suspend = <ROut, E, RIn>(f: () => Layer<ROut, E, RIn>): Layer<ROut, E, RIn> => {
  let l: Any | undefined;
  return mk((memo, scope, fib) => buildLayer((l ??= f()), memo, scope, fib));
};
export const unwrap = <ROut, E, RIn, E2, R2>(eff: I.Effect<Layer<ROut, E, RIn>, E2, R2>): Layer<ROut, E | E2, RIn | Exclude<R2, ScopeM.Scope>> =>
  mk((memo, scope, fib) => chain(inScope(eff, scope, fib), (l) => buildLayer(l, memo, scope, fib)));
export const unwrapScoped = unwrap;
export const fresh = <ROut, E, RIn>(self: Layer<ROut, E, RIn>): Layer<ROut, E, RIn> => mk((memo, scope, fib) => self.build(memo, scope, fib), false);

/** Build all layers concurrently (sharing memo), merging their contexts in order. */
function buildAll(layers: ReadonlyArray<Any>, memo: MemoMap, scope: ScopeM.ScopeImpl, fib: I.Fiber): Step<I.Context<any>> {
  const results: Array<Step<I.Context<any>>> = [];
  let anyAsync = false;
  for (const l of layers) {
    const r = buildLayer(l, memo, scope, fib);
    if (r instanceof I.Async) anyAsync = true;
    results.push(r);
  }
  const merge = (ctxs: ReadonlyArray<I.Context<any>>) => ctxs.reduce(I.contextMerge, I.emptyContext);
  if (!anyAsync) return merge(results as Array<I.Context<any>>);
  return new I.Async(Promise.all(results.map((r) => (r instanceof I.Async ? r.p.then(I.unbox) : r))).then(merge));
}
type MergeOut<Ls extends ReadonlyArray<Any>> = { [K in keyof Ls]: Success<Ls[K]> }[number];
type MergeErr<Ls extends ReadonlyArray<Any>> = { [K in keyof Ls]: Error<Ls[K]> }[number];
type MergeIn<Ls extends ReadonlyArray<Any>> = { [K in keyof Ls]: Services<Ls[K]> }[number];
export const mergeAll = <const Ls extends readonly [Any, ...Array<Any>]>(...layers: Ls): Layer<MergeOut<Ls>, MergeErr<Ls>, MergeIn<Ls>> =>
  mk((memo, scope, fib) => buildAll(layers, memo, scope, fib));
export const merge: {
  <R2, E2, I2>(that: Layer<R2, E2, I2>): <R, E, In>(self: Layer<R, E, In>) => Layer<R | R2, E | E2, In | I2>;
  <const Ls extends readonly [Any, ...Array<Any>]>(that: Ls): <R, E, In>(self: Layer<R, E, In>) => Layer<R | MergeOut<Ls>, E | MergeErr<Ls>, In | MergeIn<Ls>>;
  <R, E, In, R2, E2, I2>(self: Layer<R, E, In>, that: Layer<R2, E2, I2>): Layer<R | R2, E | E2, In | I2>;
  <R, E, In, const Ls extends readonly [Any, ...Array<Any>]>(self: Layer<R, E, In>, that: Ls): Layer<R | MergeOut<Ls>, E | MergeErr<Ls>, In | MergeIn<Ls>>;
} = I.dual(2, (self: Any, that: Any | ReadonlyArray<Any>) => mergeAll(self, ...(Array.isArray(that) ? that : [that as Any])));

/** Build `deps`, then `self` with deps in context. */
const provideImpl = (self: Any, deps: Any | ReadonlyArray<Any>, keepDeps: boolean): Any =>
  mk((memo, scope, fib) => {
    const ds = Array.isArray(deps) ? deps : [deps as Any];
    return chain(buildAll(ds, memo, scope, fib), (depCtx) => {
      const prev = fib.context;
      fib.context = I.contextMerge(prev, depCtx);
      return settle(
        () => buildLayer(self, memo, scope, fib),
        (ctx) => ((fib.context = prev), keepDeps ? I.contextMerge(depCtx, ctx) : ctx),
        (e) => ((fib.context = prev), I.failWith(I.toCause(e))),
      );
    });
  });
export const provide: {
  <RO2, E2, RI2>(that: Layer<RO2, E2, RI2>): <RO, E, RI>(self: Layer<RO, E, RI>) => Layer<RO, E | E2, Exclude<RI, RO2> | RI2>;
  <const Ls extends readonly [Any, ...Array<Any>]>(that: Ls): <RO, E, RI>(self: Layer<RO, E, RI>) => Layer<RO, E | MergeErr<Ls>, Exclude<RI, MergeOut<Ls>> | MergeIn<Ls>>;
  <RO, E, RI, RO2, E2, RI2>(self: Layer<RO, E, RI>, that: Layer<RO2, E2, RI2>): Layer<RO, E | E2, Exclude<RI, RO2> | RI2>;
  <RO, E, RI, const Ls extends readonly [Any, ...Array<Any>]>(self: Layer<RO, E, RI>, that: Ls): Layer<RO, E | MergeErr<Ls>, Exclude<RI, MergeOut<Ls>> | MergeIn<Ls>>;
} = I.dual(2, (self: Any, that: Any | ReadonlyArray<Any>) => provideImpl(self, that, false));
export const provideMerge: {
  <RO2, E2, RI2>(that: Layer<RO2, E2, RI2>): <RO, E, RI>(self: Layer<RO, E, RI>) => Layer<RO | RO2, E | E2, Exclude<RI, RO2> | RI2>;
  <const Ls extends readonly [Any, ...Array<Any>]>(that: Ls): <RO, E, RI>(self: Layer<RO, E, RI>) => Layer<RO | MergeOut<Ls>, E | MergeErr<Ls>, Exclude<RI, MergeOut<Ls>> | MergeIn<Ls>>;
  <RO, E, RI, RO2, E2, RI2>(self: Layer<RO, E, RI>, that: Layer<RO2, E2, RI2>): Layer<RO | RO2, E | E2, Exclude<RI, RO2> | RI2>;
  <RO, E, RI, const Ls extends readonly [Any, ...Array<Any>]>(self: Layer<RO, E, RI>, that: Ls): Layer<RO | MergeOut<Ls>, E | MergeErr<Ls>, Exclude<RI, MergeOut<Ls>> | MergeIn<Ls>>;
} = I.dual(2, (self: Any, that: Any | ReadonlyArray<Any>) => provideImpl(self, that, true));
export const flatMap: {
  <RO, RO2, E2, RI2>(f: (ctx: I.Context<RO>) => Layer<RO2, E2, RI2>): <E, RI>(self: Layer<RO, E, RI>) => Layer<RO2, E | E2, RI | RI2>;
  <RO, E, RI, RO2, E2, RI2>(self: Layer<RO, E, RI>, f: (ctx: I.Context<RO>) => Layer<RO2, E2, RI2>): Layer<RO2, E | E2, RI | RI2>;
} = I.dual(2, (self: Any, f: (ctx: I.Context<any>) => Any) => mk((memo, scope, fib) => chain(buildLayer(self, memo, scope, fib), (ctx) => buildLayer(f(ctx), memo, scope, fib))));
export const tap: {
  <RO, X, E2, R2>(f: (ctx: I.Context<RO>) => I.Effect<X, E2, R2>): <E, RI>(self: Layer<RO, E, RI>) => Layer<RO, E | E2, RI | R2>;
  <RO, E, RI, X, E2, R2>(self: Layer<RO, E, RI>, f: (ctx: I.Context<RO>) => I.Effect<X, E2, R2>): Layer<RO, E | E2, RI | R2>;
} = I.dual(2, (self: Any, f: (ctx: I.Context<any>) => I.Effect<any, any, any>) =>
  mk((memo, scope, fib) => chain(buildLayer(self, memo, scope, fib), (ctx) => chain(inScope(f(ctx), scope, fib), () => ctx))));
const catchLayer = (self: Any, onCause: (c: I.Cause<unknown>) => Any | undefined): Any =>
  mk((memo, scope, fib) => settle(() => buildLayer(self, memo, scope, fib), (c) => c, (e) => {
    const cause = I.toCause(e);
    const alt = onCause(cause);
    return alt ? buildLayer(alt, memo, scope, fib) : I.failWith(cause);
  }));
const firstError = (c: I.Cause<unknown>) => (c.reasons.find((r) => r._tag === "Fail") as I.Fail<unknown> | undefined)?.error;
const catch_: {
  <E, RO2, E2, RI2>(f: (e: E) => Layer<RO2, E2, RI2>): <RO, RI>(self: Layer<RO, E, RI>) => Layer<RO & RO2, E2, RI | RI2>;
  <RO, E, RI, RO2, E2, RI2>(self: Layer<RO, E, RI>, f: (e: E) => Layer<RO2, E2, RI2>): Layer<RO & RO2, E2, RI | RI2>;
} = I.dual(2, (self: Any, f: (e: any) => Any) => catchLayer(self, (c) => (c.reasons.some((r) => r._tag === "Fail") ? f(firstError(c)) : undefined)));
export { catch_ as catch };
export const catchCause: {
  <E, RO2, E2, RI2>(f: (c: I.Cause<E>) => Layer<RO2, E2, RI2>): <RO, RI>(self: Layer<RO, E, RI>) => Layer<RO & RO2, E2, RI | RI2>;
  <RO, E, RI, RO2, E2, RI2>(self: Layer<RO, E, RI>, f: (c: I.Cause<E>) => Layer<RO2, E2, RI2>): Layer<RO & RO2, E2, RI | RI2>;
} = I.dual(2, (self: Any, f: (c: I.Cause<any>) => Any) => catchLayer(self, f));
export const catchTag: {
  <E, K extends E extends { _tag: string } ? E["_tag"] : never, RO2, E2, RI2>(k: K, f: (e: Extract<E, { _tag: K }>) => Layer<RO2, E2, RI2>): <RO, RI>(self: Layer<RO, E, RI>) => Layer<RO & RO2, Exclude<E, { _tag: K }> | E2, RI | RI2>;
  <RO, E, RI, K extends E extends { _tag: string } ? E["_tag"] : never, RO2, E2, RI2>(self: Layer<RO, E, RI>, k: K, f: (e: Extract<E, { _tag: K }>) => Layer<RO2, E2, RI2>): Layer<RO & RO2, Exclude<E, { _tag: K }> | E2, RI | RI2>;
} = I.dual(3, (self: Any, k: string, f: (e: any) => Any) => catchLayer(self, (c) => {
  const e = firstError(c) as { _tag?: string } | undefined;
  return e?._tag === k ? f(e) : undefined;
}));
export const orDie = <RO, E, RI>(self: Layer<RO, E, RI>): Layer<RO, never, RI> =>
  catchLayer(self, (c) => {
    const e = firstError(c);
    return c.reasons.some((r) => r._tag === "Fail") ? mk(() => I.failWith(I.causeDie(e))) : undefined;
  }) as Layer<RO, never, RI>;
export const updateService: {
  <Id, S>(key: I.Key<Id, S>, f: (s: S) => S): <RO, E, RI>(self: Layer<RO, E, RI>) => Layer<RO, E, RI | Id>;
  <RO, E, RI, Id, S>(self: Layer<RO, E, RI>, key: I.Key<Id, S>, f: (s: S) => S): Layer<RO, E, RI | Id>;
} = I.dual(3, (self: Any, key: I.Key<any, any>, f: (s: any) => any) =>
  mk((memo, scope, fib) => {
    const prev = fib.context;
    if (I.hasService(prev, key.key)) fib.context = I.contextAdd(prev, key.key, f(I.lookup(prev, key.key)));
    return settle(() => buildLayer(self, memo, scope, fib), (c) => ((fib.context = prev), c), (e) => ((fib.context = prev), I.failWith(I.toCause(e))));
  }));

const MockTypeId = Symbol.for("effect/Layer/mock");
const unimplemented = (key: string, prop: string) => {
  const die = () => I.failWith(I.causeDie(new Error(`${key}.${prop} is not implemented in this mock`)));
  const f: any = () => I.make(die);
  f[I.RUN] = die;
  f[I.EffectTypeId] = I.YieldableProto[I.EffectTypeId];
  f[Symbol.iterator] = I.YieldableProto[Symbol.iterator];
  f.pipe = I.PipeProto.pipe;
  f[MockTypeId] = true;
  return f;
};
/** Partial service: missing members die when used. */
export const mock = <Id, S extends object>(key: I.Key<Id, S>) => (implementation: Partial<S>): Layer<Id> => {
  const svc = new Proxy(implementation as S, {
    get(target, prop, recv) {
      if (prop in target || typeof prop === "symbol" || prop === "then" || prop === "toJSON") return Reflect.get(target, prop, recv);
      return unimplemented(key.key, prop);
    },
  });
  return succeed(key, svc);
};

// ---------- building ----------
export const buildWithMemoMap: {
  (memo: MemoMap, scope: ScopeM.Scope): <RO, E, RI>(self: Layer<RO, E, RI>) => I.Effect<I.Context<RO>, E, RI>;
  <RO, E, RI>(self: Layer<RO, E, RI>, memo: MemoMap, scope: ScopeM.Scope): I.Effect<I.Context<RO>, E, RI>;
} = I.dual(3, (self: Any, memo: MemoMap, scope: ScopeM.Scope) => I.make((fib) => buildLayer(self, memo, scope as ScopeM.ScopeImpl, fib)));
export const buildWithScope: {
  (scope: ScopeM.Scope): <RO, E, RI>(self: Layer<RO, E, RI>) => I.Effect<I.Context<RO>, E, RI>;
  <RO, E, RI>(self: Layer<RO, E, RI>, scope: ScopeM.Scope): I.Effect<I.Context<RO>, E, RI>;
} = I.dual(2, (self: Any, scope: ScopeM.Scope) => I.make((fib) => buildLayer(self, makeMemoMap(), scope as ScopeM.ScopeImpl, fib)));
export const build = <RO, E, RI>(self: Layer<RO, E, RI>): I.Effect<I.Context<RO>, E, RI | ScopeM.Scope> =>
  I.make((fib) => {
    const sc = fib.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    return buildLayer(self, makeMemoMap(), sc, fib);
  });
/** Build and keep the layer alive until interrupted. */
export const launch = <RO, E, RI>(self: Layer<RO, E, RI>): I.Effect<never, E, RI> =>
  I.make((fib) => {
    const sc = new ScopeM.ScopeImpl();
    return exec(ScopeM.useScope(sc, I.make((f2) => chain(buildLayer(self, makeMemoMap(), sc, f2), () => I.interruptibleWait<never>(f2, () => {})))), fib);
  });
