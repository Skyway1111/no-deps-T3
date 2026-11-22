export type Order<in A> = (self: A, that: A) => -1 | 0 | 1;
export const make = <A>(compare: (self: A, that: A) => -1 | 0 | 1): Order<A> => (a, b) => (a === b ? 0 : compare(a, b));
export const String: Order<string> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const Number: Order<number> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const BigInt: Order<bigint> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const Boolean: Order<boolean> = (a, b) => (a === b ? 0 : a ? 1 : -1);
export const Date: Order<Date> = (a, b) => Number(a.getTime(), b.getTime());
export const flip = <A>(o: Order<A>): Order<A> => (a, b) => o(b, a);
export const mapInput: {
  <B, A>(f: (b: B) => A): (self: Order<A>) => Order<B>;
  <A, B>(self: Order<A>, f: (b: B) => A): Order<B>;
} = function (this: unknown): any {
  if (arguments.length === 1) {
    const f = arguments[0];
    return (o: Order<any>) => (a: any, b: any) => o(f(a), f(b));
  }
  const [o, f] = arguments;
  return (a: any, b: any) => o(f(a), f(b));
} as never;
export const combine: { <A>(that: Order<A>): (self: Order<A>) => Order<A>; <A>(self: Order<A>, that: Order<A>): Order<A> } = function (this: unknown): any {
  if (arguments.length === 1) {
    const that = arguments[0];
    return (self: Order<any>) => (a: any, b: any) => self(a, b) || that(a, b);
  }
  const [self, that] = arguments;
  return (a: any, b: any) => self(a, b) || that(a, b);
} as never;
export const combineAll = <A>(orders: Iterable<Order<A>>): Order<A> => {
  const os = [...orders];
  return (a, b) => {
    for (const o of os) {
      const r = o(a, b);
      if (r) return r;
    }
    return 0;
  };
};
export const Struct = <R extends { readonly [x: string]: Order<any> }>(fields: R): Order<{ readonly [K in keyof R]: R[K] extends Order<infer A> ? A : never }> => {
  const ks = Object.keys(fields);
  return (a, b) => {
    for (const k of ks) {
      const r = fields[k]!((a as any)[k], (b as any)[k]);
      if (r) return r;
    }
    return 0;
  };
};
export const Tuple = <T extends ReadonlyArray<Order<any>>>(...os: T): Order<{ readonly [K in keyof T]: T[K] extends Order<infer A> ? A : never }> => (a, b) => {
  for (let i = 0; i < os.length; i++) {
    const r = os[i]!((a as any)[i], (b as any)[i]);
    if (r) return r;
  }
  return 0;
};
export const Array = <A>(o: Order<A>): Order<ReadonlyArray<A>> => (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const r = o(a[i]!, b[i]!);
    if (r) return r;
  }
  return Number(a.length, b.length);
};
export const lessThan = <A>(o: Order<A>) => (a: A, b: A) => o(a, b) === -1;
export const greaterThan = <A>(o: Order<A>) => (a: A, b: A) => o(a, b) === 1;
export const lessThanOrEqualTo = <A>(o: Order<A>) => (a: A, b: A) => o(a, b) !== 1;
export const greaterThanOrEqualTo = <A>(o: Order<A>) => (a: A, b: A) => o(a, b) !== -1;
export const min = <A>(o: Order<A>) => (a: A, b: A) => (o(a, b) === 1 ? b : a);
export const max = <A>(o: Order<A>) => (a: A, b: A) => (o(a, b) === -1 ? b : a);
export const clamp = <A>(o: Order<A>) => (a: A, opts: { minimum: A; maximum: A }) => min(o)(opts.maximum, max(o)(opts.minimum, a));
export const between = <A>(o: Order<A>) => (a: A, opts: { minimum: A; maximum: A }) => o(a, opts.minimum) !== -1 && o(a, opts.maximum) !== 1;
