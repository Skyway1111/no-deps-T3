export const BrandTypeId: unique symbol = Symbol.for("effect/Brand") as never;
export interface Brand<in out K extends string | symbol> {
  readonly [BrandTypeId]: { readonly [k in K]: K };
}
export declare namespace Brand {
  type Unbranded<P> = P extends infer Q & Brands<P> ? Q : P;
  type Brands<P> = P extends Brand<any> ? Brand.UnionToIntersection<{ [k in keyof P[typeof BrandTypeId]]: k extends string | symbol ? Brand<k> : never }[keyof P[typeof BrandTypeId]]> : never;
  type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (x: infer R) => any ? R : never;
  interface Constructor<in out A extends Brand<any>> {
    (args: Brand.Unbranded<A>): A;
    is(a: Brand.Unbranded<A>): a is Brand.Unbranded<A> & A;
  }
}
export type Branded<A, K extends string | symbol> = A & Brand<K>;
export const nominal = <A extends Brand<any>>(): Brand.Constructor<A> => Object.assign((a: unknown) => a as A, { is: (_: unknown): _ is never => true }) as never;
export const check = <A extends Brand<any>>(...preds: ReadonlyArray<(a: Brand.Unbranded<A>) => boolean>): Brand.Constructor<A> =>
  Object.assign(
    (a: Brand.Unbranded<A>) => {
      if (!preds.every((p) => p(a))) throw new Error(`Brand check failed for ${String(a)}`);
      return a as unknown as A;
    },
    { is: (a: Brand.Unbranded<A>) => preds.every((p) => p(a)) },
  ) as never;
