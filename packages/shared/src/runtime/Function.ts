import { dual, pipeArgs } from "./internal.ts";

export { dual };
export type LazyArg<A> = () => A;
export const identity = <A>(a: A): A => a;
export const constant = <A>(a: A): LazyArg<A> => () => a;
export const constVoid: LazyArg<void> = () => undefined;
export const constUndefined: LazyArg<undefined> = () => undefined;
export const constNull: LazyArg<null> = () => null;
export const constTrue: LazyArg<boolean> = () => true;
export const constFalse: LazyArg<boolean> = () => false;
export const cast = <A, B>(a: A): B => a as unknown as B;
export const absurd = <A>(_: never): A => {
  throw new Error("Called `absurd` function which should be uncallable");
};
export const tupled = <A extends ReadonlyArray<unknown>, B>(f: (...a: A) => B) => (a: A): B => f(...a);
export const untupled = <A extends ReadonlyArray<unknown>, B>(f: (a: A) => B) => (...a: A): B => f(a);
export const flip = <A extends Array<unknown>, B extends Array<unknown>, C>(f: (...a: A) => (...b: B) => C) => (...b: B) => (...a: A): C => f(...a)(...b);
export const memoize = <A, B>(f: (a: A) => B): ((a: A) => B) => {
  const m = new Map<A, B>();
  return (a) => {
    if (!m.has(a)) m.set(a, f(a));
    return m.get(a)!;
  };
};
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
export function pipe<A, B, C, D, E>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E;
export function pipe<A, B, C, D, E, F>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): F;
export function pipe<A, B, C, D, E, F, G>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G): G;
export function pipe<A, B, C, D, E, F, G, H>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H): H;
export function pipe<A, B, C, D, E, F, G, H, I>(a: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H, hi: (h: H) => I): I;
export function pipe(a: unknown, ...fns: ReadonlyArray<Function>): unknown;
export function pipe(a: unknown): unknown {
  return pipeArgs(a, Array.prototype.slice.call(arguments, 1));
}
export function flow<A extends ReadonlyArray<unknown>, B>(ab: (...a: A) => B): (...a: A) => B;
export function flow<A extends ReadonlyArray<unknown>, B, C>(ab: (...a: A) => B, bc: (b: B) => C): (...a: A) => C;
export function flow<A extends ReadonlyArray<unknown>, B, C, D>(ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D): (...a: A) => D;
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E>(ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): (...a: A) => E;
export function flow<A extends ReadonlyArray<unknown>, B, C, D, E, F>(ab: (...a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): (...a: A) => F;
export function flow(first: Function, ...rest: ReadonlyArray<Function>): Function {
  return (...args: Array<unknown>) => pipeArgs(first(...args), rest);
}
export const hole: <T>() => T = () => {
  throw new Error("Hole");
};
