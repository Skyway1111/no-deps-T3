export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
export type DeepMutable<T> = T extends ReadonlyMap<infer K, infer V> ? Map<DeepMutable<K>, DeepMutable<V>>
  : T extends ReadonlySet<infer V> ? Set<DeepMutable<V>>
  : T extends string | number | boolean | bigint | symbol | Function ? T
  : { -readonly [K in keyof T]: DeepMutable<T[K]> };
export type Simplify<A> = { [K in keyof A]: A[K] } extends infer B ? B : never;
export type NoInfer<A> = [A][A extends any ? 0 : never];
export type Tags<E> = E extends { _tag: string } ? E["_tag"] : never;
export type ExtractTag<E, K extends string> = Extract<E, { _tag: K }>;
export type ExcludeTag<E, K extends string> = Exclude<E, { _tag: K }>;
export type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (x: infer R) => any ? R : never;
export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
export type Covariant<A> = (_: never) => A;
export type Contravariant<A> = (_: A) => void;
export type Invariant<A> = (_: A) => A;
declare const unassignedSymbol: unique symbol;
export type unassigned = typeof unassignedSymbol;
declare const unhandledSymbol: unique symbol;
export type unhandled = typeof unhandledSymbol;
export type Concurrency = number | "unbounded" | "inherit";
export type MergeLeft<K, H> = Simplify<{ [k in keyof K | keyof H]: k extends keyof K ? K[k] : k extends keyof H ? H[k] : never }>;
export type MergeRight<K, H> = MergeLeft<H, K>;
