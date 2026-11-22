import * as I from "./internal.ts";
import * as O from "./Option.ts";
import { NoSuchElementError, TimeoutError, UnknownError, IllegalArgumentError, ExceededCapacityError, YieldableError, Done, isDone, type Done as DoneT } from "./errors.ts";

export type Cause<E> = I.Cause<E>;
export type Reason<E> = I.Reason<E>;
export type Fail<E> = I.Fail<E>;
export type Die = I.Die;
export type Interrupt = I.Interrupt;
export { NoSuchElementError, TimeoutError, UnknownError, IllegalArgumentError, ExceededCapacityError, YieldableError, Done, isDone };
export type { DoneT };
export declare namespace Done {
  type Extract<E> = E extends DoneT<any> ? E : never;
  type Only<E> = Exclude<E, DoneT<any>>;
}
export const TypeId = I.CauseTypeId;
export const isCause = I.isCause;
export const empty = I.causeEmpty;
export const fail = I.causeFail;
export const die = I.causeDie;
export const interrupt = I.causeInterrupt;
export const fromReasons = I.makeCause;
export const makeFailReason = I.makeFailReason;
export const makeDieReason = I.makeDieReason;
export const makeInterruptReason = I.makeInterruptReason;
export const done = <A = void>(value?: A) => I.make<never, DoneT<A>>(() => I.failWith(I.causeFail(Done(value))));
export const isFailReason = <E>(r: Reason<E>): r is Fail<E> => r._tag === "Fail";
export const isDieReason = <E>(r: Reason<E>): r is Die => r._tag === "Die";
export const isInterruptReason = <E>(r: Reason<E>): r is Interrupt => r._tag === "Interrupt";
export const isTimeoutError = (u: unknown): u is TimeoutError => u instanceof TimeoutError;
export const isNoSuchElementError = (u: unknown): u is NoSuchElementError => u instanceof NoSuchElementError;
export const isUnknownError = (u: unknown): u is UnknownError => u instanceof UnknownError;

export const combine: {
  <E2>(that: Cause<E2>): <E>(self: Cause<E>) => Cause<E | E2>;
  <E, E2>(self: Cause<E>, that: Cause<E2>): Cause<E | E2>;
} = I.dual(2, <E, E2>(a: Cause<E>, b: Cause<E2>): Cause<E | E2> =>
  a.reasons.length === 0 ? b : b.reasons.length === 0 ? a : I.makeCause<E | E2>([...a.reasons, ...b.reasons]));
export const map: {
  <E, E2>(f: (e: E) => E2): (self: Cause<E>) => Cause<E2>;
  <E, E2>(self: Cause<E>, f: (e: E) => E2): Cause<E2>;
} = I.dual(2, <E, E2>(c: Cause<E>, f: (e: E) => E2): Cause<E2> =>
  I.makeCause(c.reasons.map((r) => (r._tag === "Fail" ? { ...r, error: f(r.error) } : r))));

export const hasFails = <E>(c: Cause<E>) => c.reasons.some(isFailReason);
export const hasDies = <E>(c: Cause<E>) => c.reasons.some(isDieReason);
export const hasInterrupts = <E>(c: Cause<E>) => c.reasons.some(isInterruptReason);
export const hasInterruptsOnly = <E>(c: Cause<E>) => c.reasons.length > 0 && c.reasons.every(isInterruptReason);
export const isEmpty = <E>(c: Cause<E>) => c.reasons.length === 0;

export const findError = <E>(c: Cause<E>): I.Step<E> => {
  for (const r of c.reasons) if (r._tag === "Fail") return r.error;
  return I.failWith(I.causeFail(new NoSuchElementError()));
};
export const findErrorOption = <E>(c: Cause<E>): O.Option<E> => {
  for (const r of c.reasons) if (r._tag === "Fail") return O.some(r.error);
  return O.none();
};
export const findDefect = (c: Cause<unknown>): O.Option<unknown> => {
  for (const r of c.reasons) if (r._tag === "Die") return O.some(r.defect);
  return O.none();
};
export const failures = <E>(c: Cause<E>): ReadonlyArray<E> => c.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []));
export const defects = (c: Cause<unknown>): ReadonlyArray<unknown> => c.reasons.flatMap((r) => (r._tag === "Die" ? [r.defect] : []));
export const filterInterruptors = (c: Cause<unknown>): ReadonlySet<number> =>
  new Set(c.reasons.flatMap((r) => (r._tag === "Interrupt" && r.fiberId !== undefined ? [r.fiberId] : [])));

/** First failure, else first defect, else an interruption error. */
export const squash = <E>(c: Cause<E>): unknown => {
  for (const r of c.reasons) if (r._tag === "Fail") return r.error;
  for (const r of c.reasons) if (r._tag === "Die") return r.defect;
  return new InterruptError();
};
export class InterruptError extends Error {
  constructor() {
    super("All fibers interrupted without error");
    this.name = "InterruptError";
  }
}
export const pretty = <E>(c: Cause<E>): string => I.prettyCause(c);
export const prettyErrors = <E>(c: Cause<E>): ReadonlyArray<Error> =>
  c.reasons.map((r) => {
    const v = r._tag === "Fail" ? r.error : r._tag === "Die" ? r.defect : new InterruptError();
    if (v instanceof Error) return v;
    const e = new Error(I.prettyCause(I.makeCause([r])));
    return e;
  });
