import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as ScopeM from "./Scope.ts";
import * as FM from "./FiberMap.ts";

/** A single-slot FiberMap. */
export interface FiberHandle<A = unknown, E = unknown> extends FM.FiberMap<"handle", A, E> {}
export const make = <A = unknown, E = unknown>(): I.Effect<FiberHandle<A, E>, never, ScopeM.Scope> => FM.make<"handle", A, E>();
export const run: {
  <A, E>(self: FiberHandle<A, E>, options?: { readonly onlyIfMissing?: boolean }): <R, XE extends E, XA extends A>(effect: I.Effect<XA, XE, R>) => I.Effect<I.Fiber<XA, XE>, never, R>;
  <A, E, R, XE extends E, XA extends A>(self: FiberHandle<A, E>, effect: I.Effect<XA, XE, R>, options?: { readonly onlyIfMissing?: boolean }): I.Effect<I.Fiber<XA, XE>, never, R>;
} = function (self: FiberHandle<any, any>, a?: any, b?: any): any {
  return I.isEffect(a) ? FM.run(self, "handle", a, b) : FM.run(self, "handle", a);
} as never;
export const get = <A, E>(self: FiberHandle<A, E>): I.Effect<O.Option<I.Fiber<A, E>>> => FM.get(self, "handle");
export const clear = <A, E>(self: FiberHandle<A, E>): I.Effect<void> => FM.clear(self);
export const set = <A, E>(self: FiberHandle<A, E>, fiber: I.Fiber<A, E>): I.Effect<void> => FM.set(self, "handle", fiber);
