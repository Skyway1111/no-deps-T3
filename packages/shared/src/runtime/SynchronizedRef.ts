import * as I from "./internal.ts";
import { Ref, get, set, update, modify, getAndSet, getAndUpdate, updateAndGet, setAndGet } from "./Ref.ts";
import { Semaphore } from "./Semaphore.ts";

export class SynchronizedRef<in out A> extends Ref<A> {
  readonly semaphore = new Semaphore(1);
}
export const makeUnsafe = <A>(value: A): SynchronizedRef<A> => new SynchronizedRef(value);
export const make = <A>(value: A): I.Effect<SynchronizedRef<A>> => I.make(() => new SynchronizedRef(value));
export { get, set, update, modify, getAndSet, getAndUpdate, updateAndGet, setAndGet };
export const modifyEffect: {
  <A, B, E, R>(f: (a: A) => I.Effect<readonly [B, A], E, R>): (self: SynchronizedRef<A>) => I.Effect<B, E, R>;
  <A, B, E, R>(self: SynchronizedRef<A>, f: (a: A) => I.Effect<readonly [B, A], E, R>): I.Effect<B, E, R>;
} = I.dual(2, (self: SynchronizedRef<any>, f: (a: any) => I.Effect<readonly [any, any], any, any>) =>
  self.semaphore.withPermit(I.make((fib) => I.chain(I.exec(f(self.value), fib), ([b, a]) => ((self.value = a), b)))));
export const updateEffect: {
  <A, E, R>(f: (a: A) => I.Effect<A, E, R>): (self: SynchronizedRef<A>) => I.Effect<void, E, R>;
  <A, E, R>(self: SynchronizedRef<A>, f: (a: A) => I.Effect<A, E, R>): I.Effect<void, E, R>;
} = I.dual(2, (self: SynchronizedRef<any>, f: (a: any) => I.Effect<any, any, any>) =>
  self.semaphore.withPermit(I.make((fib) => I.chain(I.exec(f(self.value), fib), (a) => void (self.value = a)))));
export const updateAndGetEffect: {
  <A, E, R>(f: (a: A) => I.Effect<A, E, R>): (self: SynchronizedRef<A>) => I.Effect<A, E, R>;
  <A, E, R>(self: SynchronizedRef<A>, f: (a: A) => I.Effect<A, E, R>): I.Effect<A, E, R>;
} = I.dual(2, (self: SynchronizedRef<any>, f: (a: any) => I.Effect<any, any, any>) =>
  self.semaphore.withPermit(I.make((fib) => I.chain(I.exec(f(self.value), fib), (a) => (self.value = a)))));
