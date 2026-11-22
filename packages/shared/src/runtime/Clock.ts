import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";

export interface Clock {
  currentTimeMillisUnsafe(): number;
  currentTimeNanosUnsafe(): bigint;
  /** Runtime hook: wait `ms` on fiber `f`, waking early on interruption. */
  sleepStep(ms: number, f: I.Fiber): I.Step<void>;
}
const origin = Date.now() - performance.now();
export const liveClock: Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeNanosUnsafe: () => BigInt(Math.round((origin + performance.now()) * 1e6)),
  sleepStep(ms, f) {
    if (ms === Infinity) return I.interruptibleWait<void>(f, () => {});
    return I.interruptibleWait<void>(f, (resolve) => {
      const h = setTimeout(resolve, Math.max(0, ms));
      return () => clearTimeout(h);
    });
  },
};
export const Clock: Ctx.Reference<Clock> = Ctx.Reference<Clock>("effect/Clock", { defaultValue: () => liveClock });
export const clockWith = <A, E, R>(f: (clock: Clock) => I.Effect<A, E, R>): I.Effect<A, E, R> =>
  I.make((fib) => I.exec(f(I.lookup(fib.context, Clock.key) as Clock), fib));
export const currentTimeMillis: I.Effect<number> = I.make((f) => (I.lookup(f.context, Clock.key) as Clock).currentTimeMillisUnsafe());
export const currentTimeNanos: I.Effect<bigint> = I.make((f) => (I.lookup(f.context, Clock.key) as Clock).currentTimeNanosUnsafe());
export const monotonicTimeNanos: I.Effect<bigint> = I.make(() => BigInt(Math.round(performance.now() * 1e6)));
export const sleepMillis = (ms: number): I.Effect<void> => I.make((f) => (I.lookup(f.context, Clock.key) as Clock).sleepStep(ms, f));
