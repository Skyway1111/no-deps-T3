import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";

export interface Random {
  nextDoubleUnsafe(): number;
}
const mathRandom: Random = { nextDoubleUnsafe: Math.random };
export const Random = Ctx.Reference<Random>("effect/Random", { defaultValue: () => mathRandom });
const rng = (f: I.Fiber) => I.lookup(f.context, Random.key) as Random;
export const next: I.Effect<number> = I.make((f) => rng(f).nextDoubleUnsafe());
export const nextInt: I.Effect<number> = I.make((f) => Math.floor(rng(f).nextDoubleUnsafe() * Number.MAX_SAFE_INTEGER));
export const nextBoolean: I.Effect<boolean> = I.make((f) => rng(f).nextDoubleUnsafe() > 0.5);
export const nextBetween = (min: number, max: number): I.Effect<number> => I.make((f) => min + rng(f).nextDoubleUnsafe() * (max - min));
/** Integer in [min, max) by default; `halfOpen: false` includes max. */
export const nextIntBetween = (min: number, max: number, options?: { readonly halfOpen?: boolean }): I.Effect<number> =>
  I.make((f) => {
    const hi = options?.halfOpen === false ? max + 1 : max;
    return Math.floor(min + rng(f).nextDoubleUnsafe() * (hi - min));
  });
export const shuffle = <A>(as: Iterable<A>): I.Effect<Array<A>> =>
  I.make((f) => {
    const arr = [...as];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng(f).nextDoubleUnsafe() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  });
/** Deterministic PRNG (mulberry32). */
export const withSeed: {
  (seed: number | string): <A, E, R>(self: I.Effect<A, E, R>) => I.Effect<A, E, R>;
  <A, E, R>(self: I.Effect<A, E, R>, seed: number | string): I.Effect<A, E, R>;
} = I.dual(2, (self: I.Effect<any, any, any>, seed: number | string) =>
  I.make((fib) => {
    let s = typeof seed === "number" ? seed | 0 : I.hashString(seed);
    const r: Random = {
      nextDoubleUnsafe() {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
    };
    const prev = fib.context;
    fib.context = I.contextAdd(prev, Random.key, r);
    return I.settle(() => I.exec(self, fib), (a) => ((fib.context = prev), a), (e) => ((fib.context = prev), I.failWith(I.toCause(e))));
  }));
