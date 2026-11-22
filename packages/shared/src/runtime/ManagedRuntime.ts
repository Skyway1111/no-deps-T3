import * as I from "./internal.ts";
import * as Layer from "./Layer.ts";
import * as ScopeM from "./Scope.ts";
import * as Effect from "./Effect.ts";

/** A runtime that builds `layer` once (lazily) and runs effects with its services. */
export interface ManagedRuntime<in R, out ER> {
  readonly memoMap: Layer.MemoMap;
  readonly context: I.Effect<I.Context<R>, ER>;
  readonly contextEffect: I.Effect<I.Context<R>, ER>;
  runFork<A, E>(effect: I.Effect<A, E, R>, options?: Effect.RunOptions): I.Fiber<A, E | ER>;
  runPromise<A, E>(effect: I.Effect<A, E, R>, options?: Effect.RunOptions): Promise<A>;
  runPromiseExit<A, E>(effect: I.Effect<A, E, R>, options?: Effect.RunOptions): Promise<I.Exit<A, E | ER>>;
  runSync<A, E>(effect: I.Effect<A, E, R>): A;
  runSyncExit<A, E>(effect: I.Effect<A, E, R>): I.Exit<A, E | ER>;
  runCallback<A, E>(effect: I.Effect<A, E, R>, options?: Effect.RunOptions & { readonly onExit?: (exit: I.Exit<A, E | ER>) => void }): () => void;
  readonly dispose: () => Promise<void>;
  readonly disposeEffect: I.Effect<void>;
}
export declare namespace ManagedRuntime {
  type Context<T> = T extends ManagedRuntime<infer R, any> ? R : never;
  type Error<T> = T extends ManagedRuntime<any, infer E> ? E : never;
}
export const make = <R, ER>(layer: Layer.Layer<R, ER, never>, options?: { readonly memoMap?: Layer.MemoMap }): ManagedRuntime<R, ER> => {
  const memoMap = options?.memoMap ?? Layer.makeMemoMap();
  const scope = new ScopeM.ScopeImpl();
  let ctxFiber: I.Fiber<I.Context<R>, ER> | undefined;
  const contextEffect = I.make<I.Context<R>, ER>((f) => {
    ctxFiber ??= I.runFiber(I.make((f2) => Layer.buildLayer(layer, memoMap, scope, f2)), I.emptyContext) as I.Fiber<I.Context<R>, ER>;
    return I.chain(ctxFiber.awaitStep(f), (exit) => I.exec(exit, f));
  });
  const withCtx = <A, E>(eff: I.Effect<A, E, R>) => Effect.flatMap(contextEffect, (ctx) => Effect.provideContext(eff, ctx));
  return {
    memoMap,
    context: contextEffect,
    contextEffect,
    runFork: (eff, o) => Effect.runFork(withCtx(eff), o),
    runPromise: (eff, o) => Effect.runPromise(withCtx(eff), o),
    runPromiseExit: (eff, o) => Effect.runPromiseExit(withCtx(eff), o),
    runSync: (eff) => Effect.runSync(withCtx(eff)),
    runSyncExit: (eff) => Effect.runSyncExit(withCtx(eff)),
    runCallback: (eff, o) => Effect.runCallback(withCtx(eff), o),
    disposeEffect: I.make((f) => scope.closeStep(I.exitVoid, f)),
    dispose: () => Effect.runPromise(I.make((f) => scope.closeStep(I.exitVoid, f))),
  };
};
export const isManagedRuntime = (u: unknown): u is ManagedRuntime<unknown, unknown> => typeof u === "object" && u !== null && "memoMap" in u && "runPromise" in u;
