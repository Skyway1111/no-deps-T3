import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as ScopeM from "./Scope.ts";

/** Keyed fibers: running a key interrupts its previous fiber (unless onlyIfMissing). */
export class FiberMap<K, A = unknown, E = unknown> implements I.Pipeable {
  readonly map = new Map<K, I.Fiber<A, E>>();
  open = true;
  set(key: K, f: I.Fiber<A, E>) {
    const prev = this.map.get(key);
    if (prev && prev !== f) prev.interruptAsFork(undefined);
    if (!this.open) return f.interruptAsFork(undefined);
    this.map.set(key, f);
    f.addObserver(() => this.map.get(key) === f && this.map.delete(key));
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
const interruptAll = (fs: Iterable<I.Fiber<any, any>>, by: number | undefined): I.Step<void> => {
  const arr = [...fs];
  for (const f of arr) f.interruptAsFork(by);
  const pending = arr.map((f) => f.awaitStep(undefined)).filter((s) => s instanceof I.Async) as Array<I.Async<unknown>>;
  return pending.length ? (new I.Async(Promise.all(pending.map((p) => p.p)).then(() => undefined)) as I.Async<void>) : undefined;
};
export const make = <K, A = unknown, E = unknown>(): I.Effect<FiberMap<K, A, E>, never, ScopeM.Scope> =>
  I.make((f) => {
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    const m = new FiberMap<K, A, E>();
    sc.add(() => I.make((f2) => ((m.open = false), interruptAll(m.map.values(), f2.id))));
    return m;
  });
export const run: {
  <K, A, E>(self: FiberMap<K, A, E>, key: K, options?: { readonly onlyIfMissing?: boolean }): <R, XE extends E, XA extends A>(effect: I.Effect<XA, XE, R>) => I.Effect<I.Fiber<XA, XE>, never, R>;
  <K, A, E, R, XE extends E, XA extends A>(self: FiberMap<K, A, E>, key: K, effect: I.Effect<XA, XE, R>, options?: { readonly onlyIfMissing?: boolean }): I.Effect<I.Fiber<XA, XE>, never, R>;
} = function (self: FiberMap<any, any, any>, key: unknown, a?: any, b?: any): any {
  const go = (eff: I.Effect<any, any, any>, o?: { onlyIfMissing?: boolean }) => I.make((f) => {
    const existing = self.map.get(key);
    if (o?.onlyIfMissing && existing) return existing;
    const fib = I.runFiber(eff, f.context, undefined, { inheritFrom: f });
    self.set(key, fib);
    return fib;
  });
  return I.isEffect(a) ? go(a, b) : (eff: I.Effect<any, any, any>) => go(eff, a);
} as never;
export const get: { <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => I.Effect<O.Option<I.Fiber<A, E>>>; <K, A, E>(self: FiberMap<K, A, E>, key: K): I.Effect<O.Option<I.Fiber<A, E>>> } =
  I.dual(2, (self: FiberMap<any, any, any>, key: unknown) => I.make(() => O.fromUndefinedOr(self.map.get(key))));
export const has: { <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => I.Effect<boolean>; <K, A, E>(self: FiberMap<K, A, E>, key: K): I.Effect<boolean> } =
  I.dual(2, (self: FiberMap<any, any, any>, key: unknown) => I.make(() => self.map.has(key)));
export const remove: { <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => I.Effect<void>; <K, A, E>(self: FiberMap<K, A, E>, key: K): I.Effect<void> } =
  I.dual(2, (self: FiberMap<any, any, any>, key: unknown) => I.make((f) => {
    const fib = self.map.get(key);
    self.map.delete(key);
    return fib ? interruptAll([fib], f.id) : undefined;
  }));
export const clear = <K, A, E>(self: FiberMap<K, A, E>): I.Effect<void> => I.make((f) => {
  const fs = [...self.map.values()];
  self.map.clear();
  return interruptAll(fs, f.id);
});
export const size = <K, A, E>(self: FiberMap<K, A, E>): I.Effect<number> => I.make(() => self.map.size);
export const set = <K, A, E>(self: FiberMap<K, A, E>, key: K, fiber: I.Fiber<A, E>): I.Effect<void> => I.make(() => self.set(key, fiber));
