import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as C from "../Cause.ts";

export const TypeId: unique symbol = Symbol.for("effect/reactivity/AsyncResult") as never;
interface Proto<A, E> extends I.Pipeable {
  readonly [TypeId]: { readonly A: (_: never) => A; readonly E: (_: never) => E };
  readonly waiting: boolean;
}
export interface Initial<A, E = never> extends Proto<A, E> {
  readonly _tag: "Initial";
}
export interface Success<A, E = never> extends Proto<A, E> {
  readonly _tag: "Success";
  readonly value: A;
  readonly timestamp: number;
}
export interface Failure<A, E = never> extends Proto<A, E> {
  readonly _tag: "Failure";
  readonly cause: C.Cause<E>;
  readonly previousSuccess: O.Option<Success<A, E>>;
}
export type AsyncResult<A, E = never> = Initial<A, E> | Success<A, E> | Failure<A, E>;
export declare namespace AsyncResult {
  type Success<R> = R extends AsyncResult<infer A, any> ? A : never;
  type Failure<R> = R extends AsyncResult<any, infer E> ? E : never;
}
const proto = {
  ...I.PipeProto,
  [TypeId]: {},
  [I.EqualSymbol](this: AsyncResult<unknown, unknown>, that: unknown) {
    if (!isAsyncResult(that) || that._tag !== this._tag || that.waiting !== this.waiting) return false;
    if (this._tag === "Success") return I.equals(this.value, (that as Success<unknown>).value);
    if (this._tag === "Failure") return I.equals(this.cause, (that as Failure<unknown, unknown>).cause);
    return true;
  },
  [I.HashSymbol](this: AsyncResult<unknown, unknown>) {
    return this._tag === "Success" ? I.hash(this.value) : this._tag.length;
  },
  toJSON(this: AsyncResult<unknown, unknown>) {
    return { _id: "AsyncResult", ...this };
  },
};
const mk = <R>(fields: object): R => Object.assign(Object.create(proto), fields);
export const isAsyncResult = (u: unknown): u is AsyncResult<unknown, unknown> => typeof u === "object" && u !== null && TypeId in u;
const initialFalse = mk<Initial<never>>({ _tag: "Initial", waiting: false });
const initialTrue = mk<Initial<never>>({ _tag: "Initial", waiting: true });
export const initial = <A = never, E = never>(waiting = false): Initial<A, E> => (waiting ? initialTrue : initialFalse) as Initial<A, E>;
export const success = <A, E = never>(value: A, options?: { readonly waiting?: boolean; readonly timestamp?: number }): Success<A, E> =>
  mk({ _tag: "Success", value, waiting: options?.waiting ?? false, timestamp: options?.timestamp ?? Date.now() });
export const failure = <A, E = never>(cause: C.Cause<E>, options?: { readonly previousSuccess?: O.Option<Success<A, E>> | undefined; readonly waiting?: boolean | undefined }): Failure<A, E> =>
  mk({ _tag: "Failure", cause, previousSuccess: options?.previousSuccess ?? O.none(), waiting: options?.waiting ?? false });
export const fail = <E, A = never>(error: E, options?: { readonly previousSuccess?: O.Option<Success<A, E>>; readonly waiting?: boolean }): Failure<A, E> =>
  failure(C.fail(error), options);
export const failureWithPrevious = <A, E>(cause: C.Cause<E>, options: { readonly previous: O.Option<AsyncResult<A, E>>; readonly waiting?: boolean }): Failure<A, E> =>
  failure(cause, { previousSuccess: O.flatMap(options.previous, (r) => (r._tag === "Success" ? O.some(r) : r._tag === "Failure" ? r.previousSuccess : O.none())), waiting: options.waiting });
export const failWithPrevious = <A, E>(error: E, options: { readonly previous: O.Option<AsyncResult<A, E>>; readonly waiting?: boolean }) => failureWithPrevious(C.fail(error), options);
export const fromExit = <A, E>(exit: I.Exit<A, E>): Success<A, E> | Failure<A, E> => (exit._tag === "Success" ? success(exit.value) : failure(exit.cause));
export const fromExitWithPrevious = <A, E>(exit: I.Exit<A, E>, previous: O.Option<AsyncResult<A, E>>): Success<A, E> | Failure<A, E> =>
  exit._tag === "Success" ? success(exit.value) : failureWithPrevious(exit.cause, { previous });
export const waitingFrom = <A, E>(previous: O.Option<AsyncResult<A, E>>): AsyncResult<A, E> =>
  previous._tag === "None" ? initial(true) : waiting(previous.value);
export const isInitial = <A, E>(r: AsyncResult<A, E>): r is Initial<A, E> => r._tag === "Initial";
export const isNotInitial = <A, E>(r: AsyncResult<A, E>): r is Success<A, E> | Failure<A, E> => r._tag !== "Initial";
export const isSuccess = <A, E>(r: AsyncResult<A, E>): r is Success<A, E> => r._tag === "Success";
export const isFailure = <A, E>(r: AsyncResult<A, E>): r is Failure<A, E> => r._tag === "Failure";
export const isWaiting = <A, E>(r: AsyncResult<A, E>): boolean => r.waiting;
export const isInterrupted = <A, E>(r: AsyncResult<A, E>): boolean => r._tag === "Failure" && C.hasInterruptsOnly(r.cause);
export const waiting: {
  (options?: { readonly touch?: boolean }): <R extends AsyncResult<any, any>>(self: R) => R;
  <R extends AsyncResult<any, any>>(self: R, options?: { readonly touch?: boolean }): R;
} = I.dual((args) => isAsyncResult(args[0]), (self: AsyncResult<any, any>, o?: { touch?: boolean }) => {
  if (self.waiting && !o?.touch) return self;
  if (self._tag === "Initial") return initial(true);
  return mk({ ...self, waiting: true, ...(self._tag === "Success" && o?.touch ? { timestamp: Date.now() } : {}) });
});
export const touch = <R extends AsyncResult<any, any>>(self: R): R => (self._tag === "Success" ? (mk({ ...self, timestamp: Date.now() }) as R) : self);
export const replacePrevious = <R extends AsyncResult<any, any>, XE, A>(self: R, previous: O.Option<AsyncResult<A, XE>>): R =>
  self._tag === "Failure" ? (failureWithPrevious(self.cause, { previous, waiting: self.waiting }) as never) : self;
export const value = <A, E>(self: AsyncResult<A, E>): O.Option<A> =>
  self._tag === "Success" ? O.some(self.value) : self._tag === "Failure" && self.previousSuccess._tag === "Some" ? O.some(self.previousSuccess.value.value) : O.none();
export const getOrElse: {
  <B>(orElse: () => B): <A, E>(self: AsyncResult<A, E>) => A | B;
  <A, E, B>(self: AsyncResult<A, E>, orElse: () => B): A | B;
} = I.dual(2, <A, E, B>(self: AsyncResult<A, E>, orElse: () => B): A | B => O.getOrElse(value(self), orElse));
export const getOrThrow = <A, E>(self: AsyncResult<A, E>): A => O.getOrThrowWith(value(self), () => new C.NoSuchElementError("AsyncResult.getOrThrow: no value found"));
export const cause = <A, E>(self: AsyncResult<A, E>): O.Option<C.Cause<E>> => (self._tag === "Failure" ? O.some(self.cause) : O.none());
export const error = <A, E>(self: AsyncResult<A, E>): O.Option<E> => (self._tag === "Failure" ? C.findErrorOption(self.cause) : O.none());
export const toExit = <A, E>(self: AsyncResult<A, E>): I.Exit<A, E | C.NoSuchElementError> =>
  self._tag === "Success" ? I.exitSucceed(self.value) : self._tag === "Failure" ? I.exitFailCause(self.cause) : I.exitFailCause(C.fail(new C.NoSuchElementError()));
export const map: {
  <A, B>(f: (a: A) => B): <E>(self: AsyncResult<A, E>) => AsyncResult<B, E>;
  <E, A, B>(self: AsyncResult<A, E>, f: (a: A) => B): AsyncResult<B, E>;
} = I.dual(2, (self: AsyncResult<any, any>, f: (a: any) => any) => {
  if (self._tag === "Initial") return self;
  if (self._tag === "Success") return success(f(self.value), { waiting: self.waiting, timestamp: self.timestamp });
  return failure(self.cause, { waiting: self.waiting, previousSuccess: O.map(self.previousSuccess, (s) => success(f(s.value), { timestamp: s.timestamp })) });
});
export const flatMap: {
  <A, E, B, E2>(f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>): (self: AsyncResult<A, E>) => AsyncResult<B, E | E2>;
  <E, A, B, E2>(self: AsyncResult<A, E>, f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>): AsyncResult<B, E | E2>;
} = I.dual(2, (self: AsyncResult<any, any>, f: (a: any, s: Success<any, any>) => AsyncResult<any, any>) => (self._tag === "Success" ? f(self.value, self) : self));
export const match: {
  <A, E, X, Y, Z>(o: { readonly onInitial: (r: Initial<A, E>) => X; readonly onFailure: (r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): (self: AsyncResult<A, E>) => X | Y | Z;
  <A, E, X, Y, Z>(self: AsyncResult<A, E>, o: { readonly onInitial: (r: Initial<A, E>) => X; readonly onFailure: (r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): X | Y | Z;
} = I.dual(2, (self: AsyncResult<any, any>, o: any) => (self._tag === "Initial" ? o.onInitial(self) : self._tag === "Failure" ? o.onFailure(self) : o.onSuccess(self)));
export const matchWithError: {
  <A, E, W, X, Y, Z>(o: { readonly onInitial: (r: Initial<A, E>) => W; readonly onError: (e: E, r: Failure<A, E>) => X; readonly onDefect: (d: unknown, r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): (self: AsyncResult<A, E>) => W | X | Y | Z;
  <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, o: { readonly onInitial: (r: Initial<A, E>) => W; readonly onError: (e: E, r: Failure<A, E>) => X; readonly onDefect: (d: unknown, r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): W | X | Y | Z;
} = I.dual(2, (self: AsyncResult<any, any>, o: any) => {
  if (self._tag === "Initial") return o.onInitial(self);
  if (self._tag === "Success") return o.onSuccess(self);
  const e = C.findErrorOption(self.cause);
  return e._tag === "Some" ? o.onError(e.value, self) : o.onDefect(C.squash(self.cause), self);
});
export const matchWithWaiting: {
  <A, E, W, X, Y, Z>(o: { readonly onWaiting: (r: AsyncResult<A, E>) => W; readonly onError: (e: E, r: Failure<A, E>) => X; readonly onDefect: (d: unknown, r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): (self: AsyncResult<A, E>) => W | X | Y | Z;
  <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, o: { readonly onWaiting: (r: AsyncResult<A, E>) => W; readonly onError: (e: E, r: Failure<A, E>) => X; readonly onDefect: (d: unknown, r: Failure<A, E>) => Y; readonly onSuccess: (r: Success<A, E>) => Z }): W | X | Y | Z;
} = I.dual(2, (self: AsyncResult<any, any>, o: any) => (self.waiting || self._tag === "Initial" ? o.onWaiting(self) : matchWithError(self, { onInitial: o.onWaiting, onError: o.onError, onDefect: o.onDefect, onSuccess: o.onSuccess })));
export const all = <const Arg extends Iterable<any> | Record<string, any>>(input: Arg): AsyncResult<any, any> => {
  const out: any = Symbol.iterator in input ? [] : {};
  let waitingAny = false;
  for (const [k, v] of Symbol.iterator in input ? [...(input as Iterable<unknown>)].entries() : Object.entries(input)) {
    const r = isAsyncResult(v) ? v : success(v);
    if (r._tag !== "Success") return r;
    waitingAny ||= r.waiting;
    out[k] = r.value;
  }
  return success(out, { waiting: waitingAny });
};
