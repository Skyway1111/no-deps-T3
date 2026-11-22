import * as I from "./internal.ts";
import * as PS from "./PubSub.ts";
import * as Q from "./Queue.ts";
import * as S from "./Stream.ts";
import * as O from "./Option.ts";
import { Semaphore } from "./Semaphore.ts";

export const TypeId: unique symbol = Symbol.for("effect/SubscriptionRef") as never;
/** A Ref whose `changes` stream emits the current value then every update. */
export class SubscriptionRef<in out A> implements I.Pipeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  value: A;
  readonly pubsub = PS.makeUnsafe<A>();
  readonly semaphore = new Semaphore(1);
  private listeners: Set<(a: A) => void> | undefined;
  constructor(value: A) {
    this.value = value;
  }
  setUnsafe(a: A) {
    this.value = a;
    PS.publishUnsafe(this.pubsub, a);
    if (this.listeners) for (const l of [...this.listeners]) l(a);
  }
  /** Synchronous change listener; returns unsubscribe. */
  listen(f: (a: A) => void): () => void {
    (this.listeners ??= new Set()).add(f);
    return () => this.listeners?.delete(f);
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const isSubscriptionRef = (u: unknown): u is SubscriptionRef<unknown> => u instanceof SubscriptionRef;
export const makeUnsafe = <A>(value: A) => new SubscriptionRef(value);
export const make = <A>(value: A): I.Effect<SubscriptionRef<A>> => I.make(() => new SubscriptionRef(value));
export const getUnsafe = <A>(self: SubscriptionRef<A>): A => self.value;
export const get = <A>(self: SubscriptionRef<A>): I.Effect<A> => I.make(() => self.value);
export const changes = <A>(self: SubscriptionRef<A>): S.Stream<A> =>
  S.fromOpen((_, scope) => {
    const sub = PS.subscribeUnsafe(self.pubsub);
    scope.add(() => I.make(() => PS.unsubscribeUnsafe(self.pubsub, sub)));
    let first: ReadonlyArray<A> | undefined = [self.value];
    const q = sub as unknown as Q.QueueImpl<A>;
    return (f) => {
      if (first) {
        const c = first;
        first = undefined;
        return c;
      }
      return I.exec(Q.takeBetween(q, 1, 4096), f) as I.Step<ReadonlyArray<A>>;
    };
  });
const mut = <Args extends Array<any>, R>(f: (self: SubscriptionRef<any>, ...args: Args) => R) =>
  I.dual(f.length, (self: SubscriptionRef<any>, ...args: Args) => self.semaphore.withPermit(I.make(() => f(self, ...args))));
export const set: { <A>(a: A): (self: SubscriptionRef<A>) => I.Effect<void>; <A>(self: SubscriptionRef<A>, a: A): I.Effect<void> } =
  mut((self, a: unknown) => self.setUnsafe(a));
export const getAndSet: { <A>(a: A): (self: SubscriptionRef<A>) => I.Effect<A>; <A>(self: SubscriptionRef<A>, a: A): I.Effect<A> } =
  mut((self, a: unknown) => {
    const old = self.value;
    self.setUnsafe(a);
    return old;
  });
export const update: { <A>(f: (a: A) => A): (self: SubscriptionRef<A>) => I.Effect<void>; <A>(self: SubscriptionRef<A>, f: (a: A) => A): I.Effect<void> } =
  mut((self, f: (a: any) => any) => self.setUnsafe(f(self.value)));
export const updateAndGet: { <A>(f: (a: A) => A): (self: SubscriptionRef<A>) => I.Effect<A>; <A>(self: SubscriptionRef<A>, f: (a: A) => A): I.Effect<A> } =
  mut((self, f: (a: any) => any) => (self.setUnsafe(f(self.value)), self.value));
export const getAndUpdate: { <A>(f: (a: A) => A): (self: SubscriptionRef<A>) => I.Effect<A>; <A>(self: SubscriptionRef<A>, f: (a: A) => A): I.Effect<A> } =
  mut((self, f: (a: any) => any) => {
    const old = self.value;
    self.setUnsafe(f(old));
    return old;
  });
export const modify: {
  <A, B>(f: (a: A) => readonly [B, A]): (self: SubscriptionRef<A>) => I.Effect<B>;
  <A, B>(self: SubscriptionRef<A>, f: (a: A) => readonly [B, A]): I.Effect<B>;
} = mut((self, f: (a: any) => readonly [any, any]) => {
  const [b, a] = f(self.value);
  self.setUnsafe(a);
  return b;
});
export const updateSome: { <A>(f: (a: A) => O.Option<A>): (self: SubscriptionRef<A>) => I.Effect<void>; <A>(self: SubscriptionRef<A>, f: (a: A) => O.Option<A>): I.Effect<void> } =
  mut((self, f: (a: any) => O.Option<any>) => {
    const o = f(self.value);
    if (o._tag === "Some") self.setUnsafe(o.value);
  });
export const modifySome: {
  <A, B>(f: (a: A) => readonly [B, O.Option<A>]): (self: SubscriptionRef<A>) => I.Effect<B>;
  <A, B>(self: SubscriptionRef<A>, f: (a: A) => readonly [B, O.Option<A>]): I.Effect<B>;
} = mut((self, f: (a: any) => readonly [any, O.Option<any>]) => {
  const [b, o] = f(self.value);
  if (o._tag === "Some") self.setUnsafe(o.value);
  return b;
});
const mutEff = <Args extends Array<any>>(f: (self: SubscriptionRef<any>, fib: I.Fiber, ...args: Args) => I.Step<any>) =>
  I.dual(f.length - 1, (self: SubscriptionRef<any>, ...args: Args) => self.semaphore.withPermit(I.make((fib) => f(self, fib, ...args))));
export const updateEffect: {
  <A, E, R>(f: (a: A) => I.Effect<A, E, R>): (self: SubscriptionRef<A>) => I.Effect<void, E, R>;
  <A, E, R>(self: SubscriptionRef<A>, f: (a: A) => I.Effect<A, E, R>): I.Effect<void, E, R>;
} = mutEff((self, fib, f: (a: any) => I.Effect<any, any, any>) => I.chain(I.exec(f(self.value), fib), (a) => self.setUnsafe(a)));
export const modifyEffect: {
  <A, B, E, R>(f: (a: A) => I.Effect<readonly [B, A], E, R>): (self: SubscriptionRef<A>) => I.Effect<B, E, R>;
  <A, B, E, R>(self: SubscriptionRef<A>, f: (a: A) => I.Effect<readonly [B, A], E, R>): I.Effect<B, E, R>;
} = mutEff((self, fib, f: (a: any) => I.Effect<readonly [any, any], any, any>) => I.chain(I.exec(f(self.value), fib), ([b, a]) => (self.setUnsafe(a), b)));
