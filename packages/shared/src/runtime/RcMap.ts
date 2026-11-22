import * as I from "./internal.ts";
import * as D from "./Duration.ts";
import * as ScopeM from "./Scope.ts";

type Entry<A, E> = { fiber: I.Fiber<A, E>; scope: ScopeM.ScopeImpl; refs: number; timer?: ReturnType<typeof setTimeout> };
/** Reference-counted resources by key; released after the last user's Scope closes (plus idleTimeToLive). */
export class RcMap<in out K, in out A, in out E = never> implements I.Pipeable {
  readonly map = new Map<K, Entry<A, E>>();
  readonly lookup: (key: K) => I.Effect<A, E, any>;
  readonly idle: number;
  readonly ctx: I.Context<any>;
  readonly capacity: number;
  constructor(lookup: (key: K) => I.Effect<A, E, any>, idle: number, capacity: number, ctx: I.Context<any>) {
    this.lookup = lookup;
    this.idle = idle;
    this.capacity = capacity;
    this.ctx = ctx;
  }
  release(key: K, e: Entry<A, E>) {
    if (--e.refs > 0) return;
    const close = () => {
      if (e.refs > 0 || this.map.get(key) !== e) return;
      this.map.delete(key);
      I.runFiber(I.make((f) => e.scope.closeStep(I.exitVoid, f)), I.emptyContext);
    };
    if (this.idle <= 0) close();
    else e.timer = setTimeout(close, this.idle);
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const make = <K, A, E = never, R = never>(options: { readonly lookup: (key: K) => I.Effect<A, E, R>; readonly idleTimeToLive?: D.Input | undefined; readonly capacity?: number | undefined }): I.Effect<RcMap<K, A, E>, never, ScopeM.Scope | Exclude<R, ScopeM.Scope>> =>
  I.make((f) => {
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    const m = new RcMap<K, A, E>(options.lookup, options.idleTimeToLive === undefined ? 0 : D.toMillis(options.idleTimeToLive), options.capacity ?? Infinity, f.context);
    sc.add(() => I.make((f2) => {
      const es = [...m.map.values()];
      m.map.clear();
      let i = 0;
      const loop = (): I.Step<void> => (i < es.length ? (clearTimeout(es[i]!.timer), I.chain(es[i++]!.scope.closeStep(I.exitVoid, f2), loop)) : undefined);
      return loop();
    }));
    return m;
  });
export const get: { <K>(key: K): <A, E>(self: RcMap<K, A, E>) => I.Effect<A, E, ScopeM.Scope>; <K, A, E>(self: RcMap<K, A, E>, key: K): I.Effect<A, E, ScopeM.Scope> } =
  I.dual(2, (self: RcMap<any, any, any>, key: unknown) => I.make((f) => {
    const userScope = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!userScope) return I.serviceNotFound(ScopeM.Scope.key);
    let e = self.map.get(key);
    if (!e) {
      const scope = new ScopeM.ScopeImpl();
      const fiber = I.runFiber(ScopeM.provide(self.lookup(key), scope), self.ctx);
      e = { fiber, scope, refs: 0 };
      self.map.set(key, e);
      const entry = e;
      fiber.addObserver((exit) => exit._tag === "Failure" && self.map.get(key) === entry && self.map.delete(key));
    }
    if (e.timer) clearTimeout(e.timer);
    e.refs++;
    const entry = e;
    userScope.add(() => I.make(() => self.release(key, entry)));
    return I.chain(entry.fiber.awaitStep(f), (exit) => I.exec(exit, f));
  }));
export const has: { <K>(key: K): <A, E>(self: RcMap<K, A, E>) => I.Effect<boolean>; <K, A, E>(self: RcMap<K, A, E>, key: K): I.Effect<boolean> } =
  I.dual(2, (self: RcMap<any, any, any>, key: unknown) => I.make(() => self.map.has(key)));
export const keys = <K, A, E>(self: RcMap<K, A, E>): I.Effect<Array<K>> => I.make(() => [...self.map.keys()]);
export const invalidate: { <K>(key: K): <A, E>(self: RcMap<K, A, E>) => I.Effect<void>; <K, A, E>(self: RcMap<K, A, E>, key: K): I.Effect<void> } =
  I.dual(2, (self: RcMap<any, any, any>, key: unknown) => I.make((f) => {
    const e = self.map.get(key);
    if (!e) return undefined;
    self.map.delete(key);
    clearTimeout(e.timer);
    return e.scope.closeStep(I.exitVoid, f);
  }));
export const touch = invalidate;
