import * as I from "./internal.ts";
import * as C from "./Cause.ts";
import * as O from "./Option.ts";

export type Exit<A, E = never> = I.Exit<A, E>;
export type Success<A, E = never> = I.ExitSuccess<A, E>;
export type Failure<A, E> = I.ExitFailure<A, E>;
export const TypeId = I.ExitTypeId;
export const isExit = I.isExit;
export const succeed = I.exitSucceed;
export const failCause = I.exitFailCause;
export const fail = <E>(e: E): Exit<never, E> => I.exitFailCause(I.causeFail(e));
export const die = (d: unknown): Exit<never> => I.exitFailCause(I.causeDie(d));
export const interrupt = (fiberId?: number): Exit<never> => I.exitFailCause(I.causeInterrupt(fiberId));
const void_ = I.exitVoid;
export { void_ as void };
export const isSuccess = <A, E>(e: Exit<A, E>): e is Success<A, E> => e._tag === "Success";
export const isFailure = <A, E>(e: Exit<A, E>): e is Failure<A, E> => e._tag === "Failure";
export const hasInterrupts = <A, E>(e: Exit<A, E>) => e._tag === "Failure" && C.hasInterrupts(e.cause);
export const hasDies = <A, E>(e: Exit<A, E>) => e._tag === "Failure" && C.hasDies(e.cause);
export const isInterrupted = <A, E>(e: Exit<A, E>) => e._tag === "Failure" && C.hasInterruptsOnly(e.cause);
export const findErrorOption = <A, E>(e: Exit<A, E>): O.Option<E> => (e._tag === "Failure" ? C.findErrorOption(e.cause) : O.none());
export const getSuccess = <A, E>(e: Exit<A, E>): O.Option<A> => (e._tag === "Success" ? O.some(e.value) : O.none());
export const getCause = <A, E>(e: Exit<A, E>): O.Option<C.Cause<E>> => (e._tag === "Failure" ? O.some(e.cause) : O.none());
export const match: {
  <A, E, X1, X2>(o: { readonly onSuccess: (a: A) => X1; readonly onFailure: (c: C.Cause<E>) => X2 }): (e: Exit<A, E>) => X1 | X2;
  <A, E, X1, X2>(e: Exit<A, E>, o: { readonly onSuccess: (a: A) => X1; readonly onFailure: (c: C.Cause<E>) => X2 }): X1 | X2;
} = I.dual(2, (e: Exit<any, any>, o: any) => (e._tag === "Success" ? o.onSuccess(e.value) : o.onFailure(e.cause)));
export const map: {
  <A, B>(f: (a: A) => B): <E>(e: Exit<A, E>) => Exit<B, E>;
  <A, E, B>(e: Exit<A, E>, f: (a: A) => B): Exit<B, E>;
} = I.dual(2, (e: Exit<any, any>, f: (a: any) => any) => (e._tag === "Success" ? I.exitSucceed(f(e.value)) : e));
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A>(e: Exit<A, E>) => Exit<A, E2>;
  <A, E, E2>(e: Exit<A, E>, f: (e: E) => E2): Exit<A, E2>;
} = I.dual(2, (e: Exit<any, any>, f: (e: any) => any) => (e._tag === "Success" ? e : I.exitFailCause(C.map(e.cause, f))));
export const asVoid = <A, E>(e: Exit<A, E>): Exit<void, E> => (e._tag === "Success" ? I.exitVoid : (e as never));
export const asVoidAll = <A, E>(exits: Iterable<Exit<A, E>>): Exit<void, E> => {
  let cause: C.Cause<E> | undefined;
  for (const e of exits) if (e._tag === "Failure") cause = cause ? C.combine(cause, e.cause) : e.cause;
  return cause ? I.exitFailCause(cause) : I.exitVoid;
};
export const fromOption = <A>(o: O.Option<A>): Exit<A, void> => (o._tag === "Some" ? I.exitSucceed(o.value) : fail(undefined));
