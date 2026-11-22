import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as ScopeM from "./Scope.ts";

/** FIFO permit semaphore; waiters are served strictly in order. */
export class Semaphore implements I.Pipeable {
  permits: number;
  taken = 0;
  private readonly waiters: Array<{ n: number; wake: () => void }> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  get available() {
    return this.permits - this.taken;
  }
  private drain() {
    while (this.waiters.length && this.waiters[0]!.n <= this.available) {
      const w = this.waiters.shift()!;
      this.taken += w.n;
      w.wake();
    }
  }
  takeStep(n: number, f: I.Fiber): I.Step<number> {
    if (this.waiters.length === 0 && n <= this.available) {
      this.taken += n;
      return n;
    }
    return I.chain(
      I.interruptibleWait<void>(f, (resolve) => {
        const w = { n, wake: () => resolve() };
        this.waiters.push(w);
        return () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          else this.releaseUnsafe(n);
          this.drain();
        };
      }),
      () => n,
    );
  }
  releaseUnsafe(n: number): number {
    this.taken = Math.max(0, this.taken - n);
    this.drain();
    return this.available;
  }
  resize(permits: number): I.Effect<void> {
    return I.make(() => {
      this.permits = permits;
      this.drain();
    });
  }
  withPermits(n: number) {
    return <A, E, R>(self: I.Effect<A, E, R>): I.Effect<A, E, R> =>
      I.make((f) => {
        return I.chain(this.takeStep(n, f), () =>
          I.settle(
            () => I.exec(self, f),
            (a) => (this.releaseUnsafe(n), a),
            (e) => (this.releaseUnsafe(n), I.failWith(I.toCause(e))),
          ));
      });
  }
  withPermit<A, E, R>(self: I.Effect<A, E, R>): I.Effect<A, E, R> {
    return this.withPermits(1)(self);
  }
  withPermitsIfAvailable(n: number) {
    return <A, E, R>(self: I.Effect<A, E, R>): I.Effect<O.Option<A>, E, R> =>
      I.make((f) => {
        if (this.waiters.length || n > this.available) return O.none();
        this.taken += n;
        return I.settle(() => I.exec(self, f), (a) => (this.releaseUnsafe(n), O.some(a)), (e) => (this.releaseUnsafe(n), I.failWith(I.toCause(e))));
      });
  }
  take(n: number): I.Effect<number> {
    return I.make((f) => this.takeStep(n, f));
  }
  takeIfAvailable(n: number): I.Effect<boolean> {
    return I.make(() => {
      if (this.waiters.length || n > this.available) return false;
      this.taken += n;
      return true;
    });
  }
  takeScoped(n: number): I.Effect<void, never, ScopeM.Scope> {
    return I.make((f) => {
      const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
      if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
      return I.chain(this.takeStep(n, f), () => void sc.add(() => I.make(() => this.releaseUnsafe(n))));
    });
  }
  release(n: number): I.Effect<number> {
    return I.make(() => this.releaseUnsafe(n));
  }
  get releaseAll(): I.Effect<number> {
    return I.make(() => this.releaseUnsafe(this.taken));
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const makeUnsafe = (permits: number): Semaphore => new Semaphore(permits);
export const make = (permits: number): I.Effect<Semaphore> => I.make(() => new Semaphore(permits));
export const withPermits: {
  (self: Semaphore, permits: number): <A, E, R>(effect: I.Effect<A, E, R>) => I.Effect<A, E, R>;
} = (self, n) => self.withPermits(n);
export const withPermit = (self: Semaphore) => <A, E, R>(effect: I.Effect<A, E, R>) => self.withPermit(effect);
export const withPermitsIfAvailable = (self: Semaphore, n: number) => self.withPermitsIfAvailable(n);
export const take = (self: Semaphore, n: number) => self.take(n);
export const takeScoped = (self: Semaphore, n: number) => self.takeScoped(n);
export const takeIfAvailable = (self: Semaphore, n: number) => self.takeIfAvailable(n);
export const release = (self: Semaphore, n: number) => self.release(n);
export const releaseAll = (self: Semaphore) => self.releaseAll;
export const resize = (self: Semaphore, n: number) => self.resize(n);
