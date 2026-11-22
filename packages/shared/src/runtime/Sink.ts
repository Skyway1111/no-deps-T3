import * as I from "./internal.ts";
import type { RawPull } from "./Stream.ts";
import * as O from "./Option.ts";
import { isDone } from "./errors.ts";

export const TypeId: unique symbol = Symbol.for("effect/Sink") as never;
/** A sink consumes a pull until it is satisfied or the pull ends. */
export interface Sink<out A, in In = unknown, out L = never, out E = never, out R = never> extends I.Pipeable {
  readonly [TypeId]: { _A: (_: never) => A; _In: (_: In) => void; _L: (_: never) => L; _E: (_: never) => E; _R: (_: never) => R };
  readonly consume: (pull: RawPull<any>, f: I.Fiber) => I.Step<any>;
}
const proto = { [TypeId]: {}, ...I.PipeProto };
export const make = <A, In, E = never, R = never>(consume: (pull: RawPull<In>, f: I.Fiber) => I.Step<A>): Sink<A, In, never, E, R> =>
  Object.assign(Object.create(proto), { consume });
const isEnd = (e: unknown) => e instanceof I.Failure && e.cause.reasons.length === 1 && e.cause.reasons[0]!._tag === "Fail" && isDone((e.cause.reasons[0] as I.Fail<unknown>).error);
/** Feed chunks to `step` until it returns false or the pull ends. */
const loop = <In>(pull: RawPull<In>, f: I.Fiber, step: (c: ReadonlyArray<In>) => I.Step<boolean | void>): I.Step<void> => {
  const go = (): I.Step<void> =>
    I.settle(() => pull(f), (c) => I.chain(step(c), (more) => (more === false ? undefined : go())), (e) => (isEnd(e) ? undefined : I.failWith(I.toCause(e))));
  return go();
};
export const drain: Sink<void, unknown> = make((pull, f) => loop(pull, f, () => true));
export const forEach = <In, X, E, R>(g: (a: In) => I.Effect<X, E, R>): Sink<void, In, never, E, R> =>
  make((pull: RawPull<In>, f) => loop(pull, f, (c) => {
    let i = 0;
    const go = (): I.Step<boolean> => (i < c.length ? I.chain(I.exec(g(c[i++]!), f), go) : true);
    return go();
  }));
export const forEachArray = <In, X, E, R>(g: (as: ReadonlyArray<In>) => I.Effect<X, E, R>): Sink<void, In, never, E, R> =>
  make((pull: RawPull<In>, f) => loop(pull, f, (c) => I.chain(I.exec(g(c), f), () => true)));
export const collectAll = <In>(): Sink<Array<In>, In> =>
  make((pull: RawPull<In>, f) => {
    const out: Array<In> = [];
    return I.chain(loop(pull, f, (c) => void out.push(...c)), () => out);
  });
export const head = <In>(): Sink<O.Option<In>, In> =>
  make((pull: RawPull<In>, f) => {
    let h: O.Option<In> = O.none();
    return I.chain(loop(pull, f, (c) => ((h = O.some(c[0]!)), false)), () => h);
  });
export const last = <In>(): Sink<O.Option<In>, In> =>
  make((pull: RawPull<In>, f) => {
    let l: O.Option<In> = O.none();
    return I.chain(loop(pull, f, (c) => void (l = O.some(c[c.length - 1]!))), () => l);
  });
export const count: Sink<number, unknown> = make((pull, f) => {
  let n = 0;
  return I.chain(loop(pull, f, (c) => void (n += c.length)), () => n);
});
export const fold = <S, In>(s: S, cont: (s: S) => boolean, g: (s: S, a: In) => S): Sink<S, In> =>
  make((pull: RawPull<In>, f) => {
    let acc = s;
    return I.chain(loop(pull, f, (c) => {
      for (const a of c) {
        if (!cont(acc)) return false;
        acc = g(acc, a);
      }
      return cont(acc);
    }), () => acc);
  });
export const mapInput: {
  <In0, In>(f: (a: In0) => In): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E, R>;
  <A, In, L, E, R, In0>(self: Sink<A, In, L, E, R>, f: (a: In0) => In): Sink<A, In0, L, E, R>;
} = I.dual(2, (self: Sink<any, any, any, any, any>, g: (a: any) => any) =>
  make((pull: RawPull<any>, f) => self.consume((f2) => I.chain(pull(f2), (c) => c.map(g)), f)));
export const mapInputEffect: {
  <In0, In, E2, R2>(f: (a: In0) => I.Effect<In, E2, R2>): <A, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In0, L, E | E2, R | R2>;
  <A, In, L, E, R, In0, E2, R2>(self: Sink<A, In, L, E, R>, f: (a: In0) => I.Effect<In, E2, R2>): Sink<A, In0, L, E | E2, R | R2>;
} = I.dual(2, (self: Sink<any, any, any, any, any>, g: (a: any) => I.Effect<any, any, any>) =>
  make((pull: RawPull<any>, f) => self.consume((f2) => I.chain(pull(f2), (c) => {
    const out: Array<any> = [];
    let i = 0;
    const go = (): I.Step<Array<any>> => (i < c.length ? I.chain(I.exec(g(c[i++]), f2), (b) => (out.push(b), go())) : out);
    return go();
  }), f)));
export const map: {
  <A, B>(f: (a: A) => B): <In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<B, In, L, E, R>;
  <A, In, L, E, R, B>(self: Sink<A, In, L, E, R>, f: (a: A) => B): Sink<B, In, L, E, R>;
} = I.dual(2, (self: Sink<any, any, any, any, any>, g: (a: any) => any) => make((pull, f) => I.chain(self.consume(pull, f), g)));
export const ensuring: {
  <X, R2>(finalizer: I.Effect<X, never, R2>): <A, In, L, E, R>(self: Sink<A, In, L, E, R>) => Sink<A, In, L, E, R | R2>;
  <A, In, L, E, R, X, R2>(self: Sink<A, In, L, E, R>, finalizer: I.Effect<X, never, R2>): Sink<A, In, L, E, R | R2>;
} = I.dual(2, (self: Sink<any, any, any, any, any>, fin: I.Effect<any>) =>
  make((pull, f) => I.settle(() => self.consume(pull, f), (a) => I.chain(I.exec(fin, f), () => a), (e) => I.chain(I.exec(fin, f), () => I.failWith(I.toCause(e))))));
export const succeed = <A>(a: A): Sink<A, unknown> => make(() => a);
export const fromEffect = <A, E, R>(eff: I.Effect<A, E, R>): Sink<A, unknown, never, E, R> => make((_, f) => I.exec(eff, f));
