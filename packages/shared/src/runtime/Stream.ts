import * as I from "./internal.ts";
import { Async, chain, exec, Failure, settle, type Step } from "./internal.ts";
import * as Effect from "./Effect.ts";
import * as O from "./Option.ts";
import * as D from "./Duration.ts";
import * as Q from "./Queue.ts";
import * as PS from "./PubSub.ts";
import * as ScopeM from "./Scope.ts";
import * as Sched from "./Schedule.ts";
import { sleepMillis } from "./Clock.ts";
import { Done, isDone } from "./errors.ts";

export const TypeId: unique symbol = Symbol.for("effect/Stream") as never;
/** Pull the next non-empty chunk; throws END when exhausted. */
export type RawPull<A> = (f: I.Fiber) => Step<ReadonlyArray<A>>;
type Open<A> = (f: I.Fiber, scope: ScopeM.ScopeImpl) => Step<RawPull<A>>;
export interface Stream<out A, out E = never, out R = never> extends I.Pipeable {
  readonly [TypeId]: { _A: (_: never) => A; _E: (_: never) => E; _R: (_: never) => R };
  readonly open: Open<any>;
}
export declare namespace Stream {
  type Success<T> = T extends Stream<infer A, any, any> ? A : never;
  type Error<T> = T extends Stream<any, infer E, any> ? E : never;
  type Services<T> = T extends Stream<any, any, infer R> ? R : never;
}
export type Success<T> = Stream.Success<T>;
export type Error<T> = Stream.Error<T>;
export type Services<T> = Stream.Services<T>;
type Any = Stream<any, any, any>;
type LazyArg<A> = () => A;

const END = new Failure(I.causeFail(Done()));
const isEnd = (e: unknown): boolean => {
  if (e === END) return true;
  if (!(e instanceof Failure)) return false;
  const r = e.cause.reasons;
  return r.length === 1 && r[0]!._tag === "Fail" && isDone(r[0]!.error);
};
const end = (): never => {
  throw END;
};
const proto = { [TypeId]: {}, ...I.PipeProto };
export const fromOpen = <A, E = never, R = never>(open: Open<A>): Stream<A, E, R> => Object.assign(Object.create(proto), { open });
export const isStream = (u: unknown): u is Any => typeof u === "object" && u !== null && TypeId in u;
const rethrow = (e: unknown): never => {
  throw e instanceof Failure ? e : new Failure(I.causeDie(e));
};
/** Map each pulled chunk. Empty results are skipped by pulling again. */
const mapPull = <A, B>(self: Any, f: (chunk: ReadonlyArray<A>, fib: I.Fiber) => Step<ReadonlyArray<B>>): Open<B> => (fib, scope) =>
  chain(self.open(fib, scope), (pull: RawPull<A>) => {
    const next: RawPull<B> = (f2) => chain(pull(f2), (c) => chain(f(c, f2), (out) => (out.length ? out : next(f2))));
    return next;
  });

// ---------- constructors ----------
export const empty: Stream<never> = fromOpen(() => end);
export const never: Stream<never> = fromOpen(() => (f) => I.interruptibleWait<never>(f, () => {}));
export const fromArray = <A>(as: ReadonlyArray<A>): Stream<A> =>
  fromOpen(() => {
    let done = as.length === 0;
    return () => (done ? end() : ((done = true), as));
  });
export const fromIterable = <A>(as: Iterable<A>): Stream<A> => (Array.isArray(as) ? fromArray(as) : fromOpen(() => {
  const it = as[Symbol.iterator]();
  return () => {
    const out: Array<A> = [];
    for (let s = it.next(); !s.done; s = it.next()) if (out.push(s.value) >= 4096) break;
    return out.length ? out : end();
  };
}));
export const fromIteratorSucceed = <A>(it: IterableIterator<A>): Stream<A> => fromIterable(it);
export const make = <const As extends ReadonlyArray<any>>(...as: As): Stream<As[number]> => fromArray(as);
export const succeed = <A>(a: A): Stream<A> => fromArray([a]);
export const sync = <A>(f: LazyArg<A>): Stream<A> => fromOpen(() => {
  let done = false;
  return () => (done ? end() : ((done = true), [f()]));
});
export const suspend = <A, E, R>(f: LazyArg<Stream<A, E, R>>): Stream<A, E, R> => fromOpen((fib, scope) => f().open(fib, scope));
export const fail = <E>(e: E): Stream<never, E> => fromOpen(() => () => I.failWith(I.causeFail(e)));
export const failSync = <E>(f: LazyArg<E>): Stream<never, E> => fromOpen(() => () => I.failWith(I.causeFail(f())));
export const failCause = <E>(c: I.Cause<E>): Stream<never, E> => fromOpen(() => () => I.failWith(c));
export const die = (d: unknown): Stream<never> => fromOpen(() => () => I.failWith(I.causeDie(d)));
export const fromEffect = <A, E, R>(eff: Effect.Effect<A, E, R>): Stream<A, E, R> =>
  fromOpen(() => {
    let done = false;
    return (f) => (done ? end() : ((done = true), chain(exec(eff, f), (a) => [a])));
  });
export const fromEffectDrain = <A, E, R>(eff: Effect.Effect<A, E, R>): Stream<never, E, R> =>
  fromOpen(() => {
    let done = false;
    return (f) => (done ? end() : ((done = true), chain(exec(eff, f), end)));
  });
export const fromEffectRepeat = <A, E, R>(eff: Effect.Effect<A, E, R>): Stream<A, E, R> =>
  fromOpen(() => (f) => chain(exec(eff, f), (a) => [a]));
export const repeatEffect = fromEffectRepeat;
export const fromEffectSchedule = <A, E, R, X>(eff: Effect.Effect<A, E, R>, schedule: Sched.Schedule<X, A, any, any>): Stream<A, E, R> =>
  fromOpen(() => {
    const step = schedule.start();
    let first = true, done = false;
    return (f) => {
      if (done) return end();
      const run = () => chain(exec(eff, f), (a) => [a]);
      if (first) {
        first = false;
        return chain(run(), (c) => c);
      }
      return chain(exec(eff, f), (a) => chain(Sched.stepAndSleep(step, a, f, sleepMillis), (m) => (m ? [a] : ((done = true), end()))));
    };
  });
export const unwrap = <A, E, R, E2, R2>(eff: Effect.Effect<Stream<A, E, R>, E2, R2>): Stream<A, E | E2, R | Exclude<R2, ScopeM.Scope>> =>
  fromOpen((fib, scope) =>
    chain(withScope(eff, scope, fib), (s: Stream<A, E, R>) => s.open(fib, scope)));
export const unwrapScoped = unwrap;
export const scoped = <A, E, R>(eff: Effect.Effect<A, E, R>): Stream<A, E, Exclude<R, ScopeM.Scope>> =>
  fromOpen((fib, scope) => {
    let done = false;
    return () => (done ? end() : ((done = true), chain(withScope(eff, scope, fib), (a) => [a])));
  });
const withScope = <A>(eff: Effect.Effect<A, any, any>, scope: ScopeM.ScopeImpl, fib: I.Fiber): Step<A> => {
  const prev = fib.context;
  fib.context = I.contextAdd(prev, ScopeM.Scope.key, scope);
  return settle(() => exec(eff, fib), (a) => ((fib.context = prev), a), (e) => ((fib.context = prev), rethrow(e)));
};
/** Pull from a queue until it ends (Done) or fails. */
const pullQueue = <A>(q: Q.QueueImpl<A, any>, max: number): RawPull<A> => (f) =>
  settle<Array<A>, ReadonlyArray<A>>(
    () => exec(Q.takeBetween(q, 1, max), f),
    (c) => c,
    (e) => (isEnd(e) ? end() : rethrow(e)),
  );
export const fromQueue = <A, E>(queue: Q.Dequeue<A, E>, options?: { readonly maxChunkSize?: number }): Stream<A, Exclude<E, Done>> =>
  fromOpen(() => pullQueue(queue as unknown as Q.QueueImpl<A, E>, options?.maxChunkSize ?? 4096));
export const fromSubscription = <A>(sub: PS.Subscription<A>): Stream<A> => fromQueue(sub);
export const fromPubSub = <A>(pubsub: PS.PubSub<A>, options?: { readonly maxChunkSize?: number }): Stream<A> =>
  fromOpen((_, scope) => {
    const sub = PS.subscribeUnsafe(pubsub);
    scope.add(() => Effect.sync(() => PS.unsubscribeUnsafe(pubsub, sub)));
    return pullQueue(sub as unknown as Q.QueueImpl<A, any>, options?.maxChunkSize ?? 4096);
  });
/** `f(queue)` pushes values; end the queue to finish. Registration runs in the stream's scope. */
export const callback = <A, E = never, R = never>(
  f: (queue: Q.Queue<A, E | Done>) => void | Effect.Effect<unknown, E, R | ScopeM.Scope>,
  options?: { readonly bufferSize?: number; readonly strategy?: "suspend" | "dropping" | "sliding" },
): Stream<A, E, Exclude<R, ScopeM.Scope>> =>
  fromOpen((fib, scope) => {
    const q = Q.makeUnsafe<A, E | Done>({ capacity: options?.bufferSize ?? Infinity, strategy: options?.strategy ?? "sliding" });
    const r = f(q);
    const pull = pullQueue(q as unknown as Q.QueueImpl<A, any>, 4096);
    if (!I.isEffect(r)) return pull;
    const child = I.runFiber(I.make((f2) => withScope(r, scope, f2)), fib.context, undefined, { inheritFrom: fib });
    child.addObserver((exit) => exit._tag === "Failure" && !I.toCause(exit.cause).reasons.every((x) => x._tag === "Interrupt") && q.close(exit.cause));
    scope.add(() => I.make((f2) => (child.interruptAsFork(f2.id), chain(child.awaitStep(undefined), () => undefined))));
    return pull;
  });
export const fromAsyncIterable = <A, E>(iterable: AsyncIterable<A>, onError: (e: unknown) => E): Stream<A, E> =>
  fromOpen((_, scope) => {
    const it = iterable[Symbol.asyncIterator]();
    scope.add(() => Effect.promise(async () => void (await it.return?.())));
    return (f) => chain(exec(Effect.tryPromise({ try: () => it.next(), catch: onError }), f), (r) => (r.done ? end() : [r.value]));
  });
export const fromPull = <A, E, R, EX, RX>(
  pull: Effect.Effect<Effect.Effect<ReadonlyArray<A>, E | Done, R>, EX, RX>,
): Stream<A, Exclude<E, Done> | EX, R | Exclude<RX, ScopeM.Scope>> =>
  fromOpen((fib, scope) => chain(withScope(pull, scope, fib), (p) => (f: I.Fiber) => settle(() => exec(p, f), (c) => (c.length ? c : end()), (e) => (isEnd(e) ? end() : rethrow(e)))));
export const unfold = <S, A>(s: S, f: (s: S) => readonly [A, S] | undefined | O.Option<readonly [A, S]>): Stream<A> =>
  fromOpen(() => {
    let state = s, done = false;
    return () => {
      if (done) return end();
      const r = f(state);
      const v = O.isOption(r) ? O.getOrUndefined(r) : r;
      if (!v) return (done = true), end();
      state = v[1];
      return [v[0]];
    };
  });
export const unfoldEffect = <S, A, E, R>(s: S, f: (s: S) => Effect.Effect<readonly [A, S] | undefined | O.Option<readonly [A, S]>, E, R>): Stream<A, E, R> =>
  fromOpen(() => {
    let state = s, done = false;
    return (fib) => done ? end() : chain(exec(f(state), fib), (r) => {
      const v = O.isOption(r) ? O.getOrUndefined(r) : r;
      if (!v) return (done = true), end();
      state = v[1];
      return [v[0]];
    });
  });
/** `f(s)` returns `[value, nextState]`; a None/undefined next state ends after emitting. */
export const paginate = <S, A, E = never, R = never>(
  s: S,
  f: (s: S) => readonly [ReadonlyArray<A> | A, O.Option<S> | S | undefined] | Effect.Effect<readonly [ReadonlyArray<A> | A, O.Option<S> | S | undefined], E, R>,
): Stream<A, E, R> =>
  fromOpen(() => {
    let state: S | undefined = s, done = false;
    return (fib) => {
      if (done) return end();
      const r = f(state as S);
      return chain(I.isEffect(r) ? exec(r, fib) : r, ([a, next]) => {
        const n = O.isOption(next) ? O.getOrUndefined(next) : next;
        if (n === undefined) done = true;
        else state = n as S;
        const out = Array.isArray(a) ? a : [a];
        return out.length ? out : done ? end() : [];
      });
    };
  });
export const range = (min: number, max: number): Stream<number> => fromOpen(() => {
  let i = min;
  return () => {
    if (i > max) return end();
    const out: Array<number> = [];
    while (i <= max && out.length < 4096) out.push(i++);
    return out;
  };
});
export const tick = (interval: D.Input): Stream<void> => {
  const ms = D.toMillis(interval);
  return fromOpen(() => {
    let first = true;
    return (f) => (first ? ((first = false), [undefined]) : chain(exec(sleepMillis(ms), f), () => [undefined]));
  });
};
export const iterate = <A>(a: A, f: (a: A) => A): Stream<A> => unfold(a, (s) => [s, f(s)] as const);
export const repeatValue = <A>(a: A): Stream<A> => fromOpen(() => () => [a]);

// ---------- transformations ----------
export const map: {
  <A, B>(f: (a: A, i: number) => B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
  <A, E, R, B>(self: Stream<A, E, R>, f: (a: A, i: number) => B): Stream<B, E, R>;
} = I.dual(2, (self: Any, f: (a: any, i: number) => any) => {
  return fromOpen((fib, scope) => {
    let i = 0;
    return mapPull(self, (c) => {
      const out: Array<unknown> = [];
      for (let k = 0; k < c.length; k++) out.push(f(c[k], i++));
      return out;
    })(fib, scope);
  });
});
export const as: { <B>(b: B): <A, E, R>(self: Stream<A, E, R>) => Stream<B, E, R>; <A, E, R, B>(self: Stream<A, E, R>, b: B): Stream<B, E, R> } =
  I.dual(2, (self: Any, b: unknown) => map(self, () => b));
export const filter: {
  <A, B extends A>(f: (a: A) => a is B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
  <A>(f: (a: NoInfer<A>) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R, B extends A>(self: Stream<A, E, R>, f: (a: A) => a is B): Stream<B, E, R>;
  <A, E, R>(self: Stream<A, E, R>, f: (a: A) => boolean): Stream<A, E, R>;
} = I.dual(2, (self: Any, f: (a: any) => boolean) => fromOpen(mapPull(self, (c) => c.filter(f))));
export const filterMap: {
  <A, B>(f: (a: A) => O.Option<B>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
  <A, E, R, B>(self: Stream<A, E, R>, f: (a: A) => O.Option<B>): Stream<B, E, R>;
} = I.dual(2, (self: Any, f: (a: any) => O.Option<any>) =>
  fromOpen(mapPull(self, (c) => {
    const out: Array<any> = [];
    for (const a of c) {
      const o = f(a);
      if (o._tag === "Some") out.push(o.value);
    }
    return out;
  })));
const forEachChunk = <A, B>(c: ReadonlyArray<A>, fib: I.Fiber, f: (a: A) => Effect.Effect<B, any, any>): Step<Array<B>> => {
  const out: Array<B> = [];
  let i = 0;
  const loop = (): Step<Array<B>> => {
    while (i < c.length) {
      const r = exec(f(c[i++]!), fib);
      if (r instanceof Async) return chain(r, (b) => (out.push(b), loop()));
      out.push(r);
    }
    return out;
  };
  return loop();
};
export const filterEffect: {
  <A, E2, R2>(f: (a: A) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<boolean, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, f: (a: any) => Effect.Effect<boolean, any, any>) =>
  fromOpen(mapPull(self, (c, fib) => chain(forEachChunk(c, fib, f), (bs) => c.filter((_, i) => bs[i])))));
export const filterMapEffect: {
  <A, B, E2, R2>(f: (a: A) => Effect.Effect<O.Option<B>, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
  <A, E, R, B, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<O.Option<B>, E2, R2>): Stream<B, E | E2, R | R2>;
} = I.dual(2, (self: Any, f: (a: any) => Effect.Effect<O.Option<any>, any, any>) =>
  fromOpen(mapPull(self, (c, fib) => chain(forEachChunk(c, fib, f), (os) => os.flatMap((o) => (o._tag === "Some" ? [o.value] : []))))));
export const mapEffect: {
  <A, B, E2, R2>(f: (a: A, i: number) => Effect.Effect<B, E2, R2>, options?: { readonly concurrency?: number | "unbounded"; readonly unordered?: boolean }): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
  <A, E, R, B, E2, R2>(self: Stream<A, E, R>, f: (a: A, i: number) => Effect.Effect<B, E2, R2>, options?: { readonly concurrency?: number | "unbounded"; readonly unordered?: boolean }): Stream<B, E | E2, R | R2>;
} = I.dual((args) => isStream(args[0]), (self: Any, f: (a: any, i: number) => Effect.Effect<any, any, any>, o?: { concurrency?: number | "unbounded" }) =>
  fromOpen((fib, scope) => {
    let i = 0;
    const conc = o?.concurrency ?? 1;
    return mapPull(self, (c, f2) =>
      conc === 1 ? forEachChunk(c, f2, (a) => f(a, i++)) : exec(Effect.forEach(c, (a) => f(a, i++), { concurrency: conc }), f2))(fib, scope);
  }));
export const tap: {
  <A, X, E2, R2>(f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, f: (a: any) => Effect.Effect<any, any, any>) => fromOpen(mapPull(self, (c, fib) => chain(forEachChunk(c, fib, f), () => c))));
export const take: { (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>; <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> } =
  I.dual(2, (self: Any, n: number) =>
    fromOpen((fib, scope) => {
      if (n <= 0) return end;
      let left = n;
      return chain(self.open(fib, scope), (pull: RawPull<any>) => (f: I.Fiber) => {
        if (left <= 0) return end();
        return chain(pull(f), (c) => {
          const out = c.length > left ? c.slice(0, left) : c;
          left -= out.length;
          return out;
        });
      });
    }));
const takeWhileImpl = (self: Any, pred: (a: any, fib: I.Fiber) => Step<boolean>, inclusive: boolean, negate: boolean): Any =>
  fromOpen((fib, scope) => {
    let done = false;
    return chain(self.open(fib, scope), (pull: RawPull<any>) => {
      const next: RawPull<any> = (f) => {
        if (done) return end();
        return chain(pull(f), (c) => {
          const out: Array<any> = [];
          let i = 0;
          const loop = (): Step<ReadonlyArray<any>> => {
            while (i < c.length) {
              const a = c[i++];
              const r = pred(a, f);
              const decide = (b: boolean) => {
                const stop = negate ? b : !b;
                if (stop) {
                  done = true;
                  if (inclusive) out.push(a);
                  return true;
                }
                out.push(a);
                return false;
              };
              if (r instanceof Async) return chain(r, (b) => (decide(b) ? (out.length ? out : end()) : loop()));
              if (decide(r)) return out.length ? out : end();
            }
            return out.length ? out : next(f);
          };
          return loop();
        });
      };
      return next;
    });
  });
export const takeWhile: {
  <A>(f: (a: NoInfer<A>) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, f: (a: A) => boolean): Stream<A, E, R>;
} = I.dual(2, (self: Any, f: (a: any) => boolean) => takeWhileImpl(self, f, false, false));
export const takeUntil: {
  <A>(f: (a: NoInfer<A>) => boolean, options?: { readonly excludeLast?: boolean }): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, f: (a: A) => boolean, options?: { readonly excludeLast?: boolean }): Stream<A, E, R>;
} = I.dual((args) => isStream(args[0]), (self: Any, f: (a: any) => boolean, o?: { excludeLast?: boolean }) => takeWhileImpl(self, f, !o?.excludeLast, true));
export const takeUntilEffect: {
  <A, E2, R2>(f: (a: NoInfer<A>) => Effect.Effect<boolean, E2, R2>, options?: { readonly excludeLast?: boolean }): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<boolean, E2, R2>, options?: { readonly excludeLast?: boolean }): Stream<A, E | E2, R | R2>;
} = I.dual((args) => isStream(args[0]), (self: Any, f: (a: any) => Effect.Effect<boolean, any, any>, o?: { excludeLast?: boolean }) =>
  takeWhileImpl(self, (a, fib) => exec(f(a), fib), !o?.excludeLast, true));
export const drop: { (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>; <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> } =
  I.dual(2, (self: Any, n: number) =>
    fromOpen((fib, scope) => {
      let left = n;
      return mapPull(self, (c) => {
        if (left <= 0) return c;
        const out = c.slice(left);
        left -= c.length - out.length;
        return out;
      })(fib, scope);
    }));
export const dropWhile: {
  <A>(f: (a: NoInfer<A>) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, f: (a: A) => boolean): Stream<A, E, R>;
} = I.dual(2, (self: Any, f: (a: any) => boolean) =>
  fromOpen((fib, scope) => {
    let dropping = true;
    return mapPull(self, (c) => {
      if (!dropping) return c;
      const i = c.findIndex((a) => !f(a));
      if (i < 0) return [];
      dropping = false;
      return c.slice(i);
    })(fib, scope);
  }));
export const concat: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
} = I.dual(2, (self: Any, that: Any) => concatAll([self, that]));
export const concatAll = <S extends Any>(streams: Iterable<S>): Stream<Success<S>, Error<S>, Services<S>> =>
  fromOpen((_, scope) => {
    const arr = [...streams];
    let i = 0;
    let cur: RawPull<any> | undefined;
    const next: RawPull<any> = (f) => {
      if (!cur) {
        if (i >= arr.length) return end();
        return chain(arr[i++]!.open(f, scope), (p: RawPull<any>) => ((cur = p), next(f)));
      }
      return settle(() => cur!(f), (c) => c, (e) => (isEnd(e) ? ((cur = undefined), next(f)) : rethrow(e)));
    };
    return next;
  });
export const prepend: {
  <B>(values: Iterable<B>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | B, E, R>;
  <A, E, R, B>(self: Stream<A, E, R>, values: Iterable<B>): Stream<A | B, E, R>;
} = I.dual(2, (self: Any, values: Iterable<any>) => concat(fromIterable(values), self));
export const append: {
  <B>(values: Iterable<B>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | B, E, R>;
  <A, E, R, B>(self: Stream<A, E, R>, values: Iterable<B>): Stream<A | B, E, R>;
} = I.dual(2, (self: Any, values: Iterable<any>) => concat(self, fromIterable(values)));
export const flattenIterable = <A, E, R>(self: Stream<Iterable<A>, E, R>): Stream<A, E, R> =>
  fromOpen(mapPull(self, (c: ReadonlyArray<Iterable<A>>) => c.flatMap((it) => [...it])));
export const flattenArray = flattenIterable;
/** Each child stream opens in its own scope, closed when exhausted. */
const openChild = (s: Any, outer: ScopeM.ScopeImpl, fib: I.Fiber): Step<[RawPull<any>, ScopeM.ScopeImpl]> => {
  const child = outer.forkScope();
  return chain(s.open(fib, child), (p: RawPull<any>) => [p, child] as [RawPull<any>, ScopeM.ScopeImpl]);
};
export const flatMap: {
  <A, A2, E2, R2>(f: (a: A) => Stream<A2, E2, R2>, options?: { readonly concurrency?: number | "unbounded"; readonly switch?: boolean }): <E, R>(self: Stream<A, E, R>) => Stream<A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Stream<A2, E2, R2>, options?: { readonly concurrency?: number | "unbounded"; readonly switch?: boolean }): Stream<A2, E | E2, R | R2>;
} = I.dual((args) => isStream(args[0]), (self: Any, f: (a: any) => Any, o?: { concurrency?: number | "unbounded"; switch?: boolean }) => {
  if (o?.switch) return switchMap(self, f);
  if (o?.concurrency !== undefined && o.concurrency !== 1) return mergeAll(map(self, f), { concurrency: o.concurrency });
  return fromOpen((fib, scope) =>
    chain(self.open(fib, scope), (outer: RawPull<any>) => {
      let buf: ReadonlyArray<any> = [];
      let bi = 0;
      let cur: [RawPull<any>, ScopeM.ScopeImpl] | undefined;
      const next: RawPull<any> = (f2) => {
        if (cur) {
          const [p, sc] = cur;
          return settle(() => p(f2), (c) => c, (e) => {
            if (!isEnd(e)) return rethrow(e);
            cur = undefined;
            return chain(sc.closeStep(I.exitVoid, f2), () => next(f2));
          });
        }
        if (bi < buf.length) return chain(openChild(f(buf[bi++]), scope, f2), (c) => ((cur = c), next(f2)));
        return chain(outer(f2), (c) => ((buf = c), (bi = 0), next(f2)));
      };
      return next;
    }));
});
/** Run every inner stream concurrently on fibers feeding one queue. */
export const mergeAll: {
  (options: { readonly concurrency: number | "unbounded"; readonly bufferSize?: number }): <A, E, R>(streams: Stream<Stream<A, E, R>, E, R> | Iterable<Stream<A, E, R>>) => Stream<A, E, R>;
  <A, E, R>(streams: Stream<Stream<A, E, R>, any, any> | Iterable<Stream<A, E, R>>, options: { readonly concurrency: number | "unbounded"; readonly bufferSize?: number }): Stream<A, E, R>;
} = I.dual(2, (streams: Any | Iterable<Any>, o: { concurrency: number | "unbounded"; bufferSize?: number }) =>
  fromOpen((fib, scope) => {
    const out = Q.makeUnsafe<ReadonlyArray<any>, any>({ capacity: o.bufferSize ?? 16 });
    const limit = o.concurrency === "unbounded" ? Infinity : o.concurrency;
    const source: Any = isStream(streams) ? streams : fromIterable(streams as Iterable<Any>);
    const driver = Effect.scoped(I.make((f) => {
      const inner = Q.makeUnsafe<void>({ capacity: Infinity });
      let active = 0, sourceDone = false, failed = false;
      const kids = new Set<I.Fiber<any, any>>();
      return chain(source.open(f, f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl), (outer: RawPull<Any>) => {
        const runInner = (s: Any) => {
          active++;
          const k = I.runFiber(Effect.scoped(I.make((f3) => chain(s.open(f3, f3.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl), (p: RawPull<any>) => {
            const loop = (): Step<void> => settle(() => p(f3), (c) => chain(exec(Q.offer(out, c), f3), loop), (e) => (isEnd(e) ? undefined : rethrow(e)));
            return loop();
          }))), f.context, f, { inheritFrom: f });
          kids.add(k);
          k.addObserver((exit) => {
            kids.delete(k);
            active--;
            if (exit._tag === "Failure" && !failed && !exit.cause.reasons.every((r) => r._tag === "Interrupt")) {
              failed = true;
              out.close(exit.cause);
            }
            inner.tryOffer(undefined);
          });
        };
        const pending: Array<Any> = [];
        const loop = (): Step<void> => {
          if (failed) return undefined;
          while (active < limit && pending.length) runInner(pending.shift()!);
          if (active >= limit || (sourceDone && pending.length)) return chain(exec(Q.take(inner), f), loop);
          if (sourceDone) return active === 0 ? void out.close(I.causeFail(Done())) : chain(exec(Q.take(inner), f), loop);
          return settle(() => outer(f), (ss) => (pending.push(...ss), loop()), (e) => (isEnd(e) ? ((sourceDone = true), loop()) : rethrow(e)));
        };
        return loop();
      });
    }));
    const drv = I.runFiber(driver, fib.context, undefined, { inheritFrom: fib });
    drv.addObserver((exit) => exit._tag === "Failure" && !exit.cause.reasons.every((r) => r._tag === "Interrupt") && out.close(exit.cause));
    scope.add(() => I.make((f2) => (drv.interruptAsFork(f2.id), chain(drv.awaitStep(undefined), () => undefined))));
    return (f: I.Fiber) => settle(() => exec(Q.take(out), f), (c) => c as ReadonlyArray<any>, (e) => (isEnd(e) ? end() : rethrow(e)));
  }));
export const merge: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>, options?: { readonly haltStrategy?: "left" | "right" | "both" | "either" }): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, options?: { readonly haltStrategy?: "left" | "right" | "both" | "either" }): Stream<A | A2, E | E2, R | R2>;
} = I.dual((args) => isStream(args[0]) && isStream(args[1]), (self: Any, that: Any, o?: { haltStrategy?: string }) => {
  const h = o?.haltStrategy ?? "both";
  if (h === "both") return mergeAll([self, that], { concurrency: 2 });
  const tag = (s: Any, side: "l" | "r") => concat(map(s, (a) => [side, a] as const), make([side, END] as const));
  return fromOpen((fib, scope) => {
    let done = false;
    return chain(mergeAll([tag(self, "l"), tag(that, "r")], { concurrency: 2 }).open(fib, scope), (pull: RawPull<readonly [string, any]>) => (f: I.Fiber) => {
      if (done) return end();
      return chain(pull(f), (c) => {
        const out: Array<any> = [];
        for (const [side, a] of c) {
          if (a === END) {
            if (h === "either" || (h === "left" && side === "l") || (h === "right" && side === "r")) {
              done = true;
              break;
            }
            continue;
          }
          out.push(a);
        }
        return out.length ? out : done ? end() : [];
      });
    });
  });
});
export const mergeWithTag = <S extends Record<string, Any>>(streams: S, options: { readonly concurrency: number | "unbounded" }) =>
  mergeAll(Object.entries(streams).map(([k, s]) => map(s, (value) => ({ _tag: k, value }))), options) as Stream<{ [K in keyof S]: { _tag: K; value: Success<S[K]> } }[keyof S], Error<S[keyof S]>, Services<S[keyof S]>>;
/** Interrupt the current inner stream whenever the outer emits. */
export const switchMap: {
  <A, A2, E2, R2>(f: (a: A) => Stream<A2, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Stream<A2, E2, R2>): Stream<A2, E | E2, R | R2>;
} = I.dual(2, (self: Any, f: (a: any) => Any) =>
  fromOpen((fib, scope) => {
    const out = Q.makeUnsafe<ReadonlyArray<any>, any>({ capacity: 16 });
    let current: I.Fiber<any, any> | undefined;
    let outerDone = false;
    const startInner = (s: Any, f2: I.Fiber) => {
      const prev = current;
      prev?.interruptAsFork(f2.id);
      const k = I.runFiber(I.make((f3) => chain(prev ? prev.awaitStep(undefined) : undefined, () => exec(Effect.scoped(I.make((f4) => chain(s.open(f4, f4.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl), (p: RawPull<any>) => {
        const loop = (): Step<void> => settle(() => p(f4), (c) => chain(exec(Q.offer(out, c), f4), loop), (e) => (isEnd(e) ? undefined : rethrow(e)));
        return loop();
      }))), f3))), f2.context, undefined, { inheritFrom: f2 });
      current = k;
      k.addObserver((exit) => {
        if (exit._tag === "Failure" && !exit.cause.reasons.every((r) => r._tag === "Interrupt")) out.close(exit.cause);
        else if (current === k && outerDone) out.close(I.causeFail(Done()));
      });
    };
    const driver = I.make((f2: I.Fiber) => chain(self.open(f2, scope), (outer: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => outer(f2), (c) => (startInner(f(c[c.length - 1]), f2), loop()), (e) => {
        if (!isEnd(e)) return rethrow(e);
        outerDone = true;
        if (!current || current.exit) out.close(I.causeFail(Done()));
        return undefined;
      });
      return loop();
    }));
    const drv = I.runFiber(driver, fib.context, undefined, { inheritFrom: fib });
    drv.addObserver((exit) => exit._tag === "Failure" && !exit.cause.reasons.every((r) => r._tag === "Interrupt") && out.close(exit.cause));
    scope.add(() => I.make((f2) => {
      drv.interruptAsFork(f2.id);
      current?.interruptAsFork(f2.id);
      return chain(drv.awaitStep(undefined), () => (current ? chain(current.awaitStep(undefined), () => undefined) : undefined));
    }));
    return (f2: I.Fiber) => settle(() => exec(Q.take(out), f2), (c) => c as ReadonlyArray<any>, (e) => (isEnd(e) ? end() : rethrow(e)));
  }));
export const scan: {
  <S, A>(s: S, f: (s: S, a: A) => S): <E, R>(self: Stream<A, E, R>) => Stream<S, E, R>;
  <A, E, R, S>(self: Stream<A, E, R>, s: S, f: (s: S, a: A) => S): Stream<S, E, R>;
} = I.dual(3, (self: Any, s: unknown, f: (s: any, a: any) => any) =>
  fromOpen((fib, scope) => {
    let acc = s;
    return chain(self.open(fib, scope), (pull: RawPull<any>) => {
      let first = true;
      return (f2: I.Fiber) => (first ? ((first = false), [acc]) : chain(pull(f2), (c) => c.map((a) => (acc = f(acc, a)))));
    });
  }));
export const mapAccum: {
  <S, A, B>(s: LazyArg<S> | S, f: (s: S, a: A) => readonly [S, ReadonlyArray<B> | B]): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
  <A, E, R, S, B>(self: Stream<A, E, R>, s: LazyArg<S> | S, f: (s: S, a: A) => readonly [S, ReadonlyArray<B> | B]): Stream<B, E, R>;
} = I.dual(3, (self: Any, s: unknown, f: (s: any, a: any) => readonly [any, any]) =>
  fromOpen((fib, scope) => {
    let acc = typeof s === "function" ? (s as LazyArg<unknown>)() : s;
    return mapPull(self, (c) => {
      const out: Array<any> = [];
      for (const a of c) {
        const [n, b] = f(acc, a);
        acc = n;
        Array.isArray(b) ? out.push(...b) : out.push(b);
      }
      return out;
    })(fib, scope);
  }));
export const changesWith: {
  <A>(eq: (a: A, b: A) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, eq: (a: A, b: A) => boolean): Stream<A, E, R>;
} = I.dual(2, (self: Any, eq: (a: any, b: any) => boolean) =>
  fromOpen((fib, scope) => {
    let has = false, last: unknown;
    return mapPull(self, (c) => {
      const out: Array<any> = [];
      for (const a of c) if (!has || !eq(last, a)) {
        has = true;
        last = a;
        out.push(a);
      }
      return out;
    })(fib, scope);
  }));
export const changes = <A, E, R>(self: Stream<A, E, R>): Stream<A, E, R> => changesWith(self, I.equals);
export const rechunk: { (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>; <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R> } =
  I.dual(2, (self: Any, n: number) =>
    fromOpen((fib, scope) => chain(self.open(fib, scope), (pull: RawPull<any>) => {
      let buf: Array<any> = [];
      let done = false;
      const next: RawPull<any> = (f) => {
        if (buf.length >= n) return buf.splice(0, n);
        if (done) return buf.length ? buf.splice(0) : end();
        return settle(() => pull(f), (c) => (buf.push(...c), next(f)), (e) => (isEnd(e) ? ((done = true), next(f)) : rethrow(e)));
      };
      return next;
    })));
/** Pull ahead into a buffer on a background fiber. */
export const buffer: {
  (options: { readonly capacity: number | "unbounded"; readonly strategy?: "suspend" | "dropping" | "sliding" }): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, options: { readonly capacity: number | "unbounded"; readonly strategy?: "suspend" | "dropping" | "sliding" }): Stream<A, E, R>;
} = I.dual(2, (self: Any, o: { capacity: number | "unbounded"; strategy?: "suspend" | "dropping" | "sliding" }) =>
  fromOpen((fib, scope) => {
    const q = Q.makeUnsafe<any, any>({ capacity: o.capacity === "unbounded" ? Infinity : o.capacity, strategy: o.strategy ?? "suspend" });
    const drv = I.runFiber(I.make((f2) => chain(self.open(f2, scope), (pull: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => pull(f2), (c) => chain(exec(Q.offerAll(q, c), f2), loop), (e) => void q.close(isEnd(e) ? I.causeFail(Done()) : I.toCause(e)));
      return loop();
    })), fib.context, undefined, { inheritFrom: fib });
    scope.add(() => I.make((f2) => (drv.interruptAsFork(f2.id), chain(drv.awaitStep(undefined), () => undefined))));
    return pullQueue(q, 4096);
  }));
/** Emit the latest value after `duration` of quiet. */
export const debounce: {
  (duration: D.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, duration: D.Input): Stream<A, E, R>;
} = I.dual(2, (self: Any, d: D.Input) => {
  const ms = D.toMillis(d);
  return fromOpen((fib, scope) => {
    const out = Q.makeUnsafe<any, any>({ capacity: Infinity });
    let latest: { v: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (latest) out.tryOffer(latest.v);
      latest = undefined;
    };
    const drv = I.runFiber(I.make((f2) => chain(self.open(f2, scope), (pull: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => pull(f2), (c) => {
        latest = { v: c[c.length - 1] };
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, ms);
        return loop();
      }, (e) => {
        if (timer) clearTimeout(timer);
        flush();
        out.close(isEnd(e) ? I.causeFail(Done()) : I.toCause(e));
      });
      return loop();
    })), fib.context, undefined, { inheritFrom: fib });
    scope.add(() => I.make((f2) => {
      if (timer) clearTimeout(timer);
      drv.interruptAsFork(f2.id);
      return chain(drv.awaitStep(undefined), () => undefined);
    }));
    return pullQueue(out, 1);
  });
});
/** Chunk into groups of `size`, or whatever arrived within `duration`. */
export const groupedWithin: {
  (size: number, duration: D.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<Array<A>, E, R>;
  <A, E, R>(self: Stream<A, E, R>, size: number, duration: D.Input): Stream<Array<A>, E, R>;
} = I.dual(3, (self: Any, size: number, d: D.Input) => {
  const ms = D.toMillis(d);
  return fromOpen((fib, scope) => {
    const out = Q.makeUnsafe<Array<any>, any>({ capacity: Infinity });
    let buf: Array<any> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      while (buf.length) out.tryOffer(buf.splice(0, size));
    };
    const drv = I.runFiber(I.make((f2) => chain(self.open(f2, scope), (pull: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => pull(f2), (c) => {
        buf.push(...c);
        while (buf.length >= size) out.tryOffer(buf.splice(0, size));
        if (buf.length && !timer) timer = setTimeout(emit, ms);
        return loop();
      }, (e) => {
        emit();
        out.close(isEnd(e) ? I.causeFail(Done()) : I.toCause(e));
      });
      return loop();
    })), fib.context, undefined, { inheritFrom: fib });
    scope.add(() => I.make((f2) => {
      if (timer) clearTimeout(timer);
      drv.interruptAsFork(f2.id);
      return chain(drv.awaitStep(undefined), () => undefined);
    }));
    return pullQueue(out, 1);
  });
});
export const grouped: { (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Array<A>, E, R>; <A, E, R>(self: Stream<A, E, R>, n: number): Stream<Array<A>, E, R> } =
  I.dual(2, (self: Any, n: number) => fromOpen(mapPull(rechunk(self, n), (c) => [c as Array<any>])));
export const zipLatestWith: {
  <A2, E2, R2, A, B>(that: Stream<A2, E2, R2>, f: (a: A, a2: A2) => B): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
  <A, E, R, A2, E2, R2, B>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, f: (a: A, a2: A2) => B): Stream<B, E | E2, R | R2>;
} = I.dual(3, (self: Any, that: Any, f: (a: any, b: any) => any) =>
  fromOpen((fib, scope) => {
    let l: { v: any } | undefined, r: { v: any } | undefined;
    return mapPull(mergeAll<readonly [string, any], any, any>([map(self, (v) => ["l", v] as const), map(that, (v) => ["r", v] as const)] as Array<Any>, { concurrency: 2 }), (c: ReadonlyArray<readonly [string, any]>) => {
      const out: Array<any> = [];
      for (const [side, v] of c) {
        side === "l" ? (l = { v }) : (r = { v });
        if (l && r) out.push(f(l.v, r.v));
      }
      return out;
    })(fib, scope);
  }));
export const zipLatest: {
  <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<[A, A2], E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<[A, A2], E | E2, R | R2>;
} = I.dual(2, (self: Any, that: Any) => zipLatestWith(self, that, (a, b) => [a, b]));
export const zipWithIndex = <A, E, R>(self: Stream<A, E, R>): Stream<[A, number], E, R> => map(self, (a, i) => [a, i] as [A, number]);

// ---------- lifecycle / errors ----------
const wrapPull = (self: Any, onPull: (pull: RawPull<any>, f: I.Fiber) => Step<ReadonlyArray<any>>, onOpen?: (f: I.Fiber, scope: ScopeM.ScopeImpl) => Step<void>): Any =>
  fromOpen((fib, scope) => chain(onOpen ? onOpen(fib, scope) : undefined, () => chain(self.open(fib, scope), (pull: RawPull<any>) => (f: I.Fiber) => onPull(pull, f))));
export const ensuring: {
  <X, R2>(finalizer: Effect.Effect<X, never, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
  <A, E, R, X, R2>(self: Stream<A, E, R>, finalizer: Effect.Effect<X, never, R2>): Stream<A, E, R | R2>;
} = I.dual(2, (self: Any, fin: Effect.Effect<any>) => wrapPull(self, (p, f) => p(f), (_, scope) => void scope.add(() => fin)));
export const onExit: {
  <X, R2>(f: (exit: I.Exit<unknown, unknown>) => Effect.Effect<X, never, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
  <A, E, R, X, R2>(self: Stream<A, E, R>, f: (exit: I.Exit<unknown, unknown>) => Effect.Effect<X, never, R2>): Stream<A, E, R | R2>;
} = I.dual(2, (self: Any, fin: (exit: I.Exit<any, any>) => Effect.Effect<any>) => wrapPull(self, (p, f) => p(f), (_, scope) => void scope.add(fin)));
export const onStart: {
  <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, eff: Effect.Effect<any, any, any>) => wrapPull(self, (p, f) => p(f), (f) => chain(exec(eff, f), () => undefined)));
export const onFirst: {
  <A, X, E2, R2>(f: (a: A) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, g: (a: any) => Effect.Effect<any, any, any>) =>
  fromOpen((fib, scope) => {
    let first = true;
    return mapPull(self, (c, f) => (first ? ((first = false), chain(exec(g(c[0]), f), () => c)) : c))(fib, scope);
  }));
export const onEnd: {
  <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, eff: Effect.Effect<any, any, any>) =>
  wrapPull(self, (p, f) => settle(() => p(f), (c) => c, (e) => (isEnd(e) ? chain(exec(eff, f), end) : rethrow(e)))));
const catchPull = (self: Any, handle: (cause: I.Cause<unknown>) => Any | undefined): Any =>
  fromOpen((fib, scope) => {
    let cur: RawPull<any> | undefined;
    let switched = false;
    const fallback = (e: unknown, f: I.Fiber): Step<ReadonlyArray<any>> => {
      if (isEnd(e) || switched) return rethrow(e);
      const alt = handle(I.toCause(e));
      if (!alt) return rethrow(e);
      switched = true;
      return chain(alt.open(f, scope), (p: RawPull<any>) => ((cur = p), p(f)));
    };
    return settle(() => self.open(fib, scope), (p: RawPull<any>) => {
      cur = p;
      return (f: I.Fiber) => settle(() => cur!(f), (c) => c, (e) => fallback(e, f));
    }, (e) => {
      const alt = handle(I.toCause(e));
      if (!alt) return rethrow(e);
      switched = true;
      return alt.open(fib, scope);
    });
  });
const firstErr = (c: I.Cause<unknown>) => c.reasons.find((r) => r._tag === "Fail") as I.Fail<any> | undefined;
const catch_: {
  <E, A2, E2, R2>(f: (e: E) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (e: E) => Stream<A2, E2, R2>): Stream<A | A2, E2, R | R2>;
} = I.dual(2, (self: Any, f: (e: any) => Any) => catchPull(self, (c) => {
  const fl = firstErr(c);
  return fl ? f(fl.error) : undefined;
}));
export { catch_ as catch };
export const catchAll = catch_;
export const catchCause: {
  <E, A2, E2, R2>(f: (c: I.Cause<E>) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (c: I.Cause<E>) => Stream<A2, E2, R2>): Stream<A | A2, E2, R | R2>;
} = I.dual(2, (self: Any, f: (c: I.Cause<any>) => Any) => catchPull(self, f));
export const catchTag: {
  <E, K extends E extends { _tag: string } ? E["_tag"] : never, A2, E2, R2>(k: K, f: (e: Extract<E, { _tag: K }>) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, Exclude<E, { _tag: K }> | E2, R | R2>;
  <A, E, R, K extends E extends { _tag: string } ? E["_tag"] : never, A2, E2, R2>(self: Stream<A, E, R>, k: K, f: (e: Extract<E, { _tag: K }>) => Stream<A2, E2, R2>): Stream<A | A2, Exclude<E, { _tag: K }> | E2, R | R2>;
} = I.dual(3, (self: Any, k: string, f: (e: any) => Any) => catchPull(self, (c) => {
  const fl = firstErr(c);
  return fl && fl.error?._tag === k ? f(fl.error) : undefined;
}));
export const catchIf: {
  <E, A2, E2, R2>(pred: (e: E) => boolean, f: (e: E) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, pred: (e: E) => boolean, f: (e: E) => Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
} = I.dual(3, (self: Any, pred: (e: any) => boolean, f: (e: any) => Any) => catchPull(self, (c) => {
  const fl = firstErr(c);
  return fl && pred(fl.error) ? f(fl.error) : undefined;
}));
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A, R>(self: Stream<A, E, R>) => Stream<A, E2, R>;
  <A, E, R, E2>(self: Stream<A, E, R>, f: (e: E) => E2): Stream<A, E2, R>;
} = I.dual(2, (self: Any, f: (e: any) => any) => catchPull(self, (c) => (firstErr(c) ? failCause(I.makeCause(c.reasons.map((r) => (r._tag === "Fail" ? { ...r, error: f(r.error) } : r)))) : undefined)));
export const orDie = <A, E, R>(self: Stream<A, E, R>): Stream<A, never, R> => catchPull(self, (c) => {
  const fl = firstErr(c);
  return fl ? die(fl.error) : undefined;
}) as Stream<A, never, R>;
export const ignore = <A, E, R>(self: Stream<A, E, R>): Stream<A, never, R> => catchPull(self, (c) => (firstErr(c) ? empty : undefined)) as Stream<A, never, R>;
export const ignoreCause = <A, E, R>(self: Stream<A, E, R>): Stream<A, never, R> => catchPull(self, () => empty) as Stream<A, never, R>;
export const tapCause: {
  <E, X, R2>(f: (c: I.Cause<E>) => Effect.Effect<X, never, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
  <A, E, R, X, R2>(self: Stream<A, E, R>, f: (c: I.Cause<E>) => Effect.Effect<X, never, R2>): Stream<A, E, R | R2>;
} = I.dual(2, (self: Any, g: (c: I.Cause<any>) => Effect.Effect<any>) =>
  wrapPull(self, (p, f) => settle(() => p(f), (c) => c, (e) => (isEnd(e) ? end() : chain(exec(g(I.toCause(e)), f), () => rethrow(e))))));
export const tapError: {
  <E, X, R2>(f: (e: E) => Effect.Effect<X, never, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
  <A, E, R, X, R2>(self: Stream<A, E, R>, f: (e: E) => Effect.Effect<X, never, R2>): Stream<A, E, R | R2>;
} = I.dual(2, (self: Any, g: (e: any) => Effect.Effect<any>) => tapCause(self, (c) => {
  const fl = firstErr(c);
  return fl ? g(fl.error) : Effect.void;
}));
export const retry: {
  <E, X>(schedule: Sched.Schedule<X, E, any, any>): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R, X>(self: Stream<A, E, R>, schedule: Sched.Schedule<X, E, any, any>): Stream<A, E, R>;
} = I.dual(2, (self: Any, schedule: Sched.Schedule<any, any, any, any>) =>
  fromOpen((fib, scope) => {
    const step = schedule.start();
    let cur: RawPull<any>, sc: ScopeM.ScopeImpl;
    const open = (f: I.Fiber): Step<void> => {
      sc = scope.forkScope();
      return chain(self.open(f, sc), (p: RawPull<any>) => void (cur = p));
    };
    const next: RawPull<any> = (f) => settle(() => cur(f), (c) => c, (e) => {
      if (isEnd(e)) return rethrow(e);
      const fl = firstErr(I.toCause(e));
      if (!fl) return rethrow(e);
      return chain(sc.closeStep(I.exitVoid, f), () => chain(Sched.stepAndSleep(step, fl.error, f, sleepMillis), (m) => (m ? chain(open(f), () => next(f)) : rethrow(e))));
    });
    return chain(open(fib), () => next);
  }));
export const interruptWhen: {
  <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
} = I.dual(2, (self: Any, eff: Effect.Effect<any, any, any>) =>
  merge(self, fromEffectDrain(eff), { haltStrategy: "either" }));
export const haltWhen = interruptWhen;
export const timeoutOrElse: {
  <A2, E2, R2>(o: { readonly duration: D.Input; readonly orElse: LazyArg<Stream<A2, E2, R2>> }): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, o: { readonly duration: D.Input; readonly orElse: LazyArg<Stream<A2, E2, R2>> }): Stream<A | A2, E | E2, R | R2>;
} = I.dual(2, (self: Any, o: { duration: D.Input; orElse: LazyArg<Any> }) =>
  fromOpen((fib, scope) => chain(self.open(fib, scope), (pull: RawPull<any>) => {
    let alt: RawPull<any> | undefined;
    return (f: I.Fiber) => {
      if (alt) return alt(f);
      return chain(exec(Effect.timeoutOption(I.make((f2) => pull(f2)), o.duration), f), (oc) =>
        oc._tag === "Some" ? oc.value : chain(o.orElse().open(f, scope), (p: RawPull<any>) => ((alt = p), p(f))));
    };
  })));
export const provideService: {
  <Id, S>(key: I.Key<Id, S>, service: NoInfer<S>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, Id>>;
  <A, E, R, Id, S>(self: Stream<A, E, R>, key: I.Key<Id, S>, service: NoInfer<S>): Stream<A, E, Exclude<R, Id>>;
} = I.dual(3, (self: Any, key: I.Key<any, any>, svc: unknown) => withCtx(self, (ctx) => I.contextAdd(ctx, key.key, svc)));
export const provideContext: {
  <R2>(ctx: I.Context<R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, R2>>;
  <A, E, R, R2>(self: Stream<A, E, R>, ctx: I.Context<R2>): Stream<A, E, Exclude<R, R2>>;
} = I.dual(2, (self: Any, c: I.Context<any>) => withCtx(self, (ctx) => I.contextMerge(ctx, c)));
const withCtx = (self: Any, upd: (c: I.Context<any>) => I.Context<any>): Any =>
  fromOpen((fib, scope) => {
    const swap = <X>(f: I.Fiber, run: () => Step<X>): Step<X> => {
      const prev = f.context;
      f.context = upd(prev);
      return settle(run, (x) => ((f.context = prev), x), (e) => ((f.context = prev), rethrow(e)));
    };
    return chain(swap(fib, () => self.open(fib, scope)), (pull: RawPull<any>) => (f: I.Fiber) => swap(f, () => pull(f)));
  });
export const withSpan: {
  (name: string, options?: import("./Tracer.ts").SpanOptions): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
  <A, E, R>(self: Stream<A, E, R>, name: string, options?: import("./Tracer.ts").SpanOptions): Stream<A, E, R>;
} = I.dual((args) => isStream(args[0]), (self: Any, _name: string) => self);
export const drain = <A, E, R>(self: Stream<A, E, R>): Stream<never, E, R> => fromOpen(mapPull(self, () => []));
/** Split into independent streams that each see every element; consumers are paced by the slowest. */
export const broadcastN: {
  (n: number, options?: { readonly capacity?: number }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Array<Stream<A, E>>, never, R | ScopeM.Scope>;
  <A, E, R>(self: Stream<A, E, R>, n: number, options?: { readonly capacity?: number }): Effect.Effect<Array<Stream<A, E>>, never, R | ScopeM.Scope>;
} = I.dual((args) => isStream(args[0]), (self: Any, n: number, o?: { capacity?: number }) =>
  I.make((fib) => {
    const scope = fib.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl;
    const qs = Array.from({ length: n }, () => Q.makeUnsafe<any, any>({ capacity: o?.capacity ?? 16 }));
    const drv = I.runFiber(I.make((f2) => chain(self.open(f2, scope), (pull: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => pull(f2), (c) => chain(exec(Effect.forEach(qs, (q) => Q.offerAll(q, c), { discard: true }), f2), loop),
        (e) => void qs.forEach((q) => q.close(isEnd(e) ? I.causeFail(Done()) : I.toCause(e))));
      return loop();
    })), fib.context, undefined, { inheritFrom: fib });
    scope.add(() => I.make((f2) => (drv.interruptAsFork(f2.id), chain(drv.awaitStep(undefined), () => undefined))));
    return qs.map((q) => fromOpen(() => pullQueue(q, 4096)));
  }));

// ---------- text ----------
export const decodeText = <E, R>(self: Stream<Uint8Array, E, R>, encoding = "utf-8"): Stream<string, E, R> =>
  fromOpen((fib, scope) => {
    const dec = new TextDecoder(encoding);
    return chain(self.open(fib, scope), (pull: RawPull<Uint8Array>) => {
      let done = false;
      return (f: I.Fiber) => done ? end() : settle(() => pull(f), (c) => {
        const s = c.map((b) => dec.decode(b, { stream: true })).join("");
        return s ? [s] : [];
      }, (e) => {
        if (!isEnd(e)) return rethrow(e);
        done = true;
        const tail = dec.decode();
        return tail ? [tail] : end();
      });
    });
  });
const encoder = new TextEncoder();
export const encodeText = <E, R>(self: Stream<string, E, R>): Stream<Uint8Array, E, R> => fromOpen(mapPull(self, (c: ReadonlyArray<string>) => c.map((s) => encoder.encode(s))));
export const splitLines = <E, R>(self: Stream<string, E, R>): Stream<string, E, R> =>
  fromOpen((fib, scope) => chain(self.open(fib, scope), (pull: RawPull<string>) => {
    let buf = "";
    let done = false;
    const next: RawPull<string> = (f) => done ? end() : settle(() => pull(f), (c) => {
      const text = buf + c.join("");
      const parts = text.split(/\r?\n/);
      buf = parts.pop()!;
      return parts.length ? parts : next(f);
    }, (e) => {
      if (!isEnd(e)) return rethrow(e);
      done = true;
      return buf ? [buf] : end();
    });
    return next;
  }));
export const intersperse: { <B>(b: B): <A, E, R>(self: Stream<A, E, R>) => Stream<A | B, E, R>; <A, E, R, B>(self: Stream<A, E, R>, b: B): Stream<A | B, E, R> } =
  I.dual(2, (self: Any, b: unknown) => fromOpen((fib, scope) => {
    let first = true;
    return mapPull(self, (c) => c.flatMap((a) => (first ? ((first = false), [a]) : [b, a])))(fib, scope);
  }));

// ---------- running ----------
/** Open in a fresh scope, run `consume`, close the scope. */
const runWith = <A, B>(self: Any, consume: (pull: RawPull<A>, f: I.Fiber) => Step<B>): Effect.Effect<B, any, any> =>
  I.make((fib) => {
    const scope = (fib.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined)?.forkScope() ?? new ScopeM.ScopeImpl();
    return exec(ScopeM.useScope(scope, I.make((f) => chain(self.open(f, scope), (pull: RawPull<A>) => consume(pull, f)))), fib);
  });
const fold = <A, S>(pull: RawPull<A>, f: I.Fiber, s: S, step: (s: S, c: ReadonlyArray<A>) => S | typeof STOP): Step<S> => {
  let acc = s;
  const loop = (): Step<S> => {
    for (;;) {
      let r: Step<ReadonlyArray<A>>;
      try {
        r = pull(f);
      } catch (e) {
        if (isEnd(e)) return acc;
        throw e;
      }
      if (r instanceof Async) return settle(() => r, (c) => {
        const n = step(acc, c);
        if (n === STOP) return acc;
        acc = n;
        return loop();
      }, (e) => (isEnd(e) ? acc : rethrow(e)));
      const n = step(acc, r);
      if (n === STOP) return acc;
      acc = n;
    }
  };
  return loop();
};
const STOP: unique symbol = Symbol("stop");
export const runCollect = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<Array<A>, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<A>, f) =>
    chain(fold<A, Array<ReadonlyArray<A>>>(pull, f, [], (cs, c) => (cs.push(c), cs)), (cs) => (cs.length === 1 ? cs[0]!.slice() : cs.flat())));
export const runDrain = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<void, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull, f) => chain(fold(pull, f, undefined, () => undefined), () => undefined));
export const runCount = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<number, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<A>, f) => fold(pull, f, 0, (n, c) => n + c.length));
export const runHead = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<O.Option<A>, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<A>, f) => settle(() => pull(f), (c) => O.some(c[0]!), (e) => (isEnd(e) ? O.none() : rethrow(e))));
export const runLast = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<O.Option<A>, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<A>, f) => fold<A, O.Option<A>>(pull, f, O.none(), (_, c) => O.some(c[c.length - 1]!)));
export const runFold: {
  <S, A>(s: LazyArg<S> | S, f: (s: S, a: A) => S): <E, R>(self: Stream<A, E, R>) => Effect.Effect<S, E, Exclude<R, ScopeM.Scope>>;
  <A, E, R, S>(self: Stream<A, E, R>, s: LazyArg<S> | S, f: (s: S, a: A) => S): Effect.Effect<S, E, Exclude<R, ScopeM.Scope>>;
} = I.dual(3, (self: Any, s: unknown, f: (s: any, a: any) => any) =>
  runWith(self, (pull: RawPull<any>, fib) => fold(pull, fib, typeof s === "function" ? (s as LazyArg<unknown>)() : s, (acc, c) => c.reduce(f, acc))));
const forEachLoop = <A>(pull: RawPull<A>, f: I.Fiber, each: (c: ReadonlyArray<A>) => Step<boolean | void>): Step<void> => {
  const loop = (): Step<void> => {
    for (;;) {
      let r: Step<ReadonlyArray<A>>;
      try {
        r = pull(f);
      } catch (e) {
        if (isEnd(e)) return undefined;
        throw e;
      }
      if (r instanceof Async) return settle(() => r, (c) => chain(each(c), (go) => (go === false ? undefined : loop())), (e) => (isEnd(e) ? undefined : rethrow(e)));
      const x = each(r);
      if (x instanceof Async) return chain(x, (go) => (go === false ? undefined : loop()));
      if (x === false) return undefined;
    }
  };
  return loop();
};
export const runForEach: {
  <A, X, E2, R2>(f: (a: A) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<X, E2, R2>): Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
} = I.dual(2, (self: Any, g: (a: any) => Effect.Effect<any, any, any>) =>
  runWith(self, (pull: RawPull<any>, f) => forEachLoop(pull, f, (c) => chain(forEachChunk(c, f, g), () => true))));
export const runForEachArray: {
  <A, X, E2, R2>(f: (as: ReadonlyArray<A>) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
  <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (as: ReadonlyArray<A>) => Effect.Effect<X, E2, R2>): Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
} = I.dual(2, (self: Any, g: (as: ReadonlyArray<any>) => Effect.Effect<any, any, any>) =>
  runWith(self, (pull: RawPull<any>, f) => forEachLoop(pull, f, (c) => chain(exec(g(c), f), () => true))));
export const runForEachChunk = runForEachArray;
export const runForEachWhile: {
  <A, E2, R2>(f: (a: A) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
  <A, E, R, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<boolean, E2, R2>): Effect.Effect<void, E | E2, Exclude<R | R2, ScopeM.Scope>>;
} = I.dual(2, (self: Any, g: (a: any) => Effect.Effect<boolean, any, any>) =>
  runWith(self, (pull: RawPull<any>, f) => forEachLoop(pull, f, (c) => {
    let i = 0;
    const loop = (): Step<boolean> => {
      while (i < c.length) {
        const r = exec(g(c[i++]), f);
        if (r instanceof Async) return chain(r, (b) => (b ? loop() : false));
        if (!r) return false;
      }
      return true;
    };
    return loop();
  })));
export const runFoldEffect: {
  <S, A, E2, R2>(s: LazyArg<S> | S, f: (s: S, a: A) => Effect.Effect<S, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<S, E | E2, Exclude<R | R2, ScopeM.Scope>>;
  <A, E, R, S, E2, R2>(self: Stream<A, E, R>, s: LazyArg<S> | S, f: (s: S, a: A) => Effect.Effect<S, E2, R2>): Effect.Effect<S, E | E2, Exclude<R | R2, ScopeM.Scope>>;
} = I.dual(3, (self: Any, s: unknown, g: (s: any, a: any) => Effect.Effect<any, any, any>) =>
  runWith(self, (pull: RawPull<any>, f) => {
    let acc = typeof s === "function" ? (s as LazyArg<unknown>)() : s;
    return chain(forEachLoop(pull, f, (c) => {
      let i = 0;
      const loop = (): Step<boolean> => {
        while (i < c.length) {
          const r = exec(g(acc, c[i++]), f);
          if (r instanceof Async) return chain(r, (n) => ((acc = n), loop()));
          acc = r;
        }
        return true;
      };
      return loop();
    }), () => acc);
  }));
export const mkString = <E, R>(self: Stream<string, E, R>): Effect.Effect<string, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<string>, f) => fold(pull, f, "", (acc, c) => acc + c.join("")));
export const mkUint8Array = <E, R>(self: Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, Exclude<R, ScopeM.Scope>> =>
  runWith(self, (pull: RawPull<Uint8Array>, f) => chain(fold(pull, f, [] as Array<Uint8Array>, (acc, c) => (acc.push(...c), acc)), (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return out;
  }));
export const run: {
  <A2, A, E2, R2>(sink: import("./Sink.ts").Sink<A2, A, any, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<A2, E | E2, Exclude<R | R2, ScopeM.Scope>>;
  <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, sink: import("./Sink.ts").Sink<A2, A, any, E2, R2>): Effect.Effect<A2, E | E2, Exclude<R | R2, ScopeM.Scope>>;
} = I.dual(2, (self: Any, sink: import("./Sink.ts").Sink<any, any, any, any, any>) => runWith(self, (pull: RawPull<any>, f) => sink.consume(pull, f)));
/** A Pull effect over this stream, valid for the current Scope; fails with Cause.Done at the end. */
export const toPull = <A, E, R>(self: Stream<A, E, R>): Effect.Effect<Effect.Effect<ReadonlyArray<A>, E | Done, R>, never, R | ScopeM.Scope> =>
  I.make((fib) => {
    const scope = fib.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!scope) return I.serviceNotFound(ScopeM.Scope.key);
    return chain(self.open(fib, scope), (pull: RawPull<A>) => I.make<ReadonlyArray<A>, E | Done, R>((f) => pull(f)));
  });
/** Push every element into `queue`, ending it when the stream ends. */
export const toQueue: {
  (options?: { readonly capacity?: number | "unbounded"; readonly strategy?: "suspend" | "dropping" | "sliding" }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Q.Dequeue<A, E | Done>, never, R | ScopeM.Scope>;
  <A, E, R>(self: Stream<A, E, R>, options?: { readonly capacity?: number | "unbounded"; readonly strategy?: "suspend" | "dropping" | "sliding" }): Effect.Effect<Q.Dequeue<A, E | Done>, never, R | ScopeM.Scope>;
} = I.dual((args) => isStream(args[0]), (self: Any, o?: { capacity?: number | "unbounded"; strategy?: "suspend" | "dropping" | "sliding" }) =>
  I.make((fib) => {
    const scope = fib.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!scope) return I.serviceNotFound(ScopeM.Scope.key);
    const q = Q.makeUnsafe<any, any>({ capacity: o?.capacity === undefined || o.capacity === "unbounded" ? Infinity : o.capacity, strategy: o?.strategy ?? "suspend" });
    const drv = I.runFiber(I.make((f2) => chain(self.open(f2, scope), (pull: RawPull<any>) => {
      const loop = (): Step<void> => settle(() => pull(f2), (c) => chain(exec(Q.offerAll(q, c), f2), loop), (e) => void q.close(isEnd(e) ? I.causeFail(Done()) : I.toCause(e)));
      return loop();
    })), fib.context, undefined, { inheritFrom: fib });
    scope.add(() => I.make((f2) => (drv.interruptAsFork(f2.id), chain(drv.awaitStep(undefined), () => undefined))));
    return q;
  }));
export const toAsyncIterableWith = <R>(ctx: I.Context<R>) => <A, E>(self: Stream<A, E, R>): AsyncIterable<A> => ({
  [Symbol.asyncIterator]() {
    const scope = new ScopeM.ScopeImpl();
    const fiber = new I.Fiber(ctx);
    let pull: RawPull<A> | undefined;
    let buf: ReadonlyArray<A> = [];
    let i = 0;
    const toPromise = <X>(s: Step<X>): Promise<X> => (s instanceof Async ? s.p.then(I.unbox) : Promise.resolve(s));
    const close = () => toPromise(scope.closeStep(I.exitVoid, fiber));
    return {
      async next(): Promise<IteratorResult<A>> {
        if (i < buf.length) return { value: buf[i++]!, done: false };
        try {
          pull ??= await toPromise(self.open(fiber, scope));
          buf = await toPromise(I.settle(() => pull!(fiber), (c) => c, (e) => rethrow(e)));
          i = 0;
          return { value: buf[i++]!, done: false };
        } catch (e) {
          await close();
          if (isEnd(e)) return { value: undefined, done: true };
          throw e instanceof Failure ? I.prettyCause(e.cause) : e;
        }
      },
      async return(): Promise<IteratorResult<A>> {
        await close();
        return { value: undefined, done: true };
      },
    };
  },
});
export const toAsyncIterable = toAsyncIterableWith(I.emptyContext);
/** Transform the pull directly: `f(pull)` returns a new pull. */
export const transformPull = <A, E, R, B, E2, R2>(
  self: Stream<A, E, R>,
  f: (pull: Effect.Effect<ReadonlyArray<A>, E | Done, R>, scope: ScopeM.Scope) => Effect.Effect<Effect.Effect<ReadonlyArray<B>, E2 | Done, R2>, any, any>,
): Stream<B, Exclude<E2, Done>, R | R2> =>
  fromOpen((fib, scope) => chain(self.open(fib, scope), (pull: RawPull<A>) =>
    chain(exec(f(I.make((f2) => pull(f2)), scope), fib), (p2) => (f2: I.Fiber) => settle(() => exec(p2, f2), (c) => (c.length ? c : end()), (e) => (isEnd(e) ? end() : rethrow(e))))));
