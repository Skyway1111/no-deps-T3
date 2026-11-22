import { dual } from "./internal.ts";
import * as O from "./Option.ts";
import type { Order } from "./Order.ts";

export type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>];
export type NonEmptyArray<A> = [A, ...Array<A>];
export const isArray = Array.isArray as (u: unknown) => u is ReadonlyArray<unknown>;
export const isArrayNonEmpty = <A>(as: Array<A>): as is NonEmptyArray<A> => as.length > 0;
export const isReadonlyArrayNonEmpty = <A>(as: ReadonlyArray<A>): as is NonEmptyReadonlyArray<A> => as.length > 0;
export const isArrayEmpty = <A>(as: Array<A>): as is [] => as.length === 0;
export const empty = <A = never>(): Array<A> => [];
export const of = <A>(a: A): NonEmptyArray<A> => [a];
export const make = <const As extends NonEmptyReadonlyArray<any>>(...as: As): NonEmptyArray<As[number]> => as as never;
export const makeBy: { (f: (i: number) => any): (n: number) => any; <A>(n: number, f: (i: number) => A): NonEmptyArray<A> } =
  dual(2, (n: number, f: (i: number) => unknown) => Array.from({ length: Math.max(1, Math.floor(n)) }, (_, i) => f(i)));
export const range = (start: number, end: number): NonEmptyArray<number> => (start <= end ? makeBy(end - start + 1, (i) => start + i) : [start]);
export const replicate: { (n: number): <A>(a: A) => NonEmptyArray<A>; <A>(a: A, n: number): NonEmptyArray<A> } = dual(2, (a: unknown, n: number) => makeBy(n, () => a));
export const fromIterable = <A>(it: Iterable<A>): Array<A> => (Array.isArray(it) ? it : Array.from(it));
export const ensure = <A>(a: A | ReadonlyArray<A>): Array<A> => (Array.isArray(a) ? (a as Array<A>) : [a as A]);
export const head = <A>(as: ReadonlyArray<A>): O.Option<A> => (as.length ? O.some(as[0]!) : O.none());
export const headNonEmpty = <A>(as: NonEmptyReadonlyArray<A>): A => as[0];
export const last = <A>(as: ReadonlyArray<A>): O.Option<A> => (as.length ? O.some(as[as.length - 1]!) : O.none());
export const lastNonEmpty = <A>(as: NonEmptyReadonlyArray<A>): A => as[as.length - 1]!;
export const tail = <A>(as: ReadonlyArray<A>): O.Option<Array<A>> => (as.length ? O.some(as.slice(1)) : O.none());
export const init = <A>(as: ReadonlyArray<A>): O.Option<Array<A>> => (as.length ? O.some(as.slice(0, -1)) : O.none());
export const get: { (i: number): <A>(as: ReadonlyArray<A>) => O.Option<A>; <A>(as: ReadonlyArray<A>, i: number): O.Option<A> } =
  dual(2, (as: ReadonlyArray<unknown>, i: number) => (i >= 0 && i < as.length ? O.some(as[i]) : O.none()));
export const append: { <B>(b: B): <A>(as: Iterable<A>) => NonEmptyArray<A | B>; <A, B>(as: Iterable<A>, b: B): NonEmptyArray<A | B> } =
  dual(2, (as: Iterable<unknown>, b: unknown) => [...as, b]);
export const prepend: { <B>(b: B): <A>(as: Iterable<A>) => NonEmptyArray<A | B>; <A, B>(as: Iterable<A>, b: B): NonEmptyArray<A | B> } =
  dual(2, (as: Iterable<unknown>, b: unknown) => [b, ...as]);
export const appendAll: { <B>(bs: Iterable<B>): <A>(as: Iterable<A>) => Array<A | B>; <A, B>(as: Iterable<A>, bs: Iterable<B>): Array<A | B> } =
  dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => [...as, ...bs]);
export const prependAll: { <B>(bs: Iterable<B>): <A>(as: Iterable<A>) => Array<A | B>; <A, B>(as: Iterable<A>, bs: Iterable<B>): Array<A | B> } =
  dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => [...bs, ...as]);
export const map: {
  <S extends ReadonlyArray<any>, B>(f: (a: S[number], i: number) => B): (as: S) => S extends NonEmptyReadonlyArray<any> ? NonEmptyArray<B> : Array<B>;
  <S extends ReadonlyArray<any>, B>(as: S, f: (a: S[number], i: number) => B): S extends NonEmptyReadonlyArray<any> ? NonEmptyArray<B> : Array<B>;
} = dual(2, (as: ReadonlyArray<unknown>, f: (a: unknown, i: number) => unknown) => as.map(f));
export const flatMap: {
  <A, B>(f: (a: A, i: number) => ReadonlyArray<B>): (as: ReadonlyArray<A>) => Array<B>;
  <A, B>(as: ReadonlyArray<A>, f: (a: A, i: number) => ReadonlyArray<B>): Array<B>;
} = dual(2, (as: ReadonlyArray<unknown>, f: (a: unknown, i: number) => ReadonlyArray<unknown>) => as.flatMap(f));
export const flatten = <A>(as: ReadonlyArray<ReadonlyArray<A>>): Array<A> => as.flat() as Array<A>;
export const filter: {
  <A, B extends A>(f: (a: A, i: number) => a is B): (as: Iterable<A>) => Array<B>;
  <A>(f: (a: NoInfer<A>, i: number) => boolean): (as: Iterable<A>) => Array<A>;
  <A, B extends A>(as: Iterable<A>, f: (a: A, i: number) => a is B): Array<B>;
  <A>(as: Iterable<A>, f: (a: A, i: number) => boolean): Array<A>;
} = dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => boolean) => fromIterable(as).filter(f));
export const filterMap: {
  <A, B>(f: (a: A, i: number) => O.Option<B>): (as: Iterable<A>) => Array<B>;
  <A, B>(as: Iterable<A>, f: (a: A, i: number) => O.Option<B>): Array<B>;
} = dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => O.Option<unknown>) => {
  const out: Array<unknown> = [];
  let i = 0;
  for (const a of as) {
    const o = f(a, i++);
    if (o._tag === "Some") out.push(o.value);
  }
  return out;
});
export const getSomes = <A>(as: Iterable<O.Option<A>>): Array<A> => filterMap(as, (o) => o);
export const partition: {
  <A>(f: (a: A, i: number) => boolean): (as: Iterable<A>) => [excluded: Array<A>, satisfying: Array<A>];
  <A>(as: Iterable<A>, f: (a: A, i: number) => boolean): [excluded: Array<A>, satisfying: Array<A>];
} = dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => boolean) => {
  const l: Array<unknown> = [], r: Array<unknown> = [];
  let i = 0;
  for (const a of as) (f(a, i++) ? r : l).push(a);
  return [l, r];
});
export const sort: {
  <B>(o: Order<B>): <A extends B, S extends Iterable<A>>(as: S) => S extends NonEmptyReadonlyArray<A> ? NonEmptyArray<A> : Array<A>;
  <A extends B, B>(as: Iterable<A>, o: Order<B>): Array<A>;
} = dual(2, (as: Iterable<unknown>, o: Order<unknown>) => [...as].sort(o));
export const sortBy = <A>(...orders: ReadonlyArray<Order<A>>) => (as: Iterable<A>): Array<A> =>
  [...as].sort((a, b) => {
    for (const o of orders) {
      const r = o(a, b);
      if (r) return r;
    }
    return 0;
  });
export const reverse = <A>(as: Iterable<A>): Array<A> => [...as].reverse();
export const take: { (n: number): <A>(as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, n: number): Array<A> } = dual(2, (as: Iterable<unknown>, n: number) => fromIterable(as).slice(0, Math.max(0, n)));
export const takeRight: { (n: number): <A>(as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, n: number): Array<A> } = dual(2, (as: Iterable<unknown>, n: number) => (n <= 0 ? [] : fromIterable(as).slice(-n)));
export const drop: { (n: number): <A>(as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, n: number): Array<A> } = dual(2, (as: Iterable<unknown>, n: number) => fromIterable(as).slice(Math.max(0, n)));
export const dropRight: { (n: number): <A>(as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, n: number): Array<A> } = dual(2, (as: Iterable<unknown>, n: number) => fromIterable(as).slice(0, Math.max(0, fromIterable(as).length - n)));
export const chunksOf: { (n: number): <A>(as: Iterable<A>) => Array<NonEmptyArray<A>>; <A>(as: Iterable<A>, n: number): Array<NonEmptyArray<A>> } =
  dual(2, (as: Iterable<unknown>, n: number) => {
    const arr = fromIterable(as);
    const out: Array<Array<unknown>> = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  });
export const groupBy: {
  <A, K extends string | symbol>(f: (a: A) => K): (as: Iterable<A>) => Record<K, NonEmptyArray<A>>;
  <A, K extends string | symbol>(as: Iterable<A>, f: (a: A) => K): Record<K, NonEmptyArray<A>>;
} = dual(2, (as: Iterable<unknown>, f: (a: unknown) => string) => {
  const out: Record<string, Array<unknown>> = {};
  for (const a of as) (out[f(a)] ??= []).push(a);
  return out;
});
export const dedupe = <A>(as: Iterable<A>): Array<A> => [...new Set(as)];
export const dedupeWith: { <A>(eq: (a: A, b: A) => boolean): (as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, eq: (a: A, b: A) => boolean): Array<A> } =
  dual(2, (as: Iterable<unknown>, eq: (a: unknown, b: unknown) => boolean) => {
    const out: Array<unknown> = [];
    for (const a of as) if (!out.some((b) => eq(a, b))) out.push(a);
    return out;
  });
export const findFirst: {
  <A, B extends A>(f: (a: A, i: number) => a is B): (as: Iterable<A>) => O.Option<B>;
  <A>(f: (a: NoInfer<A>, i: number) => boolean): (as: Iterable<A>) => O.Option<A>;
  <A, B extends A>(as: Iterable<A>, f: (a: A, i: number) => a is B): O.Option<B>;
  <A>(as: Iterable<A>, f: (a: A, i: number) => boolean): O.Option<A>;
} = dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => boolean) => {
  let i = 0;
  for (const a of as) if (f(a, i++)) return O.some(a);
  return O.none();
});
export const findLast: {
  <A>(f: (a: NoInfer<A>, i: number) => boolean): (as: Iterable<A>) => O.Option<A>;
  <A>(as: Iterable<A>, f: (a: A, i: number) => boolean): O.Option<A>;
} = dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => boolean) => {
  const arr = fromIterable(as);
  for (let i = arr.length - 1; i >= 0; i--) if (f(arr[i], i)) return O.some(arr[i]);
  return O.none();
});
export const findFirstIndex: { <A>(f: (a: A, i: number) => boolean): (as: Iterable<A>) => O.Option<number>; <A>(as: Iterable<A>, f: (a: A, i: number) => boolean): O.Option<number> } =
  dual(2, (as: Iterable<unknown>, f: (a: unknown, i: number) => boolean) => {
    const i = fromIterable(as).findIndex(f);
    return i < 0 ? O.none() : O.some(i);
  });
export const contains: { <A>(a: A): (as: Iterable<A>) => boolean; <A>(as: Iterable<A>, a: A): boolean } = dual(2, (as: Iterable<unknown>, a: unknown) => fromIterable(as).includes(a));
export const some: { <A>(f: (a: A, i: number) => boolean): (as: ReadonlyArray<A>) => boolean; <A>(as: ReadonlyArray<A>, f: (a: A, i: number) => boolean): boolean } = dual(2, (as: ReadonlyArray<unknown>, f: (a: unknown, i: number) => boolean) => as.some(f));
export const every: { <A>(f: (a: A, i: number) => boolean): (as: ReadonlyArray<A>) => boolean; <A>(as: ReadonlyArray<A>, f: (a: A, i: number) => boolean): boolean } = dual(2, (as: ReadonlyArray<unknown>, f: (a: unknown, i: number) => boolean) => as.every(f));
export const reduce: { <B, A>(b: B, f: (b: B, a: A, i: number) => B): (as: Iterable<A>) => B; <A, B>(as: Iterable<A>, b: B, f: (b: B, a: A, i: number) => B): B } =
  dual(3, (as: Iterable<unknown>, b: unknown, f: (b: unknown, a: unknown, i: number) => unknown) => fromIterable(as).reduce(f, b));
export const join: { (sep: string): (as: Iterable<string>) => string; (as: Iterable<string>, sep: string): string } = dual(2, (as: Iterable<string>, sep: string) => fromIterable(as).join(sep));
export const zip: { <B>(bs: Iterable<B>): <A>(as: Iterable<A>) => Array<[A, B]>; <A, B>(as: Iterable<A>, bs: Iterable<B>): Array<[A, B]> } =
  dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => {
    const a = fromIterable(as), b = fromIterable(bs);
    return a.slice(0, Math.min(a.length, b.length)).map((x, i) => [x, b[i]]);
  });
export const length = <A>(as: ReadonlyArray<A>) => as.length;
export const isEmptyReadonlyArray = <A>(as: ReadonlyArray<A>): as is readonly [] => as.length === 0;
export const intersperse: { <B>(b: B): <A>(as: Iterable<A>) => Array<A | B>; <A, B>(as: Iterable<A>, b: B): Array<A | B> } =
  dual(2, (as: Iterable<unknown>, b: unknown) => fromIterable(as).flatMap((a, i) => (i ? [b, a] : [a])));
export const union: { <B>(bs: Iterable<B>): <A>(as: Iterable<A>) => Array<A | B>; <A, B>(as: Iterable<A>, bs: Iterable<B>): Array<A | B> } = dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => [...new Set([...as, ...bs])]);
export const intersection: { <A>(bs: Iterable<A>): (as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, bs: Iterable<A>): Array<A> } = dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => {
  const s = new Set(bs);
  return fromIterable(as).filter((a) => s.has(a));
});
export const difference: { <A>(bs: Iterable<A>): (as: Iterable<A>) => Array<A>; <A>(as: Iterable<A>, bs: Iterable<A>): Array<A> } = dual(2, (as: Iterable<unknown>, bs: Iterable<unknown>) => {
  const s = new Set(bs);
  return fromIterable(as).filter((a) => !s.has(a));
});
export const match: {
  <A, B, C = B>(o: { onEmpty: () => B; onNonEmpty: (as: NonEmptyReadonlyArray<A>) => C }): (as: ReadonlyArray<A>) => B | C;
  <A, B, C = B>(as: ReadonlyArray<A>, o: { onEmpty: () => B; onNonEmpty: (as: NonEmptyReadonlyArray<A>) => C }): B | C;
} = dual(2, (as: ReadonlyArray<unknown>, o: any) => (as.length ? o.onNonEmpty(as) : o.onEmpty()));
export const max = <A>(o: Order<A>) => (as: NonEmptyReadonlyArray<A>): A => as.reduce((a, b) => (o(a, b) === -1 ? b : a));
export const min = <A>(o: Order<A>) => (as: NonEmptyReadonlyArray<A>): A => as.reduce((a, b) => (o(a, b) === 1 ? b : a));
