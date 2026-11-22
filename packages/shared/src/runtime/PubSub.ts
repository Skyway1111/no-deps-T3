import * as I from "./internal.ts";
import * as Q from "./Queue.ts";
import * as ScopeM from "./Scope.ts";

export const TypeId: unique symbol = Symbol.for("effect/PubSub") as never;
type Strategy = "suspend" | "dropping" | "sliding";
export class PubSub<in out A> implements I.Pipeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  readonly subscribers = new Set<Q.QueueImpl<A, never>>();
  shutdown = false;
  readonly capacity: number;
  readonly strategy: Strategy;
  readonly replay: Array<A> | undefined;
  readonly replaySize: number;
  constructor(capacity: number, strategy: Strategy, replay = 0) {
    this.capacity = capacity;
    this.strategy = strategy;
    this.replaySize = replay;
    this.replay = replay > 0 ? [] : undefined;
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export interface Subscription<out A> extends Q.Dequeue<A> {}
export const isPubSub = (u: unknown): u is PubSub<unknown> => u instanceof PubSub;
const mk = <A>(capacity: number, strategy: Strategy, o?: { readonly replay?: number }) => I.make(() => new PubSub<A>(capacity, strategy, o?.replay));
export const unbounded = <A>(options?: { readonly replay?: number }): I.Effect<PubSub<A>> => mk(Infinity, "sliding", options);
export const bounded = <A>(capacity: number | { readonly capacity: number; readonly replay?: number }): I.Effect<PubSub<A>> =>
  typeof capacity === "number" ? mk(capacity, "suspend") : mk(capacity.capacity, "suspend", capacity);
export const sliding = <A>(capacity: number | { readonly capacity: number; readonly replay?: number }): I.Effect<PubSub<A>> =>
  typeof capacity === "number" ? mk(capacity, "sliding") : mk(capacity.capacity, "sliding", capacity);
export const dropping = <A>(capacity: number | { readonly capacity: number; readonly replay?: number }): I.Effect<PubSub<A>> =>
  typeof capacity === "number" ? mk(capacity, "dropping") : mk(capacity.capacity, "dropping", capacity);
export const makeUnsafe = <A>(o?: { readonly capacity?: number; readonly strategy?: Strategy; readonly replay?: number }) =>
  new PubSub<A>(o?.capacity ?? Infinity, o?.strategy ?? "sliding", o?.replay);

/** Deliver to every subscriber; suspend strategy waits for room in each. */
const publishStep = <A>(self: PubSub<A>, a: A, f: I.Fiber): I.Step<boolean> => {
  if (self.shutdown) return false;
  if (self.replay) {
    self.replay.push(a);
    if (self.replay.length > self.replaySize) self.replay.shift();
  }
  let waits: Array<I.Effect<boolean>> | undefined;
  for (const sub of self.subscribers) {
    const r = sub.tryOffer(a);
    if (r === "wait") (waits ??= []).push(Q.offer(sub, a));
  }
  if (!waits) return true;
  let i = 0;
  const loop = (): I.Step<boolean> => (i < waits!.length ? I.chain(I.exec(waits![i++]!, f), loop) : true);
  return loop();
};
export const publishUnsafe = <A>(self: PubSub<A>, a: A): boolean => {
  if (self.shutdown) return false;
  for (const sub of self.subscribers) sub.tryOffer(a);
  return true;
};
export const publish: { <A>(a: A): (self: PubSub<A>) => I.Effect<boolean>; <A>(self: PubSub<A>, a: A): I.Effect<boolean> } =
  I.dual(2, (self: PubSub<any>, a: unknown) => I.make((f) => publishStep(self, a, f)));
export const publishAll: { <A>(as: Iterable<A>): (self: PubSub<A>) => I.Effect<boolean>; <A>(self: PubSub<A>, as: Iterable<A>): I.Effect<boolean> } =
  I.dual(2, (self: PubSub<any>, as: Iterable<unknown>) =>
    I.make((f) => {
      const it = as[Symbol.iterator]();
      const loop = (): I.Step<boolean> => {
        for (let s = it.next(); !s.done; s = it.next()) {
          const r = publishStep(self, s.value, f);
          if (r instanceof I.Async) return I.chain(r, loop);
          if (!r) return false;
        }
        return true;
      };
      return loop();
    }));
export const subscribeUnsafe = <A>(self: PubSub<A>): Subscription<A> => {
  const sub = new Q.QueueImpl<A, never>(self.capacity, self.strategy);
  if (self.replay) for (const a of self.replay) sub.push(a);
  if (self.shutdown) sub.close(I.causeInterrupt());
  else self.subscribers.add(sub);
  return sub as never;
};
export const unsubscribeUnsafe = <A>(self: PubSub<A>, sub: Subscription<A>) => {
  self.subscribers.delete(sub as never);
  (sub as unknown as Q.QueueImpl<A>).close(I.causeInterrupt());
};
/** Subscribe for the lifetime of the current Scope. */
export const subscribe = <A>(self: PubSub<A>): I.Effect<Subscription<A>, never, ScopeM.Scope> =>
  I.make((f) => {
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    const sub = subscribeUnsafe(self);
    sc.add(() => I.make(() => unsubscribeUnsafe(self, sub)));
    return sub;
  });
export const shutdown = <A>(self: PubSub<A>): I.Effect<void> =>
  I.make(() => {
    self.shutdown = true;
    for (const s of self.subscribers) s.close(I.causeInterrupt());
    self.subscribers.clear();
  });
export const isShutdown = <A>(self: PubSub<A>): I.Effect<boolean> => I.make(() => self.shutdown);
export const size = <A>(self: PubSub<A>): I.Effect<number> => I.make(() => Math.max(0, ...[...self.subscribers].map((s) => s.size)));
export const take = Q.take;
export const takeAll = Q.takeAll;
export const takeUpTo: { (max: number): <A>(self: Subscription<A>) => I.Effect<Array<A>>; <A>(self: Subscription<A>, max: number): I.Effect<Array<A>> } =
  I.dual(2, (self: Subscription<any>, max: number) => I.make(() => (self as unknown as Q.QueueImpl<any>).shiftN(max)));
