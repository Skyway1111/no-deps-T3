import { EqualSymbol, equals, hash, HashSymbol, PipeProto, type Pipeable } from "./internal.ts";

export const TypeId: unique symbol = Symbol.for("effect/Redacted") as never;
export interface Redacted<out A = string> extends Pipeable {
  readonly [TypeId]: { readonly _A: () => A };
  readonly label: string | undefined;
}
export declare namespace Redacted {
  type Value<T> = T extends Redacted<infer A> ? A : never;
}
const values = new WeakMap<object, unknown>();
const proto = {
  ...PipeProto,
  [TypeId]: {},
  toString(this: Redacted<unknown>) {
    return this.label === undefined ? "<redacted>" : `<redacted:${this.label}>`;
  },
  toJSON(this: Redacted<unknown>) {
    return this.toString();
  },
  [Symbol.for("nodejs.util.inspect.custom")](this: Redacted<unknown>) {
    return this.toString();
  },
  [EqualSymbol](this: Redacted<unknown>, that: unknown) {
    return isRedacted(that) && equals(values.get(this), values.get(that));
  },
  [HashSymbol](this: Redacted<unknown>) {
    return hash(values.get(this));
  },
};
export const make = <A>(value: A, options?: { readonly label?: string | undefined }): Redacted<A> => {
  const r = Object.create(proto);
  r.label = options?.label;
  values.set(r, value);
  return r;
};
export const value = <A>(self: Redacted<A>): A => {
  if (!values.has(self)) throw new Error("Unable to get redacted value");
  return values.get(self) as A;
};
export const isRedacted = (u: unknown): u is Redacted<unknown> => typeof u === "object" && u !== null && TypeId in u;
export const wipe = <A>(self: Redacted<A>): boolean => values.delete(self);
export const makeEquivalence = <A>(eq: (a: A, b: A) => boolean) => (x: Redacted<A>, y: Redacted<A>) => eq(value(x), value(y));
