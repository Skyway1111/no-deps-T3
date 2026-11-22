import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as Q from "../Queue.ts";
import * as ScopeM from "../Scope.ts";

export type KeysInput = ReadonlyArray<unknown> | Readonly<Record<string, ReadonlyArray<unknown>>>;
const flattenKeys = (keys: KeysInput): Array<string> =>
  Array.isArray(keys) ? keys.map((k) => I.safeJson(k)) : Object.entries(keys as Readonly<Record<string, ReadonlyArray<unknown>>>).flatMap(([k, ids]) => [k, ...ids.map((id: unknown) => `${k}:${I.safeJson(id)}`)]);
/** Invalidation bus: queries re-run when any of their keys is invalidated. */
export interface ReactivityService {
  readonly invalidateUnsafe: (keys: KeysInput) => void;
  readonly registerUnsafe: (keys: KeysInput, handler: () => void) => () => void;
  readonly invalidate: (keys: KeysInput) => I.Effect<void>;
  readonly mutation: <A, E, R>(keys: KeysInput, effect: I.Effect<A, E, R>) => I.Effect<A, E, R>;
  readonly query: <A, E, R>(keys: KeysInput, effect: I.Effect<A, E, R>) => I.Effect<Q.Dequeue<A, E>, never, R | ScopeM.Scope>;
  readonly stream: <A, E, R>(keys: KeysInput, effect: I.Effect<A, E, R>) => Stream.Stream<A, E, Exclude<R, ScopeM.Scope>>;
}
export const make = (): ReactivityService => {
  const handlers = new Map<string, Set<() => void>>();
  const invalidateUnsafe = (keys: KeysInput) => {
    const seen = new Set<() => void>();
    for (const k of flattenKeys(keys)) for (const h of handlers.get(k) ?? []) seen.add(h);
    for (const h of seen) h();
  };
  const registerUnsafe = (keys: KeysInput, handler: () => void) => {
    const ks = flattenKeys(keys);
    for (const k of ks) (handlers.get(k) ?? handlers.set(k, new Set()).get(k)!).add(handler);
    return () => ks.forEach((k) => handlers.get(k)?.delete(handler));
  };
  const query = <A, E, R>(keys: KeysInput, effect: I.Effect<A, E, R>) =>
    I.make<Q.Dequeue<A, E>, never, R | ScopeM.Scope>((f) => {
      const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl;
      const q = Q.makeUnsafe<A, E>({ capacity: 1, strategy: "sliding" });
      let running: I.Fiber | undefined;
      const run = () => {
        running?.interruptAsFork(undefined);
        running = I.runFiber(effect, f.context);
        running.addObserver((exit) => (exit._tag === "Success" ? q.tryOffer(exit.value as A) : !exit.cause.reasons.every((r) => r._tag === "Interrupt") && q.close(exit.cause as I.Cause<E>)));
      };
      const un = registerUnsafe(keys, run);
      sc.add(() => I.make(() => (un(), running?.interruptAsFork(undefined))));
      run();
      return q;
    });
  return {
    invalidateUnsafe,
    registerUnsafe,
    invalidate: (keys) => I.make(() => invalidateUnsafe(keys)),
    mutation: (keys, effect) => I.make((f) => I.chain(I.exec(effect, f), (a) => (invalidateUnsafe(keys), a))),
    query,
    stream: (keys, effect) => Stream.unwrap(I.make((f) => I.chain(I.exec(query(keys, effect), f), (q) => Stream.fromQueue(q)))) as never,
  };
};
export const Reactivity = Ctx.Service<Reactivity, ReactivityService>("effect/reactivity/Reactivity");
export type Reactivity = ReactivityService;
export const layer: Layer.Layer<Reactivity> = Layer.sync(Reactivity, make);
export const invalidate = (keys: KeysInput): I.Effect<void, never, Reactivity> => I.make((f) => I.chain(I.exec(Reactivity, f), (r) => r.invalidateUnsafe(keys)));
export const mutation: {
  (keys: KeysInput): <A, E, R>(effect: I.Effect<A, E, R>) => I.Effect<A, E, R | Reactivity>;
  <A, E, R>(effect: I.Effect<A, E, R>, keys: KeysInput): I.Effect<A, E, R | Reactivity>;
} = I.dual(2, (effect: I.Effect<any, any, any>, keys: KeysInput) => I.make((f) => I.chain(I.exec(Reactivity, f), (r) => I.exec(r.mutation(keys, effect), f))));
export const query: {
  (keys: KeysInput): <A, E, R>(effect: I.Effect<A, E, R>) => I.Effect<Q.Dequeue<A, E>, never, R | Reactivity | ScopeM.Scope>;
  <A, E, R>(effect: I.Effect<A, E, R>, keys: KeysInput): I.Effect<Q.Dequeue<A, E>, never, R | Reactivity | ScopeM.Scope>;
} = I.dual(2, (effect: I.Effect<any, any, any>, keys: KeysInput) => I.make((f) => I.chain(I.exec(Reactivity, f), (r) => I.exec(r.query(keys, effect), f))));
