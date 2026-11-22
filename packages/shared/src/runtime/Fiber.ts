import * as I from "./internal.ts";
import * as O from "./Option.ts";

export type Fiber<A, E = never> = I.Fiber<A, E>;
export const TypeId = I.FiberTypeId;
export const isFiber = (u: unknown): u is Fiber<unknown, unknown> => u instanceof I.Fiber;
const await_ = <A, E>(self: Fiber<A, E>): I.Effect<I.Exit<A, E>> => I.make((f) => self.awaitStep(f));
export { await_ as await };
export const join = <A, E>(self: Fiber<A, E>): I.Effect<A, E> => I.make((f) => I.chain(self.awaitStep(f), (exit) => I.exec(exit, f)));
export const interruptAs: {
  (fiberId: number | undefined): <A, E>(self: Fiber<A, E>) => I.Effect<void>;
  <A, E>(self: Fiber<A, E>, fiberId: number | undefined): I.Effect<void>;
} = I.dual(2, (self: Fiber<any, any>, id: number | undefined) =>
  I.make((f) => {
    self.interruptAsFork(id);
    return I.chain(self.awaitStep(f), () => undefined);
  }));
export const interrupt = <A, E>(self: Fiber<A, E>): I.Effect<void> => I.make((f) => (self.interruptAsFork(f.id), I.chain(self.awaitStep(f), () => undefined)));
const awaitMany = (fibers: Iterable<Fiber<any, any>>, f: I.Fiber): I.Step<Array<I.Exit<any, any>>> => {
  const steps = [...fibers].map((x) => x.awaitStep(f));
  if (!steps.some((s) => s instanceof I.Async)) return steps as Array<I.Exit<any, any>>;
  return new I.Async(Promise.all(steps.map((s) => (s instanceof I.Async ? s.p : s))));
};
export const awaitAll = <F extends Fiber<any, any>>(fibers: Iterable<F>): I.Effect<Array<I.Exit<F extends Fiber<infer A, any> ? A : never, F extends Fiber<any, infer E> ? E : never>>> =>
  I.make((f) => awaitMany(fibers, f));
export const joinAll = <F extends Fiber<any, any>>(fibers: Iterable<F>): I.Effect<Array<F extends Fiber<infer A, any> ? A : never>, F extends Fiber<any, infer E> ? E : never> =>
  I.make((f) =>
    I.chain(awaitMany(fibers, f), (exits) => {
      const out: Array<any> = [];
      for (const e of exits) {
        if (e._tag === "Failure") return I.failWith(e.cause);
        out.push(e.value);
      }
      return out;
    }));
export const interruptAllAs: {
  (fiberId: number | undefined): (fibers: Iterable<Fiber<any, any>>) => I.Effect<void>;
  (fibers: Iterable<Fiber<any, any>>, fiberId: number | undefined): I.Effect<void>;
} = I.dual(2, (fibers: Iterable<Fiber<any, any>>, id: number | undefined) =>
  I.make((f) => {
    const arr = [...fibers];
    for (const x of arr) x.interruptAsFork(id);
    return I.chain(awaitMany(arr, f), () => undefined);
  }));
export const interruptAll = (fibers: Iterable<Fiber<any, any>>): I.Effect<void> => I.make((f) => I.exec(interruptAllAs(fibers, f.id), f));
export const getCurrent = (): O.Option<Fiber<any, any>> => O.fromUndefinedOr(I.currentFiber);
export const poll = <A, E>(self: Fiber<A, E>): I.Effect<O.Option<I.Exit<A, E>>> => I.make(() => O.fromUndefinedOr(self.exit));
