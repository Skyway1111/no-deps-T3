import { dual, EqualSymbol, equals, hash, HashSymbol, PipeProto, type Pipeable } from "./internal.ts";
import * as O from "./Option.ts";

export const TypeId: unique symbol = Symbol.for("effect/Result") as never;
/** Not an Effect (as in effect v4): it only iterates inside `Result.gen`. */
export interface Success<out A, out E = never> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly _tag: "Success";
  readonly success: A;
  [Symbol.iterator](): Iterator<Result<A, E>, A>;
}
export interface Failure<out A, out E> extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly _tag: "Failure";
  readonly failure: E;
  [Symbol.iterator](): Iterator<Result<A, E>, A>;
}
export type Result<A, E = never> = Success<A, E> | Failure<A, E>;

const proto = {
  ...PipeProto,
  [TypeId]: TypeId,
  *[Symbol.iterator](this: Result<unknown, unknown>): Generator<Result<unknown, unknown>, unknown> {
    return yield this;
  },
  [EqualSymbol](this: Result<unknown, unknown>, that: unknown) {
    return isResult(that) && that._tag === this._tag &&
      (this._tag === "Success" ? equals(this.success, (that as any).success) : equals(this.failure, (that as any).failure));
  },
  [HashSymbol](this: Result<unknown, unknown>) {
    return hash(this._tag === "Success" ? this.success : this.failure);
  },
  toJSON(this: Result<unknown, unknown>) {
    return this._tag === "Success" ? { _id: "Result", _tag: "Success", success: this.success } : { _id: "Result", _tag: "Failure", failure: this.failure };
  },
};
export const succeed = <A, E = never>(success: A): Result<A, E> => Object.assign(Object.create(proto), { _tag: "Success", _op: "Success", success });
export const fail = <E, A = never>(failure: E): Result<A, E> => Object.assign(Object.create(proto), { _tag: "Failure", _op: "Failure", failure });
export const failVoid: Result<never, void> = fail(undefined);
export const succeedNone: Result<O.Option<never>> = succeed(O.none());
export const succeedSome = <A>(a: A): Result<O.Option<A>> => succeed(O.some(a));
export const isResult = (u: unknown): u is Result<unknown, unknown> => typeof u === "object" && u !== null && TypeId in u;
export const isSuccess = <A, E>(r: Result<A, E>): r is Success<A, E> => r._tag === "Success";
export const isFailure = <A, E>(r: Result<A, E>): r is Failure<A, E> => r._tag === "Failure";
export const fromNullishOr: {
  <E>(onNullish: () => E): <A>(a: A) => Result<NonNullable<A>, E>;
  <A, E>(a: A, onNullish: () => E): Result<NonNullable<A>, E>;
} = dual(2, <A, E>(a: A, onNullish: () => E) => (a == null ? fail(onNullish()) : succeed(a as NonNullable<A>)));
export const fromOption: {
  <E>(onNone: () => E): <A>(o: O.Option<A>) => Result<A, E>;
  <A, E>(o: O.Option<A>, onNone: () => E): Result<A, E>;
} = dual(2, <A, E>(o: O.Option<A>, onNone: () => E) => (o._tag === "Some" ? succeed(o.value) : fail(onNone())));
export const try_ = <A, E = unknown>(f: (() => A) | { try: () => A; catch: (e: unknown) => E }): Result<A, E> => {
  try {
    return succeed(typeof f === "function" ? f() : f.try());
  } catch (e) {
    return fail(typeof f === "function" ? (e as E) : f.catch(e));
  }
};
export { try_ as try };
export const getSuccess = <A, E>(r: Result<A, E>): O.Option<A> => (r._tag === "Success" ? O.some(r.success) : O.none());
export const getFailure = <A, E>(r: Result<A, E>): O.Option<E> => (r._tag === "Failure" ? O.some(r.failure) : O.none());
export const map: {
  <A, B>(f: (a: A) => B): <E>(r: Result<A, E>) => Result<B, E>;
  <A, E, B>(r: Result<A, E>, f: (a: A) => B): Result<B, E>;
} = dual(2, (r: Result<any, any>, f: (a: any) => any) => (r._tag === "Success" ? succeed(f(r.success)) : r));
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A>(r: Result<A, E>) => Result<A, E2>;
  <A, E, E2>(r: Result<A, E>, f: (e: E) => E2): Result<A, E2>;
} = dual(2, (r: Result<any, any>, f: (e: any) => any) => (r._tag === "Failure" ? fail(f(r.failure)) : r));
export const mapBoth: {
  <E, E2, A, A2>(o: { onFailure: (e: E) => E2; onSuccess: (a: A) => A2 }): (r: Result<A, E>) => Result<A2, E2>;
  <A, E, E2, A2>(r: Result<A, E>, o: { onFailure: (e: E) => E2; onSuccess: (a: A) => A2 }): Result<A2, E2>;
} = dual(2, (r: Result<any, any>, o: any) => (r._tag === "Success" ? succeed(o.onSuccess(r.success)) : fail(o.onFailure(r.failure))));
export const flatMap: {
  <A, B, E2>(f: (a: A) => Result<B, E2>): <E>(r: Result<A, E>) => Result<B, E | E2>;
  <A, E, B, E2>(r: Result<A, E>, f: (a: A) => Result<B, E2>): Result<B, E | E2>;
} = dual(2, (r: Result<any, any>, f: (a: any) => any) => (r._tag === "Success" ? f(r.success) : r));
export const andThen = flatMap;
export const match: {
  <E, B, A, C = B>(o: { onFailure: (e: E) => B; onSuccess: (a: A) => C }): (r: Result<A, E>) => B | C;
  <A, E, B, C = B>(r: Result<A, E>, o: { onFailure: (e: E) => B; onSuccess: (a: A) => C }): B | C;
} = dual(2, (r: Result<any, any>, o: any) => (r._tag === "Success" ? o.onSuccess(r.success) : o.onFailure(r.failure)));
export const merge = <A, E>(r: Result<A, E>): A | E => (r._tag === "Success" ? r.success : r.failure);
export const flip = <A, E>(r: Result<A, E>): Result<E, A> => (r._tag === "Success" ? fail(r.success) : succeed(r.failure));
export const getOrElse: {
  <E, B>(f: (e: E) => B): <A>(r: Result<A, E>) => A | B;
  <A, E, B>(r: Result<A, E>, f: (e: E) => B): A | B;
} = dual(2, (r: Result<any, any>, f: (e: any) => any) => (r._tag === "Success" ? r.success : f(r.failure)));
export const getOrNull = <A, E>(r: Result<A, E>): A | null => (r._tag === "Success" ? r.success : null);
export const getOrUndefined = <A, E>(r: Result<A, E>): A | undefined => (r._tag === "Success" ? r.success : undefined);
export const getOrThrowWith: {
  <E>(f: (e: E) => unknown): <A>(r: Result<A, E>) => A;
  <A, E>(r: Result<A, E>, f: (e: E) => unknown): A;
} = dual(2, (r: Result<any, any>, f: (e: any) => unknown) => {
  if (r._tag === "Success") return r.success;
  throw f(r.failure);
});
export const getOrThrow = <A, E>(r: Result<A, E>): A => {
  if (r._tag === "Success") return r.success;
  throw r.failure;
};
export const orElse: {
  <E, A2, E2>(f: (e: E) => Result<A2, E2>): <A>(r: Result<A, E>) => Result<A | A2, E2>;
  <A, E, A2, E2>(r: Result<A, E>, f: (e: E) => Result<A2, E2>): Result<A | A2, E2>;
} = dual(2, (r: Result<any, any>, f: (e: any) => any) => (r._tag === "Success" ? r : f(r.failure)));
export const tap: {
  <A>(f: (a: A) => void): <E>(r: Result<A, E>) => Result<A, E>;
  <A, E>(r: Result<A, E>, f: (a: A) => void): Result<A, E>;
} = dual(2, (r: Result<any, any>, f: (a: any) => void) => {
  if (r._tag === "Success") f(r.success);
  return r;
});
export const liftPredicate = <A, E>(pred: (a: A) => boolean, onFalse: (a: A) => E) => (a: A): Result<A, E> => (pred(a) ? succeed(a) : fail(onFalse(a)));
export const filterOrFail: {
  <A, E2>(pred: (a: A) => boolean, onFalse: (a: A) => E2): <E>(r: Result<A, E>) => Result<A, E | E2>;
  <A, E, E2>(r: Result<A, E>, pred: (a: A) => boolean, onFalse: (a: A) => E2): Result<A, E | E2>;
} = dual(3, (r: Result<any, any>, pred: any, onFalse: any) => (r._tag === "Success" && !pred(r.success) ? fail(onFalse(r.success)) : r));
export const all = <const T extends ReadonlyArray<Result<any, any>> | Record<string, Result<any, any>>>(
  input: T,
): Result<{ -readonly [K in keyof T]: T[K] extends Result<infer A, any> ? A : never }, T[keyof T] extends Result<any, infer E> ? E : never> => {
  const out: any = Array.isArray(input) ? [] : {};
  for (const k of Object.keys(input)) {
    const r = (input as any)[k] as Result<unknown, unknown>;
    if (r._tag === "Failure") return r as never;
    out[k] = r.success;
  }
  return succeed(out);
};
export const makeEquivalence = <A, E>(ea: (a: A, b: A) => boolean, ee: (a: E, b: E) => boolean) => (x: Result<A, E>, y: Result<A, E>): boolean =>
  x._tag === "Success" ? y._tag === "Success" && ea(x.success, y.success) : y._tag === "Failure" && ee(x.failure, y.failure);
export const transposeOption = <A, E>(o: O.Option<Result<A, E>>): Result<O.Option<A>, E> =>
  o._tag === "None" ? succeedNone : map(o.value, O.some);
/** Do-notation: `yield*` a Result to unwrap it; the first Failure short-circuits. */
export const gen = <Y extends Result<any, any>, A>(f: () => Generator<Y, A, any>): Result<A, Y extends Result<any, infer E> ? E : never> => {
  const it = f();
  let state = it.next();
  while (!state.done) {
    const r = state.value as Result<unknown, unknown>;
    if (r._tag === "Failure") return r as never;
    state = it.next(r.success);
  }
  return succeed(state.value) as never;
};
