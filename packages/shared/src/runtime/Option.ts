import { dual, EqualSymbol, equals, hash, HashSymbol, PipeProto, type Pipeable } from "./internal.ts";
import { NoSuchElementError } from "./errors.ts";

export const TypeId: unique symbol = Symbol.for("effect/Option") as never;
/** Not an Effect (as in effect v4): it only iterates inside `Option.gen`. */
export interface None<out A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly _tag: "None";
  [Symbol.iterator](): Iterator<Option<A>, A>;
}
export interface Some<out A> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly _tag: "Some";
  readonly value: A;
  [Symbol.iterator](): Iterator<Option<A>, A>;
}
export type Option<A> = None<A> | Some<A>;
export declare namespace Option {
  type Value<T> = T extends Option<infer A> ? A : never;
}

const proto = {
  ...PipeProto,
  [TypeId]: TypeId,
  *[Symbol.iterator](this: Option<unknown>): Generator<Option<unknown>, unknown> {
    return yield this;
  },
  [EqualSymbol](this: Option<unknown>, that: unknown) {
    return isOption(that) && that._tag === this._tag && (this._tag === "None" || equals(this.value, (that as Some<unknown>).value));
  },
  [HashSymbol](this: Option<unknown>) {
    return this._tag === "None" ? 0x9e37 : hash(this.value);
  },
  toJSON(this: Option<unknown>) {
    return this._tag === "None" ? { _id: "Option", _tag: "None" } : { _id: "Option", _tag: "Some", value: this.value };
  },
  toString(this: Option<unknown>) {
    return this._tag === "None" ? "none()" : `some(${String(this.value)})`;
  },
};
const noneValue: None<never> = Object.assign(Object.create(proto), { _tag: "None" });
export const none = <A = never>(): Option<A> => noneValue;
export const some = <A>(value: A): Option<A> => {
  const o = Object.create(proto);
  o._tag = "Some";
  o.value = value;
  return o;
};
export const isOption = (u: unknown): u is Option<unknown> => typeof u === "object" && u !== null && TypeId in u;
export const isSome = <A>(o: Option<A>): o is Some<A> => o._tag === "Some";
export const isNone = <A>(o: Option<A>): o is None<A> => o._tag === "None";

export const fromNullishOr = <A>(a: A): Option<NonNullable<A>> => (a == null ? none() : some(a as NonNullable<A>));
export const fromNullOr = <A>(a: A): Option<Exclude<A, null>> => (a === null ? none() : some(a as Exclude<A, null>));
export const fromUndefinedOr = <A>(a: A): Option<Exclude<A, undefined>> => (a === undefined ? none() : some(a as Exclude<A, undefined>));
export const fromIterable = <A>(it: Iterable<A>): Option<A> => {
  for (const a of it) return some(a);
  return none();
};

export const getOrThrow = <A>(o: Option<A>): A => {
  if (o._tag === "Some") return o.value;
  throw new NoSuchElementError("getOrThrow called on a None");
};
export const getOrThrowWith: {
  (onNone: () => unknown): <A>(o: Option<A>) => A;
  <A>(o: Option<A>, onNone: () => unknown): A;
} = dual(2, <A>(o: Option<A>, onNone: () => unknown): A => {
  if (o._tag === "Some") return o.value;
  throw onNone();
});
export const getOrUndefined = <A>(o: Option<A>): A | undefined => (o._tag === "Some" ? o.value : undefined);
export const getOrNull = <A>(o: Option<A>): A | null => (o._tag === "Some" ? o.value : null);
export const getOrElse: {
  <B>(onNone: () => B): <A>(o: Option<A>) => A | B;
  <A, B>(o: Option<A>, onNone: () => B): A | B;
} = dual(2, <A, B>(o: Option<A>, onNone: () => B): A | B => (o._tag === "Some" ? o.value : onNone()));
export const match: {
  <A, B, C = B>(cases: { readonly onNone: () => B; readonly onSome: (a: A) => C }): (o: Option<A>) => B | C;
  <A, B, C = B>(o: Option<A>, cases: { readonly onNone: () => B; readonly onSome: (a: A) => C }): B | C;
} = dual(2, <A, B, C>(o: Option<A>, c: { onNone: () => B; onSome: (a: A) => C }) => (o._tag === "Some" ? c.onSome(o.value) : c.onNone()));
export const map: {
  <A, B>(f: (a: A) => B): (o: Option<A>) => Option<B>;
  <A, B>(o: Option<A>, f: (a: A) => B): Option<B>;
} = dual(2, <A, B>(o: Option<A>, f: (a: A) => B): Option<B> => (o._tag === "Some" ? some(f(o.value)) : none()));
export const flatMap: {
  <A, B>(f: (a: A) => Option<B>): (o: Option<A>) => Option<B>;
  <A, B>(o: Option<A>, f: (a: A) => Option<B>): Option<B>;
} = dual(2, <A, B>(o: Option<A>, f: (a: A) => Option<B>): Option<B> => (o._tag === "Some" ? f(o.value) : none()));
export const andThen = flatMap;
export const flatMapNullishOr: {
  <A, B>(f: (a: A) => B): (o: Option<A>) => Option<NonNullable<B>>;
  <A, B>(o: Option<A>, f: (a: A) => B): Option<NonNullable<B>>;
} = dual(2, <A, B>(o: Option<A>, f: (a: A) => B) => (o._tag === "Some" ? fromNullishOr(f(o.value)) : none()));
export const flatten = <A>(o: Option<Option<A>>): Option<A> => (o._tag === "Some" ? o.value : none());
export const filter: {
  <A, B extends A>(f: (a: A) => a is B): (o: Option<A>) => Option<B>;
  <A>(f: (a: A) => boolean): (o: Option<A>) => Option<A>;
  <A, B extends A>(o: Option<A>, f: (a: A) => a is B): Option<B>;
  <A>(o: Option<A>, f: (a: A) => boolean): Option<A>;
} = dual(2, <A>(o: Option<A>, f: (a: A) => boolean) => (o._tag === "Some" && f(o.value) ? o : none()));
export const filterMap: {
  <A, B>(f: (a: A) => Option<B>): (o: Option<A>) => Option<B>;
  <A, B>(o: Option<A>, f: (a: A) => Option<B>): Option<B>;
} = flatMap;
export const exists: {
  <A>(f: (a: A) => boolean): (o: Option<A>) => boolean;
  <A>(o: Option<A>, f: (a: A) => boolean): boolean;
} = dual(2, <A>(o: Option<A>, f: (a: A) => boolean) => o._tag === "Some" && f(o.value));
export const contains: {
  <A>(a: A): (o: Option<A>) => boolean;
  <A>(o: Option<A>, a: A): boolean;
} = dual(2, <A>(o: Option<A>, a: A) => o._tag === "Some" && equals(o.value, a));
export const orElse: {
  <B>(that: () => Option<B>): <A>(o: Option<A>) => Option<A | B>;
  <A, B>(o: Option<A>, that: () => Option<B>): Option<A | B>;
} = dual(2, <A, B>(o: Option<A>, that: () => Option<B>): Option<A | B> => (o._tag === "Some" ? o : that()));
export const orElseSome: {
  <B>(that: () => B): <A>(o: Option<A>) => Option<A | B>;
  <A, B>(o: Option<A>, that: () => B): Option<A | B>;
} = dual(2, <A, B>(o: Option<A>, that: () => B): Option<A | B> => (o._tag === "Some" ? o : some(that())));
export const toArray = <A>(o: Option<A>): Array<A> => (o._tag === "Some" ? [o.value] : []);
export const firstSomeOf = <A>(it: Iterable<Option<A>>): Option<A> => {
  for (const o of it) if (o._tag === "Some") return o;
  return none();
};
export const liftThrowable =
  <A extends ReadonlyArray<unknown>, B>(f: (...a: A) => B) =>
  (...a: A): Option<B> => {
    try {
      return some(f(...a));
    } catch {
      return none();
    }
  };
export const liftPredicate: {
  <A, B extends A>(f: (a: A) => a is B): (a: A) => Option<B>;
  <A>(f: (a: A) => boolean): (a: A) => Option<A>;
} = <A>(f: (a: A) => boolean) => (a: A) => (f(a) ? some(a) : none());
export const zipWith: {
  <A, B, C>(that: Option<B>, f: (a: A, b: B) => C): (o: Option<A>) => Option<C>;
  <A, B, C>(o: Option<A>, that: Option<B>, f: (a: A, b: B) => C): Option<C>;
} = dual(3, <A, B, C>(o: Option<A>, that: Option<B>, f: (a: A, b: B) => C) =>
  o._tag === "Some" && that._tag === "Some" ? some(f(o.value, that.value)) : none());
export const tap: {
  <A>(f: (a: A) => void): (o: Option<A>) => Option<A>;
  <A>(o: Option<A>, f: (a: A) => void): Option<A>;
} = dual(2, <A>(o: Option<A>, f: (a: A) => void) => {
  if (o._tag === "Some") f(o.value);
  return o;
});
export const isOptionEq = equals;
export const makeOrder =
  <A>(ord: (a: A, b: A) => -1 | 0 | 1) =>
  (a: Option<A>, b: Option<A>): -1 | 0 | 1 =>
    a._tag === "None" ? (b._tag === "None" ? 0 : -1) : b._tag === "None" ? 1 : ord(a.value, b.value);
export const makeEquivalence =
  <A>(eq: (a: A, b: A) => boolean) =>
  (a: Option<A>, b: Option<A>): boolean =>
    a._tag === "None" ? b._tag === "None" : b._tag === "Some" && eq(a.value, b.value);
export const all = <const T extends ReadonlyArray<Option<any>> | Record<string, Option<any>>>(
  input: T,
): Option<{ -readonly [K in keyof T]: T[K] extends Option<infer A> ? A : never }> => {
  const out: any = Array.isArray(input) ? [] : {};
  for (const k of Object.keys(input)) {
    const o = (input as any)[k] as Option<unknown>;
    if (o._tag === "None") return none();
    out[k] = o.value;
  }
  return some(out);
};
/** Do-notation: `yield*` an Option to unwrap it; any None short-circuits to None. */
export const gen = <Y extends Option<any>, A>(f: () => Generator<Y, A, any>): Option<A> => {
  const it = f();
  let state = it.next();
  while (!state.done) {
    const o = state.value as Option<unknown>;
    if (o._tag === "None") return none();
    state = it.next(o.value);
  }
  return some(state.value);
};
