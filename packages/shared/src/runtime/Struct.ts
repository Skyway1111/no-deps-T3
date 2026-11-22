import { dual } from "./internal.ts";

export const keys = <S extends object>(s: S): Array<keyof S & string> => Object.keys(s) as never;
const keyList = (ks: ReadonlyArray<unknown>): ReadonlyArray<PropertyKey> => (ks.length === 1 && Array.isArray(ks[0]) ? ks[0] : ks) as ReadonlyArray<PropertyKey>;
export const pick: {
  <S extends object, const K extends ReadonlyArray<keyof S>>(keys: K): (s: S) => Pick<S, K[number]>;
  <S extends object, const K extends ReadonlyArray<keyof S>>(...keys: K): (s: S) => Pick<S, K[number]>;
} = (...args: ReadonlyArray<unknown>) => (s: any) => {
  const ks = keyList(args);
  const out: any = {};
  for (const k of ks) if (k in s) out[k] = s[k];
  return out;
};
export const omit: {
  <S extends object, const K extends ReadonlyArray<keyof S>>(keys: K): (s: S) => Omit<S, K[number]>;
  <S extends object, const K extends ReadonlyArray<keyof S>>(...keys: K): (s: S) => Omit<S, K[number]>;
} = (...args: ReadonlyArray<unknown>) => (s: any) => {
  const ks = keyList(args);
  const out: any = { ...s };
  for (const k of ks) delete out[k];
  return out;
};
export const assign: {
  <O extends object>(that: O): <S extends object>(self: S) => Omit<S, keyof O> & O;
  <S extends object, O extends object>(self: S, that: O): Omit<S, keyof O> & O;
} = dual(2, (self: object, that: object) => ({ ...self, ...that }));
export interface Lambda {
  readonly "~lambda.in": unknown;
  readonly "~lambda.out": unknown;
}
export type Apply<L extends Lambda, V> = (L & { readonly "~lambda.in": V })["~lambda.out"];
export const lambda = <L extends (a: any) => any>(f: L): L & Lambda => f as never;
export const map: {
  <L extends Lambda>(f: L): <S extends object>(self: S) => { [K in keyof S]: Apply<L, S[K]> };
  <S extends object, L extends Lambda>(self: S, f: L): { [K in keyof S]: Apply<L, S[K]> };
} = dual(2, (self: Record<string, unknown>, f: any) => {
  const out: Record<string, unknown> = {};
  for (const k in self) out[k] = f(self[k]);
  return out;
});
export const evolve: {
  <S extends object, F extends { readonly [K in keyof S]?: (a: S[K]) => unknown }>(f: F): (self: S) => { [K in keyof S]: K extends keyof F ? F[K] extends (a: any) => infer B ? B : S[K] : S[K] };
} = ((f: Record<string, (a: unknown) => unknown>) => (self: any) => {
  const out: any = { ...self };
  for (const k in f) if (k in self) out[k] = f[k]!(self[k]);
  return out;
}) as never;
export const get = <K extends PropertyKey>(k: K) => <S extends { [P in K]?: unknown }>(s: S): S[K] => s[k];
