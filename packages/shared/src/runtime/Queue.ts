import * as I from "./internal.ts";
import * as O from "./Option.ts";
import { Done } from "./errors.ts";

export const TypeId: unique symbol = Symbol.for("effect/Queue") as never;
export const EnqueueTypeId: unique symbol = Symbol.for("effect/Queue/Enqueue") as never;
export const DequeueTypeId: unique symbol = Symbol.for("effect/Queue/Dequeue") as never;
type Strategy = "suspend" | "dropping" | "sliding";

/** FIFO with O(1) amortized push/shift; waiters re-check on every state change. */
export class QueueImpl<in out A, in out E = never> implements I.Pipeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  readonly [EnqueueTypeId]: typeof EnqueueTypeId = EnqueueTypeId;
  readonly [DequeueTypeId]: typeof DequeueTypeId = DequeueTypeId;
  items: Array<A> = [];
  head = 0;
  done: I.Cause<E> | undefined = undefined;
  readonly capacity: number;
  readonly strategy: Strategy;
  takers = new Set<() => void>();
  putters = new Set<() => void>();
  constructor(capacity: number, strategy: Strategy) {
    this.capacity = capacity;
    this.strategy = strategy;
  }
  get size() {
    return this.items.length - this.head;
  }
  push(a: A) {
    this.items.push(a);
  }
  shiftN(n: number): Array<A> {
    const out = this.items.slice(this.head, this.head + n);
    this.head += out.length;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    if (out.length && this.putters.size) for (const p of [...this.putters]) p();
    return out;
  }
  wakeTakers() {
    if (this.takers.size) for (const t of [...this.takers]) t();
  }
  /** Returns false if dropped/closed; "wait" if full under suspend. */
  tryOffer(a: A): boolean | "wait" {
    if (this.done) return false;
    if (this.size >= this.capacity) {
      if (this.strategy === "dropping") return false;
      if (this.strategy === "sliding") this.shiftN(1);
      else return "wait";
    }
    this.push(a);
    this.wakeTakers();
    return true;
  }
  close(cause: I.Cause<E>): boolean {
    if (this.done) return false;
    this.done = cause;
    this.wakeTakers();
    if (this.putters.size) for (const p of [...this.putters]) p();
    return true;
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export interface Queue<in out A, in out E = never> extends QueueImpl<A, E> {}
export interface Enqueue<in out A, in out E = never> extends QueueImpl<A, E> {}
export interface Dequeue<in out A, in out E = never> extends QueueImpl<A, E> {}
export const isQueue = (u: unknown): u is Queue<unknown, unknown> => u instanceof QueueImpl;
export const isEnqueue = isQueue as (u: unknown) => u is Enqueue<unknown, unknown>;
export const isDequeue = isQueue as (u: unknown) => u is Dequeue<unknown, unknown>;
export const asEnqueue = <A, E>(q: Queue<A, E>): Enqueue<A, E> => q as never;
export const asDequeue = <A, E>(q: Queue<A, E>): Dequeue<A, E> => q as never;

export const make = <A, E = never>(options?: { readonly capacity?: number; readonly strategy?: Strategy }): I.Effect<Queue<A, E>> =>
  I.make(() => new QueueImpl<A, E>(options?.capacity ?? Infinity, options?.strategy ?? "suspend"));
export const makeUnsafe = <A, E = never>(options?: { readonly capacity?: number; readonly strategy?: Strategy }): Queue<A, E> =>
  new QueueImpl<A, E>(options?.capacity ?? Infinity, options?.strategy ?? "suspend");
export const bounded = <A, E = never>(capacity: number) => make<A, E>({ capacity });
export const sliding = <A, E = never>(capacity: number) => make<A, E>({ capacity, strategy: "sliding" });
export const dropping = <A, E = never>(capacity: number) => make<A, E>({ capacity, strategy: "dropping" });
export const unbounded = <A, E = never>() => make<A, E>();

const q = (x: unknown) => x as QueueImpl<any, any>;
export const offerUnsafe = <A, E>(self: Enqueue<A, E>, a: NoInfer<A>): boolean => q(self).tryOffer(a) === true;
export const offer: { <A>(a: A): <E>(self: Enqueue<A, E>) => I.Effect<boolean>; <A, E>(self: Enqueue<A, E>, a: NoInfer<A>): I.Effect<boolean> } =
  I.dual(2, (self: QueueImpl<any, any>, a: unknown) =>
    I.make((f) => {
      const r = self.tryOffer(a);
      if (r !== "wait") return r;
      return I.interruptibleWait<boolean>(f, (resolve) => {
        const retry = () => {
          const r2 = self.tryOffer(a);
          if (r2 !== "wait") {
            self.putters.delete(retry);
            resolve(r2);
          }
        };
        self.putters.add(retry);
        return () => self.putters.delete(retry);
      });
    }));
export const offerAllUnsafe = <A, E>(self: Enqueue<A, E>, as: Iterable<A>): Array<A> => {
  const rejected: Array<A> = [];
  for (const a of as) if (q(self).tryOffer(a) !== true) rejected.push(a);
  return rejected;
};
export const offerAll: { <A>(as: Iterable<A>): <E>(self: Enqueue<A, E>) => I.Effect<Array<A>>; <A, E>(self: Enqueue<A, E>, as: Iterable<NoInfer<A>>): I.Effect<Array<A>> } =
  I.dual(2, (self: QueueImpl<any, any>, as: Iterable<unknown>) =>
    I.make((f) => {
      const arr = [...as];
      const rejected: Array<unknown> = [];
      let i = 0;
      const loop = (): I.Step<Array<unknown>> => {
        while (i < arr.length) {
          const r = self.tryOffer(arr[i]);
          if (r === "wait") return I.chain(I.exec(offer(self, arr[i++]), f), (ok) => (ok || rejected.push(arr[i - 1]), loop()));
          if (!r) rejected.push(arr[i]);
          i++;
        }
        return rejected;
      };
      return loop();
    }));
export const failCauseUnsafe = <A, E>(self: Enqueue<A, E>, cause: I.Cause<E>): boolean => q(self).close(cause);
export const failCause: { <E>(cause: I.Cause<E>): <A>(self: Enqueue<A, E>) => I.Effect<boolean>; <A, E>(self: Enqueue<A, E>, cause: I.Cause<E>): I.Effect<boolean> } =
  I.dual(2, (self: QueueImpl<any, any>, c: I.Cause<any>) => I.make(() => self.close(c)));
export const fail: { <E>(error: E): <A>(self: Enqueue<A, E>) => I.Effect<boolean>; <A, E>(self: Enqueue<A, E>, error: E): I.Effect<boolean> } =
  I.dual(2, (self: QueueImpl<any, any>, e: unknown) => I.make(() => self.close(I.causeFail(e))));
export const endUnsafe = <A, E>(self: Enqueue<A, E | Done>): boolean => q(self).close(I.causeFail(Done()));
export const end = <A, E>(self: Enqueue<A, E | Done>): I.Effect<boolean> => I.make(() => endUnsafe(self));
export const shutdownUnsafe = <A, E>(self: Enqueue<A, E>): boolean => {
  const s = q(self);
  s.items = [];
  s.head = 0;
  return s.close(I.causeInterrupt());
};
export const shutdown = <A, E>(self: Enqueue<A, E>): I.Effect<boolean> => I.make(() => shutdownUnsafe(self));
export const interrupt = <A, E>(self: Enqueue<A, E>): I.Effect<boolean> => I.make((f) => q(self).close(I.causeInterrupt(f.id)));

/** Wait until at least `min` items (or closed), then take up to `max`. */
const takeBetweenStep = (self: QueueImpl<any, any>, min: number, max: number, f: I.Fiber): I.Step<Array<any>> => {
  const ready = () => self.size >= min || (self.done !== undefined);
  const take = (): Array<any> => {
    if (self.size === 0 && self.done) return I.failWith(self.done);
    return self.shiftN(max);
  };
  if (ready()) return take();
  return I.chain(
    I.interruptibleWait<void>(f, (resolve) => {
      const check = () => {
        if (ready()) {
          self.takers.delete(check);
          resolve();
        }
      };
      self.takers.add(check);
      return () => self.takers.delete(check);
    }),
    take,
  );
};
export const takeBetween: {
  (min: number, max: number): <A, E>(self: Dequeue<A, E>) => I.Effect<Array<A>, E>;
  <A, E>(self: Dequeue<A, E>, min: number, max: number): I.Effect<Array<A>, E>;
} = I.dual(3, (self: QueueImpl<any, any>, min: number, max: number) => I.make((f) => takeBetweenStep(self, Math.max(1, min), max, f)));
export const take = <A, E>(self: Dequeue<A, E>): I.Effect<A, E> => I.make((f) => I.chain(takeBetweenStep(q(self), 1, 1, f), (xs) => xs[0]));
export const takeAll = <A, E>(self: Dequeue<A, E>): I.Effect<[A, ...Array<A>], E> => I.make((f) => takeBetweenStep(q(self), 1, Infinity, f) as never);
export const collect = <A, E>(self: Dequeue<A, E | Done>): I.Effect<Array<A>, Exclude<E, Done>> =>
  I.make((f) => {
    const out: Array<A> = [];
    const loop = (): I.Step<Array<A>> =>
      I.settle(() => takeBetweenStep(q(self), 1, Infinity, f), (xs) => (out.push(...xs), loop()), (e) => {
        const c = I.toCause(e);
        const fl = c.reasons.find((r) => r._tag === "Fail") as I.Fail<unknown> | undefined;
        return fl && (fl.error as Done)?._tag === "Done" ? out : I.failWith(c);
      });
    return loop();
  });
export const takeN: { (n: number): <A, E>(self: Dequeue<A, E>) => I.Effect<Array<A>, E>; <A, E>(self: Dequeue<A, E>, n: number): I.Effect<Array<A>, E> } =
  I.dual(2, (self: QueueImpl<any, any>, n: number) => I.make((f) => (!(n >= 1) ? [] : takeBetweenStep(self, Math.min(Math.floor(n), self.capacity), Math.floor(n), f))));
export const takeUnsafe = <A, E>(self: Dequeue<A, E>): A | undefined => (q(self).size > 0 ? q(self).shiftN(1)[0] : undefined);
export const poll = <A, E>(self: Dequeue<A, E>): I.Effect<O.Option<A>> => I.make(() => (q(self).size > 0 ? O.some(q(self).shiftN(1)[0]) : O.none()));
export const peek = <A, E>(self: Dequeue<A, E>): I.Effect<A, E> =>
  I.make((f) => {
    const s = q(self);
    if (s.size > 0) return s.items[s.head];
    return I.chain(takeBetweenStep(s, 1, 0, f), () => (s.size > 0 ? s.items[s.head] : I.failWith(s.done!)));
  });
export const flushUnsafe = <A, E>(self: Dequeue<A, E>): Array<A> => q(self).shiftN(Infinity);
export const flush = <A, E>(self: Dequeue<A, E>): I.Effect<Array<A>> => I.make(() => flushUnsafe(self));
export const clear = <A, E>(self: Dequeue<A, E>): I.Effect<Array<A>> => I.make(() => q(self).shiftN(Infinity));
export const sizeUnsafe = <A, E>(self: Dequeue<A, E>): number => q(self).size;
export const size = <A, E>(self: Dequeue<A, E>): I.Effect<number> => I.make(() => q(self).size);
export const isFullUnsafe = <A, E>(self: Dequeue<A, E>): boolean => q(self).size >= q(self).capacity;
export const isFull = <A, E>(self: Dequeue<A, E>): I.Effect<boolean> => I.make(() => isFullUnsafe(self));
export const isShutdown = <A, E>(self: Dequeue<A, E>): I.Effect<boolean> => I.make(() => q(self).done !== undefined);
/** Run `effect` and close the queue with its result. */
export const into: {
  <A, E>(self: Enqueue<A, E | Done>): <AX, EX extends E, RX>(effect: I.Effect<AX, EX, RX>) => I.Effect<boolean, never, RX>;
  <AX, E, EX extends E, RX, A>(effect: I.Effect<AX, EX, RX>, self: Enqueue<A, E | Done>): I.Effect<boolean, never, RX>;
} = I.dual(2, (eff: I.Effect<any, any, any>, self: QueueImpl<any, any>) =>
  I.make((f) => I.settle(() => I.exec(eff, f), () => self.close(I.causeFail(Done())), (e) => self.close(I.toCause(e)))));
