import * as I from "./internal.ts";
import * as D from "./Duration.ts";

export const TypeId: unique symbol = Symbol.for("effect/Schedule") as never;
export interface Metadata<Output, Input> {
  readonly input: Input;
  readonly output: Output;
  readonly attempt: number;
  readonly start: number;
  readonly now: number;
  readonly elapsed: number;
  readonly elapsedSincePrevious: number;
  readonly duration: D.Duration;
}
/** `undefined` means the schedule is done. */
export type Stepper<Output, Input> = (input: Input, f: I.Fiber) => I.Step<Metadata<Output, Input> | undefined>;
export interface Schedule<out Output, in Input = unknown, out Error = never, out Env = never> extends I.Pipeable {
  readonly [TypeId]: { _O: (_: never) => Output; _I: (_: Input) => void; _E: (_: never) => Error; _R: (_: never) => Env };
  /** Typed loosely so Input stays contravariant; the phantom above carries the real types. */
  readonly start: () => Stepper<any, any>;
}
const proto = { [TypeId]: {}, ...I.PipeProto };
export const fromStepper = <O, In, E = never, R = never>(start: () => Stepper<O, In>): Schedule<O, In, E, R> =>
  Object.assign(Object.create(proto), { start });
export const isSchedule = (u: unknown): u is Schedule<unknown, unknown, unknown, unknown> => typeof u === "object" && u !== null && TypeId in u;

/** Build from a pure step: (attempt, input, elapsed) => [output, delayMs] | undefined. */
const pure = <O, In = unknown>(step: (attempt: number, input: In, elapsed: number) => readonly [O, number] | undefined): Schedule<O, In> =>
  fromStepper(() => {
    let attempt = 0;
    const start = Date.now();
    let prev = start;
    return (input) => {
      const now = Date.now();
      const r = step(++attempt, input, now - start);
      if (!r) return undefined;
      const m: Metadata<O, In> = { input, output: r[0], attempt, start, now, elapsed: now - start, elapsedSincePrevious: now - prev, duration: D.millis(r[1]) };
      prev = now;
      return m;
    };
  });
export const forever: Schedule<number> = pure((n) => [n - 1, 0]);
export const spaced = (d: D.Input): Schedule<number> => {
  const ms = D.toMillis(d);
  return pure((n) => [n - 1, ms]);
};
export const fixed = spaced;
export const recurs = (times: number): Schedule<number> => pure((n) => (n <= times ? [n - 1, 0] : undefined));
export const once: Schedule<void> = pure((n) => (n <= 1 ? [undefined, 0] : undefined));
export const exponential = (base: D.Input, factor = 2): Schedule<D.Duration> => {
  const ms = D.toMillis(base);
  return pure((n) => {
    const d = ms * Math.pow(factor, n - 1);
    return [D.millis(d), d];
  });
};
export const fibonacci = (one: D.Input): Schedule<D.Duration> => {
  const ms = D.toMillis(one);
  return fromStepper(() => {
    let a = ms, b = ms;
    const inner = pure<D.Duration>(() => {
      const d = a;
      [a, b] = [b, a + b];
      return [D.millis(d), d];
    }).start();
    return inner;
  });
};
export const duration = (d: D.Input): Schedule<D.Duration> => {
  const ms = D.toMillis(d);
  return pure((n) => (n === 1 ? [D.millis(ms), ms] : undefined));
};
export const during = (d: D.Input): Schedule<D.Duration> => {
  const ms = D.toMillis(d);
  return pure((_, __, elapsed) => (elapsed < ms ? [D.millis(elapsed), 0] : undefined));
};
export const windowed = (d: D.Input): Schedule<number> => {
  const ms = D.toMillis(d);
  return pure((n, _, elapsed) => [n - 1, ms - (elapsed % ms)]);
};
export const identity = <A>(): Schedule<A, A> => pure<A, A>((_, input) => [input, 0]);
export const passthrough = <O, In, E, R>(self: Schedule<O, In, E, R>): Schedule<In, In, E, R> =>
  mapMeta(self, (m) => ({ ...m, output: m.input }) as never) as never;

const mapMeta = <O, In, E, R, O2>(self: Schedule<O, In, E, R>, f: (m: Metadata<O, In>, fib: I.Fiber) => I.Step<Metadata<O2, In> | undefined>): Schedule<O2, In, E, R> =>
  fromStepper(() => {
    const s = self.start();
    return (input, fib) => I.chain(s(input, fib), (m) => (m ? f(m, fib) : undefined));
  });
export const map: {
  <O, O2, In, E2 = never, R2 = never>(f: (o: O) => O2 | I.Effect<O2, E2, R2>): <E, R>(self: Schedule<O, In, E, R>) => Schedule<O2, In, E | E2, R | R2>;
  <O, In, E, R, O2, E2 = never, R2 = never>(self: Schedule<O, In, E, R>, f: (o: O) => O2 | I.Effect<O2, E2, R2>): Schedule<O2, In, E | E2, R | R2>;
} = I.dual(2, (self: Schedule<any, any, any, any>, f: (o: any) => any) =>
  mapMeta(self, (m, fib) => {
    const o = f(m.output);
    return I.isEffect(o) ? I.chain(I.exec(o, fib), (output) => ({ ...m, output })) : { ...m, output: o };
  }));
export const modifyDelay: {
  <O, In, E2 = never, R2 = never>(f: (m: Metadata<O, In>) => D.Input | I.Effect<D.Input, E2, R2>): <E, R>(self: Schedule<O, In, E, R>) => Schedule<O, In, E | E2, R | R2>;
  <O, In, E, R, E2 = never, R2 = never>(self: Schedule<O, In, E, R>, f: (m: Metadata<O, In>) => D.Input | I.Effect<D.Input, E2, R2>): Schedule<O, In, E | E2, R | R2>;
} = I.dual(2, (self: Schedule<any, any, any, any>, f: (m: any) => any) =>
  mapMeta(self, (m, fib) => {
    const d = f(m);
    return I.isEffect(d) && !D.isDuration(d) ? I.chain(I.exec(d, fib), (x) => ({ ...m, duration: D.fromInputUnsafe(x as D.Input) })) : { ...m, duration: D.fromInputUnsafe(d) };
  }));
export const addDelay: {
  <O, In, E2 = never, R2 = never>(f: (m: Metadata<O, In>) => D.Input | I.Effect<D.Input, E2, R2>): <E, R>(self: Schedule<O, In, E, R>) => Schedule<O, In, E | E2, R | R2>;
  <O, In, E, R, E2 = never, R2 = never>(self: Schedule<O, In, E, R>, f: (m: Metadata<O, In>) => D.Input | I.Effect<D.Input, E2, R2>): Schedule<O, In, E | E2, R | R2>;
} = I.dual(2, (self: Schedule<any, any, any, any>, f: (m: any) => any) =>
  modifyDelay(self, (m: Metadata<any, any>) => {
    const d = f(m);
    return I.isEffect(d) && !D.isDuration(d) ? I.make((fib) => I.chain(I.exec(d, fib), (x) => D.sum(m.duration, x as D.Input))) : D.sum(m.duration, d);
  }));
export const jittered = <O, In, E, R>(self: Schedule<O, In, E, R>): Schedule<O, In, E, R> =>
  modifyDelay(self, (m) => D.millis(m.duration.millis * (0.8 + Math.random() * 0.4))) as never;
export const tap: {
  <O, In, X, E2, R2>(f: (m: Metadata<O, In>) => I.Effect<X, E2, R2>): <E, R>(self: Schedule<O, In, E, R>) => Schedule<O, In, E | E2, R | R2>;
  <O, In, E, R, X, E2, R2>(self: Schedule<O, In, E, R>, f: (m: Metadata<O, In>) => I.Effect<X, E2, R2>): Schedule<O, In, E | E2, R | R2>;
} = I.dual(2, (self: Schedule<any, any, any, any>, f: (m: any) => I.Effect<any, any, any>) =>
  mapMeta(self, (m, fib) => I.chain(I.exec(f(m), fib), () => m)));
export const upTo: {
  (o: { readonly duration?: D.Input; readonly times?: number }): <O, In, E, R>(self: Schedule<O, In, E, R>) => Schedule<O, In, E, R>;
  <O, In, E, R>(self: Schedule<O, In, E, R>, o: { readonly duration?: D.Input; readonly times?: number }): Schedule<O, In, E, R>;
} = I.dual(2, (self: Schedule<any, any, any, any>, o: { duration?: D.Input; times?: number }) => {
  const maxMs = o.duration === undefined ? Infinity : D.toMillis(o.duration);
  const times = o.times ?? Infinity;
  return mapMeta(self, (m) => (m.attempt > times || m.elapsed >= maxMs ? undefined : m));
});
const while_: {
  <O, In, E2 = never, R2 = never>(pred: (m: Metadata<O, In>) => boolean | I.Effect<boolean, E2, R2>): <E, R>(self: Schedule<O, In, E, R>) => Schedule<O, In, E | E2, R | R2>;
  <O, In, E, R, E2 = never, R2 = never>(self: Schedule<O, In, E, R>, pred: (m: Metadata<O, In>) => boolean | I.Effect<boolean, E2, R2>): Schedule<O, In, E | E2, R | R2>;
} = I.dual(2, (self: Schedule<any, any, any, any>, pred: (m: any) => any) =>
  mapMeta(self, (m, fib) => {
    const r = pred(m);
    return typeof r === "boolean" ? (r ? m : undefined) : I.chain(I.exec(r, fib), (b) => (b ? m : undefined));
  }));
export { while_ as while };
const combine = (pick: (a: number, b: number) => number, needBoth: boolean) =>
  I.dual(2, (a: Schedule<any, any, any, any>, b: Schedule<any, any, any, any>) =>
    fromStepper(() => {
      const sa = a.start(), sb = b.start();
      return (input, fib) => I.chain(sa(input, fib), (ma) => I.chain(sb(input, fib), (mb) => {
        if (needBoth ? !ma || !mb : !ma && !mb) return undefined;
        if (!ma || !mb) return (ma ?? mb)!;
        return { ...ma, output: [ma.output, mb.output], duration: D.millis(pick(ma.duration.millis, mb.duration.millis)) };
      }));
    }));
/** Continue while both continue, using the longer delay. */
export const both: <O2, In2, E2, R2>(that: Schedule<O2, In2, E2, R2>) => <O, In, E, R>(self: Schedule<O, In, E, R>) => Schedule<[O, O2], In & In2, E | E2, R | R2> = combine(Math.max, true);
export const max = both;
/** Continue while either continues, using the shorter delay. */
export const either: <O2, In2, E2, R2>(that: Schedule<O2, In2, E2, R2>) => <O, In, E, R>(self: Schedule<O, In, E, R>) => Schedule<[O, O2], In & In2, E | E2, R | R2> = combine(Math.min, false);
export const min = either;
export const setInputType = <In>() => <O, E, R>(self: Schedule<O, any, E, R>): Schedule<O, In, E, R> => self;
export const concat: {
  <O2, In2, E2, R2>(that: Schedule<O2, In2, E2, R2>): <O, In, E, R>(self: Schedule<O, In, E, R>) => Schedule<O | O2, In & In2, E | E2, R | R2>;
  <O, In, E, R, O2, In2, E2, R2>(self: Schedule<O, In, E, R>, that: Schedule<O2, In2, E2, R2>): Schedule<O | O2, In & In2, E | E2, R | R2>;
} = I.dual(2, (a: Schedule<any, any, any, any>, b: Schedule<any, any, any, any>) =>
  fromStepper(() => {
    const sa = a.start();
    let sb: Stepper<any, any> | undefined;
    return (input, fib) => (sb ? sb(input, fib) : I.chain(sa(input, fib), (m) => m ?? (sb = b.start())(input, fib)));
  }));

/** Run the stepper and sleep for the computed delay; resolves to the metadata or undefined when done. */
export function stepAndSleep<O, In>(step: Stepper<O, In>, input: In, f: I.Fiber, sleep: (ms: number) => I.Effect<void>): I.Step<Metadata<O, In> | undefined> {
  return I.chain(step(input, f), (m) => {
    if (!m) return undefined;
    const ms = m.duration.millis;
    return ms > 0 ? I.chain(I.exec(sleep(ms), f), () => m) : m;
  });
}
