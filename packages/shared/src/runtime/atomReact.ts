/** `@effect/atom-react`: React bindings over the atom registry via useSyncExternalStore. */
import * as React from "react";
import * as I from "./internal.ts";
import * as AR from "./reactivity/AsyncResult.ts";
import * as Atom from "./reactivity/Atom.ts";
import * as AtomRegistry from "./reactivity/AtomRegistry.ts";

export const RegistryContext = React.createContext<AtomRegistry.AtomRegistry>(AtomRegistry.make({ defaultIdleTTL: 400 }));
export const RegistryProvider = (options: {
  readonly children?: React.ReactNode;
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]>;
  readonly scheduleTask?: (f: () => void) => () => void;
  readonly timeoutResolution?: number;
  readonly defaultIdleTTL?: number;
}) => {
  const ref = React.useRef<AtomRegistry.AtomRegistry | null>(null);
  ref.current ??= AtomRegistry.make({ initialValues: options.initialValues, scheduleTask: options.scheduleTask, defaultIdleTTL: options.defaultIdleTTL ?? 400 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes the registry this provider owns on unmount
  React.useEffect(() => () => ref.current?.dispose(), []);
  return React.createElement(RegistryContext.Provider, { value: ref.current }, options.children);
};
type Store<A> = { readonly subscribe: (f: () => void) => () => void; readonly snapshot: () => A };
const stores = new WeakMap<AtomRegistry.AtomRegistry, WeakMap<Atom.Atom<any>, Store<any>>>();
/** One stable store per (registry, atom) so useSyncExternalStore never resubscribes needlessly. */
function storeFor<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>): Store<A> {
  let byAtom = stores.get(registry);
  if (!byAtom) stores.set(registry, (byAtom = new WeakMap()));
  let s = byAtom.get(atom);
  if (!s) byAtom.set(atom, (s = { subscribe: (f) => registry.subscribe(atom, f), snapshot: () => registry.get(atom) }));
  return s;
}
export function useAtomValue<A>(atom: Atom.Atom<A>): A;
export function useAtomValue<A, B>(atom: Atom.Atom<A>, f: (a: A) => B): B;
export function useAtomValue<A>(atom: Atom.Atom<A>, f?: (a: A) => unknown): unknown {
  const registry = React.useContext(RegistryContext);
  const target = React.useMemo(() => (f ? Atom.map(atom, f) : atom), [atom, f]);
  const store = storeFor(registry, target);
  return React.useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
export const useAtomMount = <A>(atom: Atom.Atom<A>): void => {
  const registry = React.useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the atom node alive while mounted
  React.useEffect(() => registry.mount(atom), [registry, atom]);
};
type SetMode = "value" | "promise" | "promiseExit";
export function useAtomSet<R, W, Mode extends SetMode = never>(atom: Atom.Writable<R, W>, options?: { readonly mode?: Mode }):
  "promise" extends Mode ? (value: W) => Promise<AR.AsyncResult.Success<R>>
  : "promiseExit" extends Mode ? (value: W) => Promise<I.Exit<AR.AsyncResult.Success<R>, AR.AsyncResult.Failure<R>>>
  : (value: W | ((value: R) => W)) => void;
export function useAtomSet(atom: Atom.Writable<any, any>, options?: { readonly mode?: SetMode }): (value: any) => any {
  const registry = React.useContext(RegistryContext);
  useAtomMount(atom);
  return React.useCallback((value: unknown) => {
    if (options?.mode === "promise" || options?.mode === "promiseExit") {
      registry.set(atom, value);
      const eff = AtomRegistry.getResult(registry, atom as Atom.Atom<AR.AsyncResult<any, any>>, { suspendOnWaiting: true });
      const fiber = I.runFiber(eff, I.emptyContext);
      const toP = (exit: I.Exit<any, any>) =>
        options.mode === "promiseExit" ? exit : exit._tag === "Success" ? exit.value : Promise.reject(exit.cause.reasons.find((r) => r._tag === "Fail")?.["error" as never] ?? exit.cause);
      return fiber.exit ? Promise.resolve(toP(fiber.exit)) : new Promise((res) => fiber.addObserver((e) => res(toP(e))));
    }
    registry.set(atom, typeof value === "function" ? (value as (r: unknown) => unknown)(registry.get(atom)) : value);
  }, [registry, atom, options?.mode]);
}
export function useAtom<R, W, Mode extends SetMode = never>(atom: Atom.Writable<R, W>, options?: { readonly mode?: Mode }): readonly [value: R, setOrUpdate: ReturnType<typeof useAtomSet<R, W, Mode>>] {
  return [useAtomValue(atom), useAtomSet(atom, options)] as const;
}
export const useAtomRefresh = <A>(atom: Atom.Atom<A>): (() => void) => {
  const registry = React.useContext(RegistryContext);
  useAtomMount(atom);
  return React.useCallback(() => registry.refresh(atom), [registry, atom]);
};
export const useAtomSubscribe = <A>(atom: Atom.Atom<A>, f: (a: A) => void, options?: { readonly immediate?: boolean }): void => {
  const registry = React.useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- external subscription
  React.useEffect(() => registry.subscribe(atom, f, options), [registry, atom, f, options?.immediate]);
};
export const useAtomSuspense = <A, E>(atom: Atom.Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean; readonly includeFailure?: boolean }): AR.Success<A, E> | AR.Failure<A, E> => {
  const registry = React.useContext(RegistryContext);
  const r = useAtomValue(atom);
  if (r._tag === "Initial" || (options?.suspendOnWaiting && r.waiting)) {
    throw new Promise<void>((res) => {
      const un = registry.subscribe(atom, (v) => {
        if (v._tag !== "Initial" && !(options?.suspendOnWaiting && v.waiting)) {
          un();
          res();
        }
      });
    });
  }
  if (r._tag === "Failure" && !options?.includeFailure) throw I.prettyCause(r.cause);
  return r as AR.Success<A, E> | AR.Failure<A, E>;
};
export const useAtomInitialValues = (initialValues: Iterable<readonly [Atom.Atom<any>, any]>): void => {
  const registry = React.useContext(RegistryContext);
  const set = React.useRef(new WeakSet<Atom.Atom<any>>()).current;
  for (const [atom, value] of initialValues) {
    if (set.has(atom)) continue;
    set.add(atom);
    const n = registry.ensureNode(atom);
    n.value = value;
    n.state = 1;
  }
};
