import * as I from "./internal.ts";
import * as O from "./Option.ts";

export type Context<S> = I.Context<S>;
export type Key<Id, Shape> = I.Key<Id, Shape>;
export interface Service<in out Id, in out Shape> extends I.Key<Id, Shape> {
  of(this: void, self: Shape): Shape;
  context(self: Shape): Context<Id>;
  use<A, E, R>(f: (service: Shape) => I.Effect<A, E, R>): I.Effect<A, E, R | Id>;
  useSync<A>(f: (service: Shape) => A): I.Effect<A, never, Id>;
}
export interface ServiceClass<in out Self, in out Identifier extends string, in out Shape> extends Service<Self, Shape> {
  new (_: never): { readonly key: Identifier; readonly Service: Shape };
  readonly key: Identifier;
}
export interface Reference<in out Shape> extends Service<never, Shape> {
  readonly defaultValue: () => Shape;
}
export declare namespace Service {
  type Shape<T> = T extends I.Key<any, infer S> ? S : never;
  type Identifier<T> = T extends I.Key<infer Id, any> ? Id : never;
}
export type AnyKey = I.Key<any, any>;
export const TypeId = I.ContextTypeId;
export const ServiceTypeId = I.ServiceTypeId;

function runKey(this: { key: string }, f: I.Fiber) {
  const m = f.context.map;
  const v = m.get(this.key);
  if (v !== undefined || m.has(this.key)) return v;
  if (I.referenceDefaults.has(this.key)) return I.referenceDefault(this.key);
  return I.serviceNotFound(this.key);
}
const keyMembers = {
  [I.ServiceTypeId]: I.ServiceTypeId,
  [I.EffectTypeId]: I.YieldableProto[I.EffectTypeId],
  [I.RUN]: runKey,
  [Symbol.iterator](this: unknown) {
    return (I.YieldableProto as any)[Symbol.iterator].call(this);
  },
  pipe(this: unknown) {
    return I.pipeArgs(this, arguments);
  },
  of: (self: unknown) => self,
  context(this: { key: string }, self: unknown) {
    return I.makeContext(new Map([[this.key, self]]));
  },
  use(this: AnyKey, f: (s: any) => I.Effect<any, any, any>) {
    return I.make((fib) => I.chain(I.exec(this, fib), (s) => I.exec(f(s), fib)));
  },
  useSync(this: AnyKey, f: (s: any) => any) {
    return I.make((fib) => I.chain(I.exec(this, fib), f));
  },
  toString(this: { key: string }) {
    return `Service(${this.key})`;
  },
};

function makeKeyObject(key: string): any {
  const k = Object.create(keyMembers);
  k.key = key;
  return k;
}

export const Service: {
  <Identifier, Shape = Identifier>(key: string, options?: {}): Service<Identifier, Shape>;
  <Self, Shape>(): <const Identifier extends string, E = never, R = never, Args extends ReadonlyArray<any> = never>(
    id: Identifier,
    options?: { readonly make?: ((...args: Args) => I.Effect<Shape, E, R>) | I.Effect<Shape, E, R> },
  ) => ServiceClass<Self, Identifier, Shape> & { readonly make: [Args] extends [never] ? I.Effect<Shape, E, R> : (...args: Args) => I.Effect<Shape, E, R> };
} = function (key?: string): any {
  if (typeof key === "string") return makeKeyObject(key);
  return (id: string, options?: { make?: unknown }) => {
    class KeyClass {
      static readonly key = id;
      static readonly make = options?.make;
    }
    for (const k of Reflect.ownKeys(keyMembers)) {
      if (k === "toString") continue;
      Object.defineProperty(KeyClass, k, { value: (keyMembers as any)[k], writable: true, configurable: true });
    }
    return KeyClass;
  };
} as never;

export const Reference = <Shape>(key: string, options: { readonly defaultValue: () => Shape }): Reference<Shape> => {
  I.referenceDefaults.set(key, options.defaultValue);
  const k = makeKeyObject(key);
  k.defaultValue = options.defaultValue;
  return k;
};
export const isKey = (u: unknown): u is AnyKey => (typeof u === "object" || typeof u === "function") && u !== null && I.ServiceTypeId in u;

export const empty = (): Context<never> => I.emptyContext;
export const isContext = I.isContext;
export const make = <Id, S>(key: I.Key<Id, S>, service: NoInfer<S>): Context<Id> => I.makeContext(new Map([[key.key, service]]));
export const add: {
  <Id, S>(key: I.Key<Id, S>, service: NoInfer<S>): <R>(self: Context<R>) => Context<R | Id>;
  <R, Id, S>(self: Context<R>, key: I.Key<Id, S>, service: NoInfer<S>): Context<R | Id>;
} = I.dual(3, (self: Context<any>, key: AnyKey, service: unknown) => I.contextAdd(self, key.key, service));
export const merge: {
  <R2>(that: Context<R2>): <R>(self: Context<R>) => Context<R | R2>;
  <R, R2>(self: Context<R>, that: Context<R2>): Context<R | R2>;
} = I.dual(2, I.contextMerge);
export const mergeAll = <T extends ReadonlyArray<Context<any>>>(...ctxs: T): Context<T[number] extends Context<infer R> ? R : never> =>
  ctxs.reduce(I.contextMerge, I.emptyContext) as never;
export const get: {
  <S, I2 extends S2, S2>(key: I.Key<I2, S>): (self: Context<S2>) => S;
  <S2, Id extends S2, S>(self: Context<S2>, key: I.Key<Id, S>): S;
} = I.dual(2, (self: Context<any>, key: AnyKey) => {
  if (!I.hasService(self, key.key)) throw new Error(`Service not found: ${key.key}`);
  return I.lookup(self, key.key);
});
export const getUnsafe = get as <S2, Id, S>(self: Context<S2>, key: I.Key<Id, S>) => S;
export const getOrUndefined: {
  <Id, S>(key: I.Key<Id, S>): <S2>(self: Context<S2>) => S | undefined;
  <S2, Id, S>(self: Context<S2>, key: I.Key<Id, S>): S | undefined;
} = I.dual(2, (self: Context<any>, key: AnyKey) => I.lookup(self, key.key));
export const getOption: {
  <Id, S>(key: I.Key<Id, S>): <S2>(self: Context<S2>) => O.Option<S>;
  <S2, Id, S>(self: Context<S2>, key: I.Key<Id, S>): O.Option<S>;
} = I.dual(2, (self: Context<any>, key: AnyKey) => (I.hasService(self, key.key) ? O.some(I.lookup(self, key.key)) : O.none()));
export const getOrElse: {
  <Id, S, B>(key: I.Key<Id, S>, orElse: () => B): <S2>(self: Context<S2>) => S | B;
  <S2, Id, S, B>(self: Context<S2>, key: I.Key<Id, S>, orElse: () => B): S | B;
} = I.dual(3, (self: Context<any>, key: AnyKey, orElse: () => unknown) => (I.hasService(self, key.key) ? I.lookup(self, key.key) : orElse()));
export const has = (self: Context<any>, key: AnyKey): boolean => self.map.has(key.key);
export const omit =
  <Keys extends ReadonlyArray<AnyKey>>(...keys: Keys) =>
  <S>(self: Context<S>): Context<Exclude<S, Keys[number] extends I.Key<infer Id, any> ? Id : never>> => {
    const m = new Map(self.map);
    for (const k of keys) m.delete(k.key);
    return I.makeContext(m);
  };
export const pick =
  <Keys extends ReadonlyArray<AnyKey>>(...keys: Keys) =>
  <S>(self: Context<S>): Context<S & (Keys[number] extends I.Key<infer Id, any> ? Id : never)> => {
    const m = new Map<string, unknown>();
    for (const k of keys) if (self.map.has(k.key)) m.set(k.key, self.map.get(k.key));
    return I.makeContext(m);
  };
export const makeUnsafe = <S = never>(map: ReadonlyMap<string, any>): Context<S> => I.makeContext(map);
