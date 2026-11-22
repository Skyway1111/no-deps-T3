import * as I from "./internal.ts";
import * as ScopeM from "./Scope.ts";

/** A set of fibers interrupted when the owning Scope closes. */
export class FiberSet<A = unknown, E = unknown> implements I.Pipeable {
  readonly fibers = new Set<I.Fiber<A, E>>();
  open = true;
  private waiters = new Set<() => void>();
  readonly deferredFailure: { cause?: I.Cause<E> } = {};
  add(f: I.Fiber<A, E>) {
    if (!this.open) return f.interruptAsFork(undefined);
    this.fibers.add(f);
    f.addObserver((exit) => {
      this.fibers.delete(f);
      if (exit._tag === "Failure" && !exit.cause.reasons.every((r) => r._tag === "Interrupt")) this.deferredFailure.cause ??= exit.cause;
      if (this.fibers.size === 0) for (const w of [...this.waiters]) w();
    });
  }
  awaitEmptyStep(f: I.Fiber): I.Step<void> {
    if (this.fibers.size === 0) return undefined;
    return I.interruptibleWait<void>(f, (res) => {
      const w = () => (this.waiters.delete(w), res());
      this.waiters.add(w);
      return () => this.waiters.delete(w);
    });
  }
  clearStep(by: number | undefined): I.Step<void> {
    const fs = [...this.fibers];
    for (const f of fs) f.interruptAsFork(by);
    const pending = fs.map((f) => f.awaitStep(undefined)).filter((s) => s instanceof I.Async) as Array<I.Async<unknown>>;
    return pending.length ? (new I.Async(Promise.all(pending.map((p) => p.p)).then(() => undefined)) as I.Async<void>) : undefined;
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const make = <A = unknown, E = unknown>(): I.Effect<FiberSet<A, E>, never, ScopeM.Scope> =>
  I.make((f) => {
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    const set = new FiberSet<A, E>();
    sc.add(() => I.make((f2) => ((set.open = false), set.clearStep(f2.id))));
    return set;
  });
export const makeRuntime = <R = never, A = unknown, E = unknown>() =>
  I.make<(<XA extends A, XE extends E>(effect: I.Effect<XA, XE, R>) => I.Fiber<XA, XE>), never, ScopeM.Scope | R>((f) =>
    I.chain(I.exec(make<A, E>(), f), (set) => (eff: I.Effect<any, any, any>) => {
      const fib = I.runFiber(eff, f.context);
      set.add(fib as never);
      return fib;
    }));
export const runtime = <A, E>(self: FiberSet<A, E>) => <R = never>(): I.Effect<(<XA extends A, XE extends E>(effect: I.Effect<XA, XE, R>) => I.Fiber<XA, XE>), never, R> =>
  I.make((f) => (eff: I.Effect<any, any, any>) => {
    const fib = I.runFiber(eff, f.context);
    self.add(fib as never);
    return fib;
  });
export const run: {
  <A, E>(self: FiberSet<A, E>): <R, XE extends E, XA extends A>(effect: I.Effect<XA, XE, R>) => I.Effect<I.Fiber<XA, XE>, never, R>;
  <A, E, R, XE extends E, XA extends A>(self: FiberSet<A, E>, effect: I.Effect<XA, XE, R>): I.Effect<I.Fiber<XA, XE>, never, R>;
} = function (self: FiberSet<any, any>, effect?: I.Effect<any, any, any>): any {
  const go = (eff: I.Effect<any, any, any>) => I.make((f) => {
    const fib = I.runFiber(eff, f.context, undefined, { inheritFrom: f });
    self.add(fib);
    return fib;
  });
  return effect === undefined ? go : go(effect);
} as never;
export const add = <A, E>(self: FiberSet<A, E>, fiber: I.Fiber<A, E>): I.Effect<void> => I.make(() => self.add(fiber));
export const clear = <A, E>(self: FiberSet<A, E>): I.Effect<void> => I.make((f) => self.clearStep(f.id));
export const size = <A, E>(self: FiberSet<A, E>): I.Effect<number> => I.make(() => self.fibers.size);
export const awaitEmpty = <A, E>(self: FiberSet<A, E>): I.Effect<void> => I.make((f) => self.awaitEmptyStep(f));
const join_ = <A, E>(self: FiberSet<A, E>): I.Effect<void, E> =>
  I.make((f) => I.chain(self.awaitEmptyStep(f), () => (self.deferredFailure.cause ? I.failWith(self.deferredFailure.cause) : undefined)));
export { join_ as join };
