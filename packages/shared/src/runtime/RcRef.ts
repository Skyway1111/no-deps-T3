import * as I from "./internal.ts";
import * as D from "./Duration.ts";
import * as ScopeM from "./Scope.ts";
import * as RcMap from "./RcMap.ts";

export interface RcRef<in out A, in out E = never> extends RcMap.RcMap<"ref", A, E> {}
export const make = <A, E = never, R = never>(options: { readonly acquire: I.Effect<A, E, R>; readonly idleTimeToLive?: D.Input }): I.Effect<RcRef<A, E>, never, ScopeM.Scope | Exclude<R, ScopeM.Scope>> =>
  RcMap.make({ lookup: () => options.acquire, idleTimeToLive: options.idleTimeToLive }) as never;
export const get = <A, E>(self: RcRef<A, E>): I.Effect<A, E, ScopeM.Scope> => RcMap.get(self, "ref");
export const invalidate = <A, E>(self: RcRef<A, E>): I.Effect<void> => RcMap.invalidate(self, "ref");
