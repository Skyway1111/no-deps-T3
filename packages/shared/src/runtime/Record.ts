import { dual } from "./internal.ts";
import * as O from "./Option.ts";

export type ReadonlyRecord<K extends string | symbol, A> = { readonly [P in K]: A };
export const empty = <K extends string = never, A = never>(): Record<K, A> => ({}) as Record<K, A>;
export const keys = <K extends string, A>(r: ReadonlyRecord<K, A>): Array<K> => Object.keys(r) as Array<K>;
export const values = <K extends string, A>(r: ReadonlyRecord<K, A>): Array<A> => Object.values(r);
export const toEntries = <K extends string, A>(r: ReadonlyRecord<K, A>): Array<[K, A]> => Object.entries(r) as Array<[K, A]>;
export const fromEntries = <K extends string, A>(es: Iterable<readonly [K, A]>): Record<K, A> => Object.fromEntries(es) as Record<K, A>;
export const size = (r: object) => Object.keys(r).length;
export const isEmptyRecord = (r: object) => size(r) === 0;
export const has: { <K extends string>(k: K): (r: object) => boolean; (r: object, k: string): boolean } = dual(2, (r: object, k: string) => Object.hasOwn(r, k));
export const get: { <K extends string>(k: K): <A>(r: ReadonlyRecord<string, A>) => O.Option<A>; <A>(r: ReadonlyRecord<string, A>, k: string): O.Option<A> } =
  dual(2, (r: Record<string, unknown>, k: string) => (Object.hasOwn(r, k) ? O.some(r[k]) : O.none()));
export const map: {
  <K extends string, A, B>(f: (a: A, k: K) => B): (r: ReadonlyRecord<K, A>) => Record<K, B>;
  <K extends string, A, B>(r: ReadonlyRecord<K, A>, f: (a: A, k: K) => B): Record<K, B>;
} = dual(2, (r: Record<string, unknown>, f: (a: unknown, k: string) => unknown) => {
  const out: Record<string, unknown> = {};
  for (const k in r) out[k] = f(r[k], k);
  return out;
});
export const filter: {
  <K extends string, A>(f: (a: A, k: K) => boolean): (r: ReadonlyRecord<K, A>) => Record<string, A>;
  <K extends string, A>(r: ReadonlyRecord<K, A>, f: (a: A, k: K) => boolean): Record<string, A>;
} = dual(2, (r: Record<string, unknown>, f: (a: unknown, k: string) => boolean) => {
  const out: Record<string, unknown> = {};
  for (const k in r) if (f(r[k], k)) out[k] = r[k];
  return out;
});
export const filterMap: {
  <K extends string, A, B>(f: (a: A, k: K) => O.Option<B>): (r: ReadonlyRecord<K, A>) => Record<string, B>;
  <K extends string, A, B>(r: ReadonlyRecord<K, A>, f: (a: A, k: K) => O.Option<B>): Record<string, B>;
} = dual(2, (r: Record<string, unknown>, f: (a: unknown, k: string) => O.Option<unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k in r) {
    const o = f(r[k], k);
    if (o._tag === "Some") out[k] = o.value;
  }
  return out;
});
export const set: { <K extends string, A>(k: K, a: A): (r: ReadonlyRecord<string, A>) => Record<string, A>; <A>(r: ReadonlyRecord<string, A>, k: string, a: A): Record<string, A> } =
  dual(3, (r: object, k: string, a: unknown) => ({ ...r, [k]: a }));
export const remove: { (k: string): <A>(r: ReadonlyRecord<string, A>) => Record<string, A>; <A>(r: ReadonlyRecord<string, A>, k: string): Record<string, A> } =
  dual(2, (r: Record<string, unknown>, k: string) => {
    const { [k]: _, ...rest } = r;
    return rest;
  });
export const collect: {
  <K extends string, A, B>(f: (k: K, a: A) => B): (r: ReadonlyRecord<K, A>) => Array<B>;
  <K extends string, A, B>(r: ReadonlyRecord<K, A>, f: (k: K, a: A) => B): Array<B>;
} = dual(2, (r: Record<string, unknown>, f: (k: string, a: unknown) => unknown) => Object.keys(r).map((k) => f(k, r[k])));
export const reduce: {
  <Z, V, K extends string>(z: Z, f: (acc: Z, v: V, k: K) => Z): (r: ReadonlyRecord<K, V>) => Z;
  <K extends string, V, Z>(r: ReadonlyRecord<K, V>, z: Z, f: (acc: Z, v: V, k: K) => Z): Z;
} = dual(3, (r: Record<string, unknown>, z: unknown, f: (acc: unknown, v: unknown, k: string) => unknown) => Object.keys(r).reduce((acc, k) => f(acc, r[k], k), z));
