import * as I from "./internal.ts";
import * as O from "./Option.ts";

export const TypeId: unique symbol = Symbol.for("effect/Deferred") as never;
export class Deferred<A, E = never> implements I.Pipeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  exit: I.Exit<A, E> | undefined = undefined;
  waiters: Array<(e: I.Exit<A, E>) => void> | undefined = undefined;
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const isDeferred = (u: unknown): u is Deferred<unknown, unknown> => u instanceof Deferred;
export const makeUnsafe = <A, E = never>(): Deferred<A, E> => new Deferred<A, E>();
export const make = <A, E = never>(): I.Effect<Deferred<A, E>> => I.make(() => new Deferred<A, E>());
/** Complete with an exit; false if already done. */
export const doneUnsafe = <A, E>(self: Deferred<A, E>, exit: I.Exit<A, E>): boolean => {
  if (self.exit) return false;
  self.exit = exit;
  const ws = self.waiters;
  self.waiters = undefined;
  if (ws) for (const w of ws) w(exit);
  return true;
};
export const isDoneUnsafe = (self: Deferred<any, any>): boolean => self.exit !== undefined;
const await_ = <A, E>(self: Deferred<A, E>): I.Effect<A, E> =>
  I.make((f) => {
    if (self.exit) return I.exec(self.exit, f);
    return I.chain(
      I.interruptibleWait<I.Exit<A, E>>(f, (resolve) => {
        (self.waiters ??= []).push(resolve);
        return () => {
          const i = self.waiters?.indexOf(resolve) ?? -1;
          if (i >= 0) self.waiters!.splice(i, 1);
        };
      }),
      (exit) => I.exec(exit, f),
    );
  });
export { await_ as await };
type Done<R> = { <A, E>(self: Deferred<A, E>, ...args: any): I.Effect<R> };
export const done: {
  <A, E>(exit: I.Exit<A, E>): (self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, exit: I.Exit<A, E>): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, exit: I.Exit<any, any>) => I.make(() => doneUnsafe(self, exit)));
export const succeed: {
  <A>(value: A): <E>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, value: A): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, a: unknown) => I.make(() => doneUnsafe(self, I.exitSucceed(a))));
export const sync: {
  <A>(f: () => A): <E>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, f: () => A): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, f: () => unknown) => I.make(() => doneUnsafe(self, I.exitSucceed(f()))));
export const fail: {
  <E>(error: E): <A>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, error: E): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, e: unknown) => I.make(() => doneUnsafe(self, I.exitFailCause(I.causeFail(e)))));
export const failSync: {
  <E>(f: () => E): <A>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, f: () => E): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, f: () => unknown) => I.make(() => doneUnsafe(self, I.exitFailCause(I.causeFail(f())))));
export const failCause: {
  <E>(cause: I.Cause<E>): <A>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, cause: I.Cause<E>): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, c: I.Cause<any>) => I.make(() => doneUnsafe(self, I.exitFailCause(c))));
export const failCauseSync: {
  <E>(f: () => I.Cause<E>): <A>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, f: () => I.Cause<E>): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, f: () => I.Cause<any>) => I.make(() => doneUnsafe(self, I.exitFailCause(f()))));
export const die: {
  (defect: unknown): <A, E>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, defect: unknown): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, d: unknown) => I.make(() => doneUnsafe(self, I.exitFailCause(I.causeDie(d)))));
export const dieSync: {
  (f: () => unknown): <A, E>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, f: () => unknown): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, f: () => unknown) => I.make(() => doneUnsafe(self, I.exitFailCause(I.causeDie(f())))));
export const interrupt = <A, E>(self: Deferred<A, E>): I.Effect<boolean> => I.make((f) => doneUnsafe(self, I.exitFailCause(I.causeInterrupt(f.id))));
export const interruptWith: {
  (fiberId: number): <A, E>(self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, fiberId: number): I.Effect<boolean>;
} = I.dual(2, (self: Deferred<any, any>, id: number) => I.make(() => doneUnsafe(self, I.exitFailCause(I.causeInterrupt(id)))));
/** Complete with the result of running `effect`. */
export const complete: {
  <A, E, R>(effect: I.Effect<A, E, R>): (self: Deferred<A, E>) => I.Effect<boolean, never, R>;
  <A, E, R>(self: Deferred<A, E>, effect: I.Effect<A, E, R>): I.Effect<boolean, never, R>;
} = I.dual(2, (self: Deferred<any, any>, eff: I.Effect<any, any, any>) =>
  I.make((f) => I.settle(() => I.exec(eff, f), (a) => doneUnsafe(self, I.exitSucceed(a)), (e) => doneUnsafe(self, I.exitFailCause(I.toCause(e))))));
export const completeWith: {
  <A, E>(effect: I.Effect<A, E>): (self: Deferred<A, E>) => I.Effect<boolean>;
  <A, E>(self: Deferred<A, E>, effect: I.Effect<A, E>): I.Effect<boolean>;
} = complete as never;
/** Run `self` and complete `deferred` with its exit. */
export const into: {
  <A, E>(deferred: Deferred<A, E>): <R>(self: I.Effect<A, E, R>) => I.Effect<boolean, never, R>;
  <A, E, R>(self: I.Effect<A, E, R>, deferred: Deferred<A, E>): I.Effect<boolean, never, R>;
} = I.dual(2, (eff: I.Effect<any, any, any>, d: Deferred<any, any>) => complete(d, eff));
export const isDone = (self: Deferred<any, any>): I.Effect<boolean> => I.make(() => self.exit !== undefined);
export const poll = <A, E>(self: Deferred<A, E>): I.Effect<O.Option<I.Effect<A, E>>> => I.make(() => O.fromUndefinedOr(self.exit as I.Effect<A, E> | undefined));
