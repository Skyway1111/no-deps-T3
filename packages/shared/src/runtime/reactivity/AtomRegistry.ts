import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as Ctx from "../Context.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as Q from "../Queue.ts";
import * as ScopeM from "../Scope.ts";
import { Done } from "../errors.ts";
import * as AR from "./AsyncResult.ts";
import type { Atom, AtomContext, Writable, WriteContext } from "./Atom.ts";

export const TypeId: unique symbol = Symbol.for("effect/reactivity/AtomRegistry") as never;

/** One node per mounted/read atom. `stale` nodes recompute on the next read. */
export class Node<A> {
  readonly atom: Atom<A>;
  readonly registry: Registry;
  state: 0 | 1 | 2 = 0;
  value!: A;
  parents: Array<Node<any>> = [];
  readonly children = new Set<Node<any>>();
  readonly listeners = new Set<() => void>();
  lifetime: Lifetime<A> | undefined = undefined;
  queuedRecompute = false;
  queuedNotify = false;
  removalTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  removalQueued = false;
  constructor(registry: Registry, atom: Atom<A>) {
    this.registry = registry;
    this.atom = atom;
  }
  get canBeRemoved(): boolean {
    return !this.atom.keepAlive && this.listeners.size === 0 && this.children.size === 0;
  }
  get(): A {
    if (this.state !== 1) this.compute();
    return this.value;
  }
  /** Recompute; `parents[0, lt.reads)` are this run's reads, the rest are unlinked after. */
  compute(): void {
    let lt = this.lifetime;
    if (lt && this.atom.privateContext) lt.reads = 0;
    else {
      lt?.dispose();
      lt = this.lifetime = makeLifetime(this);
    }
    try {
      const v = this.atom.read(lt);
      if (lt.disposed) return;
      this.state = 1;
      if (!lt.selfSet || this.value === undefined) this.value = v;
    } finally {
      const ps = this.parents;
      if (this.lifetime === lt && lt.reads < ps.length) {
        const dropped = ps.splice(lt.reads);
        for (const p of dropped) {
          p.children.delete(this);
          if (p.canBeRemoved) this.registry.scheduleNodeRemoval(p);
        }
      }
    }
  }
  private wctx: (WriteContext<A> & { readonly "~node": Node<A> }) | undefined = undefined;
  get writeContext(): WriteContext<A> & { readonly "~node": Node<A> } {
    return (this.wctx ??= writeContext(this.registry, this));
  }
  /** Set from setSelf/async completion: update, invalidate dependents, notify. */
  setValue(v: A): void {
    if (this.state === 1 && this.atom.equals(this.value, v)) return;
    this.value = v;
    this.state = 1;
    const reg = this.registry;
    reg.depth++;
    try {
      this.invalidateChildren();
      if (this.listeners.size) reg.queueNotify(this);
    } finally {
      if (--reg.depth === 0) reg.flush();
    }
  }
  invalidate(): void {
    if (this.state !== 1) return;
    this.state = 2;
    this.invalidateChildren();
    if (this.listeners.size) this.registry.queueRecompute(this);
  }
  invalidateChildren(): void {
    for (const c of this.children) c.invalidate();
  }
  notify(): void {
    for (const l of this.listeners) l();
  }
  remove(): void {
    this.lifetime?.dispose();
    this.lifetime = undefined;
    for (const p of this.parents) {
      p.children.delete(this);
      if (p.canBeRemoved) this.registry.scheduleNodeRemoval(p);
    }
    this.parents = [];
    this.state = 0;
  }
}

/** Per-compute context, callable as `get(atom)`: dependency tracking, finalizers, self updates. */
interface Lifetime<A> extends AtomContext {
  node: Node<A>;
  disposed: boolean;
  selfSet: boolean;
  finalizers: Array<() => void> | undefined;
  reads: number;
  track<B>(atom: Atom<B>): B;
  addFinalizer(f: () => void): void;
  setSelf(a: unknown): void;
  dispose(): void;
}
function makeLifetime<A>(node: Node<A>): Lifetime<A> {
  const lt = function get<B>(atom: Atom<B>): B {
    return lt.track(atom);
  } as Lifetime<A>;
  Object.setPrototypeOf(lt, LifetimeProto);
  lt.node = node;
  lt.disposed = false;
  lt.selfSet = false;
  lt.finalizers = undefined;
  lt.reads = 0;
  return lt;
}
type Lt = Lifetime<any>;
const LifetimeProto: ThisType<Lt> & Record<string, unknown> = Object.setPrototypeOf({
  track<B>(this: Lt, atom: Atom<B>): B {
    const node = this.node;
    const p = node.registry.ensureNode(atom);
    if (!this.disposed) {
      // Cursor match: a run that reads the same parents in order does no linking work.
      const ps = node.parents;
      const i = this.reads;
      let j = ps[i] === p ? i : ps.indexOf(p);
      if (j < 0) {
        j = ps.push(p) - 1;
        p.children.add(node);
      }
      if (j >= i) {
        ps[j] = ps[i]!;
        ps[i] = p;
        this.reads = i + 1;
      }
    }
    return p.state === 1 ? p.value : p.get();
  },
  get<B>(this: Lt, atom: Atom<B>): B {
    return this.track(atom);
  },
  addFinalizer(this: Lt, f: () => void) {
    if (this.disposed) return f();
    (this.finalizers ??= []).push(f);
  },
  setSelf(this: Lt, a: unknown) {
    if (this.disposed) return;
    this.selfSet = true;
    const node = this.node;
    if (node.lifetime === this && node.state !== 0) node.setValue(a);
    else node.value = a;
  },
  dispose(this: Lt) {
    if (this.disposed) return;
    this.disposed = true;
    const fs = this.finalizers;
    this.finalizers = undefined;
    if (fs) for (let i = fs.length - 1; i >= 0; i--) fs[i]!();
  },
  once<B>(this: Lt, atom: Atom<B>): B {
    return this.node.registry.get(atom);
  },
  get registry() {
    return (this as unknown as Lt).node.registry;
  },
  mount<B>(this: Lt, atom: Atom<B>) {
    this.addFinalizer(this.node.registry.mount(atom));
  },
  refresh<B>(this: Lt, atom: Atom<B>) {
    this.node.registry.refresh(atom);
  },
  refreshSelf(this: Lt) {
    if (!this.disposed) this.node.registry.refreshNode(this.node);
  },
  self(this: Lt) {
    return this.node.state === 0 && !this.selfSet ? O.none() : O.some(this.node.value);
  },
  set<R, W>(this: Lt, atom: Writable<R, W>, value: W) {
    this.node.registry.set(atom, value);
  },
  setResult<B, E, W>(this: Lt, atom: Writable<AR.AsyncResult<B, E>, W>, value: W) {
    const reg = this.node.registry;
    reg.set(atom, value);
    return getResult(reg, atom, { suspendOnWaiting: true });
  },
  result<B, E>(this: Lt, atom: Atom<AR.AsyncResult<B, E>>, o?: { suspendOnWaiting?: boolean }) {
    return resultEffect(() => this.track(atom), this.node.registry, atom, o);
  },
  resultOnce<B, E>(this: Lt, atom: Atom<AR.AsyncResult<B, E>>, o?: { suspendOnWaiting?: boolean }) {
    return getResult(this.node.registry, atom, o);
  },
  some<B>(this: Lt, atom: Atom<O.Option<B>>) {
    return someEffect(() => this.track(atom), this.node.registry, atom);
  },
  someOnce<B>(this: Lt, atom: Atom<O.Option<B>>) {
    const reg = this.node.registry;
    return someEffect(() => reg.get(atom), reg, atom);
  },
  subscribe<B>(this: Lt, atom: Atom<B>, f: (b: B) => void, o?: { immediate?: boolean }) {
    this.addFinalizer(this.node.registry.subscribe(atom, f, o));
  },
  stream<B>(this: Lt, atom: Atom<B>, o?: { withoutInitialValue?: boolean; bufferSize?: number }) {
    return toStreamImpl(this.node.registry, atom, o);
  },
  streamResult<B, E>(this: Lt, atom: Atom<AR.AsyncResult<B, E>>, o?: { withoutInitialValue?: boolean; bufferSize?: number }) {
    return toStreamResult(this.node.registry, atom, o);
  },
}, Function.prototype);

export interface AtomRegistry {
  readonly [TypeId]: typeof TypeId;
  readonly getNodes: () => ReadonlyMap<Atom<any>, Node<any>>;
  readonly ensureNode: <A>(atom: Atom<A>) => Node<A>;
  readonly get: <A>(atom: Atom<A>) => A;
  readonly mount: <A>(atom: Atom<A>) => () => void;
  readonly refresh: <A>(atom: Atom<A>) => void;
  readonly set: <R, W>(atom: Writable<R, W>, value: W) => void;
  readonly modify: <R, W, A>(atom: Writable<R, W>, f: (_: R) => [returnValue: A, nextValue: W]) => A;
  readonly update: <R, W>(atom: Writable<R, W>, f: (_: R) => W) => void;
  readonly subscribe: <A>(atom: Atom<A>, f: (_: A) => void, options?: { readonly immediate?: boolean }) => () => void;
  readonly setSerializable: (key: string, encoded: unknown) => void;
  readonly preloadedSerializable: Map<string, unknown>;
  readonly reset: () => void;
  readonly dispose: () => void;
  scheduleNodeRemoval(node: Node<any>): void;
}
export class Registry implements AtomRegistry {
  readonly [TypeId]: typeof TypeId = TypeId;
  readonly nodes = new Map<Atom<any>, Node<any>>();
  private pendingRecompute: Array<Node<any>> = [];
  private pendingNotify: Array<Node<any>> = [];
  queueRecompute(n: Node<any>) {
    if (n.queuedRecompute) return;
    n.queuedRecompute = true;
    this.pendingRecompute.push(n);
  }
  queueNotify(n: Node<any>) {
    if (n.queuedNotify) return;
    n.queuedNotify = true;
    this.pendingNotify.push(n);
  }
  readonly preloadedSerializable = new Map<string, unknown>();
  readonly defaultIdleTTL: number | undefined;
  readonly scheduleTask: (f: () => void) => void;
  depth = 0;
  private disposed = false;
  constructor(options?: { readonly initialValues?: Iterable<readonly [Atom<any>, any, unknown?]> | undefined; readonly scheduleTask?: ((f: () => void) => unknown) | undefined; readonly defaultIdleTTL?: number | undefined }) {
    this.defaultIdleTTL = options?.defaultIdleTTL;
    this.scheduleTask = options?.scheduleTask ? (f) => void options.scheduleTask!(f) : queueMicrotask;
    for (const [atom, value] of options?.initialValues ?? []) {
      const n = this.ensureNode(atom);
      n.value = value;
      n.state = 1;
    }
  }
  getNodes = () => this.nodes;
  /** Run `f`, then recompute stale observed nodes and notify listeners once. */
  batch<T>(f: () => T): T {
    this.depth++;
    try {
      return f();
    } finally {
      if (--this.depth === 0) this.flush();
    }
  }
  flush() {
    while (this.pendingRecompute.length || this.pendingNotify.length) {
      const re = this.pendingRecompute;
      this.pendingRecompute = [];
      for (const n of re) {
        n.queuedRecompute = false;
        if (n.state === 1) continue;
        const prev = n.value;
        const hadValue = n.state !== 0;
        this.depth++;
        try {
          n.compute();
        } finally {
          this.depth--;
        }
        if (!hadValue || !n.atom.equals(prev, n.value)) this.queueNotify(n);
      }
      const no = this.pendingNotify;
      this.pendingNotify = [];
      for (const n of no) {
        n.queuedNotify = false;
        n.notify();
      }
    }
  }
  ensureNode = <A>(atom: Atom<A>): Node<A> => {
    let n = this.nodes.get(atom) as Node<A> | undefined;
    if (!n) {
      n = new Node(this, atom);
      this.nodes.set(atom, n);
      const key = (atom as { serializableKey?: string }).serializableKey;
      if (key !== undefined && this.preloadedSerializable.has(key)) {
        n.value = (atom as { decodeSerializable?: (u: unknown) => A }).decodeSerializable?.(this.preloadedSerializable.get(key)) ?? (this.preloadedSerializable.get(key) as A);
        n.state = 1;
      }
    } else if (n.removalTimer) {
      clearTimeout(n.removalTimer);
      n.removalTimer = undefined;
    }
    return n;
  };
  get = <A>(atom: Atom<A>): A => {
    const n = this.ensureNode(atom);
    if (n.state === 1) return n.value;
    this.depth++;
    let v: A;
    try {
      v = n.get();
    } finally {
      if (--this.depth === 0) this.flush();
    }
    if (n.canBeRemoved) this.scheduleNodeRemoval(n);
    return v;
  };
  subscribe = <A>(atom: Atom<A>, f: (a: A) => void, options?: { readonly immediate?: boolean }): (() => void) => {
    const n = this.ensureNode(atom);
    const l = () => f(n.get());
    n.listeners.add(l);
    if (options?.immediate) l();
    else this.batch(() => n.get());
    return () => {
      n.listeners.delete(l);
      if (n.canBeRemoved) this.scheduleNodeRemoval(n);
    };
  };
  mount = <A>(atom: Atom<A>): (() => void) => this.subscribe(atom, noopListener, { immediate: false });
  refresh = <A>(atom: Atom<A>): void => {
    const n = this.nodes.get(atom);
    if (atom.refresh) {
      atom.refresh((a) => this.refresh(a));
      return;
    }
    if (n) this.refreshNode(n);
  };
  refreshNode(n: Node<any>): void {
    this.batch(() => {
      n.invalidate();
      if (n.state === 2 && !n.listeners.size) this.queueRecompute(n);
    });
  }
  set = <R, W>(atom: Writable<R, W>, value: W): void => {
    const n = this.ensureNode(atom);
    this.depth++;
    try {
      if (n.state === 0) n.get();
      atom.write(n.writeContext as WriteContext<R>, value);
    } finally {
      if (--this.depth === 0) this.flush();
    }
    if (n.canBeRemoved) this.scheduleNodeRemoval(n);
  };
  modify = <R, W, A>(atom: Writable<R, W>, f: (r: R) => [A, W]): A => {
    const [a, w] = f(this.get(atom));
    this.set(atom, w);
    return a;
  };
  update = <R, W>(atom: Writable<R, W>, f: (r: R) => W): void => this.set(atom, f(this.get(atom)));
  setSerializable = (key: string, encoded: unknown) => void this.preloadedSerializable.set(key, encoded);
  scheduleNodeRemoval(n: Node<any>): void {
    if (this.disposed || n.removalTimer) return;
    const ttl = n.atom.idleTTL ?? this.defaultIdleTTL;
    const remove = () => {
      n.removalTimer = undefined;
      if (!n.canBeRemoved || this.nodes.get(n.atom) !== n) return;
      this.nodes.delete(n.atom);
      n.remove();
    };
    if (ttl !== undefined && ttl > 0) n.removalTimer = setTimeout(remove, ttl);
    else if (!n.removalQueued) {
      n.removalQueued = true;
      this.scheduleTask(() => {
        n.removalQueued = false;
        if (n.canBeRemoved) remove();
      });
    }
  }
  reset = () => {
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
  };
  dispose = () => {
    this.disposed = true;
    this.reset();
  };
}
const noopListener = () => {};
function writeContext<A>(reg: Registry, node: Node<A>): WriteContext<A> & { readonly "~node": Node<A> } {
  return {
    "~node": node,
    get: (atom) => reg.get(atom),
    refreshSelf: () => reg.refreshNode(node),
    setSelf: (a) => node.setValue(a),
    set: (atom, value) => reg.set(atom, value),
  };
}

export const make = (options?: { readonly initialValues?: Iterable<readonly [Atom<any>, any, unknown?]> | undefined; readonly scheduleTask?: ((f: () => void) => unknown) | undefined; readonly timeoutResolution?: number | undefined; readonly defaultIdleTTL?: number | undefined }): AtomRegistry =>
  new Registry(options);
export const isAtomRegistry = (u: unknown): u is AtomRegistry => u instanceof Registry;
export const AtomRegistry = Ctx.Service<AtomRegistry, AtomRegistry>("effect/reactivity/AtomRegistry");
export const layerOptions = (options?: Parameters<typeof make>[0]): Layer.Layer<AtomRegistry> =>
  Layer.effect(AtomRegistry, I.make((f) => {
    const reg = make(options);
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl;
    sc?.add(() => I.make(() => reg.dispose()));
    return reg;
  })) as never;
export const layer: Layer.Layer<AtomRegistry> = layerOptions();

/** Wait for the atom's result to be non-initial (and not waiting, if asked). */
function resultEffect<A, E>(read: () => AR.AsyncResult<A, E>, reg: AtomRegistry, atom: Atom<AR.AsyncResult<A, E>>, o?: { readonly suspendOnWaiting?: boolean }): I.Effect<A, E> {
  return I.make((f) => {
    const ready = (r: AR.AsyncResult<A, E>) => r._tag !== "Initial" && !(o?.suspendOnWaiting && r.waiting);
    const done = (r: AR.AsyncResult<A, E>): I.Step<A> => (r._tag === "Success" ? r.value : I.failWith((r as AR.Failure<A, E>).cause));
    const r0 = read();
    if (ready(r0)) return done(r0);
    return I.chain(I.interruptibleWait<AR.AsyncResult<A, E>>(f, (resolve) => {
      let un: () => void = noopListener;
      un = reg.subscribe(atom, (r) => {
        if (!ready(r)) return;
        un();
        resolve(r);
      }, { immediate: true });
      return () => un();
    }), done);
  });
}
function someEffect<A>(read: () => O.Option<A>, reg: AtomRegistry, atom: Atom<O.Option<A>>): I.Effect<A> {
  return I.make((f) => {
    const o0 = read();
    if (o0._tag === "Some") return o0.value;
    return I.interruptibleWait<A>(f, (resolve) => {
      let un: () => void = noopListener;
      un = reg.subscribe(atom, (o) => {
        if (o._tag === "None") return;
        un();
        resolve(o.value);
      }, { immediate: true });
      return () => un();
    });
  });
}
export const getResult: {
  <A, E>(atom: Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean }): (self: AtomRegistry) => I.Effect<A, E>;
  <A, E>(self: AtomRegistry, atom: Atom<AR.AsyncResult<A, E>>, options?: { readonly suspendOnWaiting?: boolean }): I.Effect<A, E>;
} = I.dual((args) => isAtomRegistry(args[0]), (self: AtomRegistry, atom: Atom<AR.AsyncResult<any, any>>, o?: { suspendOnWaiting?: boolean }) =>
  resultEffect(() => self.get(atom), self, atom, o));
function toStreamImpl<A>(reg: AtomRegistry, atom: Atom<A>, o?: { readonly withoutInitialValue?: boolean; readonly bufferSize?: number }): Stream.Stream<A> {
  return Stream.fromOpen((_, scope) => {
    const q = Q.makeUnsafe<A, Done>({ capacity: o?.bufferSize ?? 16, strategy: "sliding" });
    const un = reg.subscribe(atom, (a) => void q.tryOffer(a), { immediate: !o?.withoutInitialValue });
    scope.add(() => I.make(() => un()));
    return Stream.fromQueue(q).open(_, scope);
  });
}
export const toStream: {
  <A>(atom: Atom<A>): (self: AtomRegistry) => Stream.Stream<A>;
  <A>(self: AtomRegistry, atom: Atom<A>): Stream.Stream<A>;
} = I.dual(2, (self: AtomRegistry, atom: Atom<any>) => toStreamImpl(self, atom));
export function toStreamResult<A, E>(self: AtomRegistry, atom: Atom<AR.AsyncResult<A, E>>, o?: { readonly withoutInitialValue?: boolean; readonly bufferSize?: number }): Stream.Stream<A, E> {
  return Stream.filterMapEffect(toStreamImpl(self, atom, o), (r: AR.AsyncResult<A, E>) =>
    r._tag === "Success" ? I.make(() => O.some(r.value)) : r._tag === "Failure" ? I.make(() => I.failWith(r.cause)) : I.make(() => O.none())) as never;
}
/** Mount for the lifetime of the current Scope. */
export const mount: {
  <A>(atom: Atom<A>): (self: AtomRegistry) => I.Effect<void, never, ScopeM.Scope>;
  <A>(self: AtomRegistry, atom: Atom<A>): I.Effect<void, never, ScopeM.Scope>;
} = I.dual(2, (self: AtomRegistry, atom: Atom<any>) =>
  I.make((f) => {
    const sc = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
    if (!sc) return I.serviceNotFound(ScopeM.Scope.key);
    const un = self.mount(atom);
    sc.add(() => I.make(() => un()));
  }));
