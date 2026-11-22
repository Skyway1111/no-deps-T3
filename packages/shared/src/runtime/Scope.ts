import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";

export const TypeId: unique symbol = Symbol.for("effect/Scope") as never;
type Finalizer = (exit: I.Exit<any, any>) => I.Effect<unknown, any, any>;
export interface Scope {
  readonly [TypeId]: typeof TypeId;
  readonly strategy: "sequential" | "parallel";
  readonly parent: Scope | undefined;
  readonly state: { readonly _tag: "Open" | "Closed" };
}
export interface Closeable extends Scope {}

export class ScopeImpl implements Closeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  readonly state = { _tag: "Open" as "Open" | "Closed" };
  finalizers: Array<Finalizer> = [];
  exit: I.Exit<any, any> | undefined;
  readonly strategy: "sequential" | "parallel";
  readonly parent: Scope | undefined;
  constructor(strategy: "sequential" | "parallel" = "sequential", parent?: Scope) {
    this.strategy = strategy;
    this.parent = parent;
  }
  /** Adds a finalizer; if already closed, returns the effect to run now. Returns an unregister fn otherwise. */
  add(fin: Finalizer): (() => void) | I.Effect<unknown, any, any> {
    if (this.state._tag === "Closed") return fin(this.exit!);
    this.finalizers.push(fin);
    return () => {
      const i = this.finalizers.lastIndexOf(fin);
      if (i >= 0) this.finalizers.splice(i, 1);
    };
  }
  /** Close the scope on fiber `f`, running finalizers in reverse; never throws for finalizer failures except defects collected. */
  closeStep(exit: I.Exit<any, any>, f: I.Fiber): I.Step<void> {
    if (this.state._tag === "Closed") return undefined;
    this.state._tag = "Closed";
    this.exit = exit;
    const fins = this.finalizers.reverse();
    this.finalizers = [];
    if (fins.length === 0) return undefined;
    f.uninterruptible++;
    const restore = () => void f.uninterruptible--;
    let defects: Array<I.Reason<unknown>> | undefined;
    const record = (e: unknown) => {
      (defects ??= []).push(...I.toCause(e).reasons);
      return undefined;
    };
    const done = (): I.Step<void> => {
      restore();
      if (defects) throw new I.Failure(I.makeCause(defects));
      return undefined;
    };
    if (this.strategy === "parallel") {
      const steps: Array<Promise<unknown>> = [];
      for (const fin of fins) {
        const r = I.settle(() => I.exec(fin(exit), f), () => undefined, record);
        if (r instanceof I.Async) steps.push(r.p);
      }
      if (steps.length === 0) return done();
      return new I.Async(Promise.all(steps).then(() => I.toThen(done()))) as I.Async<void>;
    }
    let i = 0;
    const loop = (): I.Step<void> => {
      while (i < fins.length) {
        const fin = fins[i++]!;
        const r = I.settle(() => I.exec(fin(exit), f), () => undefined, record);
        if (r instanceof I.Async) return I.chain(r, loop);
      }
      return done();
    };
    return loop();
  }
  forkScope(strategy?: "sequential" | "parallel"): ScopeImpl {
    const child = new ScopeImpl(strategy ?? this.strategy, this);
    const un = this.add((exit) => I.make((f) => child.closeStep(exit, f)));
    if (typeof un === "function") child.add(() => I.make(() => un()));
    return child;
  }
}

export const Scope: Ctx.Service<Scope, Scope> = Ctx.Service<Scope>("effect/Scope");
export const Closeable = Scope as unknown as Ctx.Service<Closeable, Closeable>;
export const makeUnsafe = (strategy?: "sequential" | "parallel"): Closeable => new ScopeImpl(strategy);
export const make = (strategy?: "sequential" | "parallel"): I.Effect<Closeable> => I.make(() => new ScopeImpl(strategy));
export const close = <A, E>(self: Closeable, exit: I.Exit<A, E>): I.Effect<void> => I.make((f) => (self as ScopeImpl).closeStep(exit, f));
export const addFinalizerExit = (scope: Scope, finalizer: (exit: I.Exit<any, any>) => I.Effect<unknown, any, any>): I.Effect<void> =>
  I.make((f) => {
    const r = (scope as ScopeImpl).add(finalizer);
    return typeof r === "function" ? undefined : I.chain(I.exec(r, f), () => undefined);
  });
export const addFinalizer = (scope: Scope, finalizer: I.Effect<unknown, any, any>): I.Effect<void> => addFinalizerExit(scope, () => finalizer);
export const fork = (scope: Scope, strategy?: "sequential" | "parallel"): I.Effect<Closeable> => I.make(() => (scope as ScopeImpl).forkScope(strategy));
export const provide: {
  (value: Scope): <A, E, R>(self: I.Effect<A, E, R>) => I.Effect<A, E, Exclude<R, Scope>>;
  <A, E, R>(self: I.Effect<A, E, R>, value: Scope): I.Effect<A, E, Exclude<R, Scope>>;
} = I.dual(2, (self: I.Effect<any, any, any>, scope: Scope) =>
  I.make((f) => {
    const prev = f.context;
    f.context = I.contextAdd(prev, Scope.key, scope);
    return I.settle(() => I.exec(self, f), (a) => ((f.context = prev), a), (e) => ((f.context = prev), I.failWith(I.toCause(e))));
  }));
/** Run `self` with `scope`, then close the scope with the result. */
export const use: {
  (scope: Closeable): <A, E, R>(self: I.Effect<A, E, R>) => I.Effect<A, E, Exclude<R, Scope>>;
  <A, E, R>(self: I.Effect<A, E, R>, scope: Closeable): I.Effect<A, E, Exclude<R, Scope>>;
} = I.dual(2, (self: I.Effect<any, any, any>, scope: Closeable) => useScope(scope as ScopeImpl, self));

export function useScope<A>(scope: ScopeImpl, self: I.Effect<A, any, any>): I.Effect<A, any, any> {
  return I.make((f) => {
    const prev = f.context;
    f.context = I.contextAdd(prev, Scope.key, scope);
    return I.settle(
      () => I.exec(self, f),
      (a) => {
        f.context = prev;
        return I.chain(scope.closeStep(I.exitSucceed(a), f), () => a);
      },
      (e) => {
        f.context = prev;
        const cause = I.toCause(e);
        return I.settle(() => scope.closeStep(I.exitFailCause(cause), f), () => I.failWith(cause), (e2) =>
          I.failWith(I.makeCause([...cause.reasons, ...I.toCause(e2).reasons])));
      },
    );
  });
}
