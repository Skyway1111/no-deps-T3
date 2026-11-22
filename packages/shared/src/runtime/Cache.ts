import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as D from "./Duration.ts";

type Entry<A, E> = { exit?: I.Exit<A, E> | undefined; inflight?: I.Fiber<A, E> | undefined; expires: number };
/** LRU cache of lookups; concurrent gets for a key share one lookup. */
export class Cache<in out Key, in out A, in out E = never, out R = never> implements I.Pipeable {
  readonly map = new Map<Key, Entry<A, E>>();
  readonly lookup: (key: Key) => I.Effect<A, E, R>;
  readonly capacity: number;
  readonly ttl: (exit: I.Exit<A, E>, key: Key) => number;
  readonly ctx: I.Context<any>;
  constructor(lookup: (key: Key) => I.Effect<A, E, R>, capacity: number, ttl: (exit: I.Exit<A, E>, key: Key) => number, ctx: I.Context<any>) {
    this.lookup = lookup;
    this.capacity = capacity;
    this.ttl = ttl;
    this.ctx = ctx;
  }
  touch(key: Key, e: Entry<A, E>) {
    this.map.delete(key);
    this.map.set(key, e);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as Key);
  }
  live(key: Key): Entry<A, E> | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exit && Date.now() >= e.expires) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }
  getStep(key: Key, f: I.Fiber): I.Step<A> {
    let e = this.live(key);
    if (!e) {
      const fiber = I.runFiber(this.lookup(key), I.contextMerge(this.ctx, f.context));
      const entry: Entry<A, E> = { inflight: fiber, expires: Infinity };
      e = entry;
      this.touch(key, entry);
      fiber.addObserver((exit) => {
        if (this.map.get(key) !== entry) return;
        entry.exit = exit;
        entry.inflight = undefined;
        entry.expires = Date.now() + this.ttl(exit, key);
      });
    } else this.touch(key, e);
    const cur = e;
    return I.chain(cur.exit ?? cur.inflight!.awaitStep(f), (exit) => I.exec(exit, f));
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
type Opts<Key, A, E> = { readonly capacity: number; readonly timeToLive?: D.Input | ((exit: I.Exit<A, E>, key: Key) => D.Input) };
const ttlOf = <Key, A, E>(t: Opts<Key, A, E>["timeToLive"]) =>
  t === undefined ? () => Infinity : typeof t === "function" ? (exit: I.Exit<A, E>, key: Key) => D.toMillis((t as (e: I.Exit<A, E>, k: Key) => D.Input)(exit, key)) : ((ms) => () => ms)(D.toMillis(t));
export const makeWith = <Key, A, E = never, R = never>(lookup: (key: Key) => I.Effect<A, E, R>, options: Opts<Key, A, E> & { readonly requireServicesAt?: "lookup" | "construction" }): I.Effect<Cache<Key, A, E, never>, never, R> =>
  I.make((f) => new Cache(lookup, options.capacity, ttlOf(options.timeToLive), f.context)) as never;
export const make = <Key, A, E = never, R = never>(options: Opts<Key, A, E> & { readonly lookup: (key: Key) => I.Effect<A, E, R>; readonly requireServicesAt?: "lookup" | "construction" }): I.Effect<Cache<Key, A, E, never>, never, R> =>
  makeWith(options.lookup, options);
export const get: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<A, E, R>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<A, E, R> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make((f) => self.getStep(key, f)));
export const getOption: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<O.Option<A>, E>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<O.Option<A>, E> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make((f) => {
    const e = self.live(key);
    if (!e) return O.none();
    return I.chain(e.exit ?? e.inflight!.awaitStep(f), (exit) => I.chain(I.exec(exit, f), O.some));
  }));
export const getSuccess: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<O.Option<A>>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<O.Option<A>> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make(() => {
    const e = self.live(key);
    return e?.exit?._tag === "Success" ? O.some(e.exit.value) : O.none();
  }));
export const set: { <Key, A>(key: Key, value: A): <E, R>(self: Cache<Key, A, E, R>) => I.Effect<void>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key, value: A): I.Effect<void> } =
  I.dual(3, (self: Cache<any, any, any, any>, key: unknown, value: unknown) => I.make(() => {
    const exit = I.exitSucceed(value);
    self.touch(key, { exit, expires: Date.now() + self.ttl(exit, key) });
  }));
export const has: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<boolean>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<boolean> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make(() => self.live(key) !== undefined));
export const invalidate: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<void>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<void> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make(() => void self.map.delete(key)));
export const invalidateWhen: { <Key, A>(key: Key, pred: (a: A) => boolean): <E, R>(self: Cache<Key, A, E, R>) => I.Effect<boolean>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key, pred: (a: A) => boolean): I.Effect<boolean> } =
  I.dual(3, (self: Cache<any, any, any, any>, key: unknown, pred: (a: unknown) => boolean) => I.make(() => {
    const e = self.map.get(key);
    if (e?.exit?._tag === "Success" && pred(e.exit.value)) return self.map.delete(key);
    return false;
  }));
export const invalidateAll = <Key, A, E, R>(self: Cache<Key, A, E, R>): I.Effect<void> => I.make(() => self.map.clear());
export const refresh: { <Key>(key: Key): <A, E, R>(self: Cache<Key, A, E, R>) => I.Effect<A, E, R>; <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): I.Effect<A, E, R> } =
  I.dual(2, (self: Cache<any, any, any, any>, key: unknown) => I.make((f) => {
    self.map.delete(key);
    return self.getStep(key, f);
  }));
export const size = <Key, A, E, R>(self: Cache<Key, A, E, R>): I.Effect<number> => I.make(() => self.map.size);
export const keys = <Key, A, E, R>(self: Cache<Key, A, E, R>): I.Effect<Array<Key>> => I.make(() => [...self.map.keys()].filter((k) => self.live(k)));
export const values = <Key, A, E, R>(self: Cache<Key, A, E, R>): I.Effect<Array<A>> =>
  I.make(() => [...self.map.values()].flatMap((e) => (e.exit?._tag === "Success" ? [e.exit.value] : [])));
export const entries = <Key, A, E, R>(self: Cache<Key, A, E, R>): I.Effect<Array<[Key, A]>> =>
  I.make(() => [...self.map.entries()].flatMap(([k, e]) => (e.exit?._tag === "Success" ? [[k, e.exit.value] as [Key, A]] : [])));
