import { diffProps, MATH_NS, setSelect, SVG_NS } from "./dom.ts";
import { CONSUMER, CONTEXT, ELEMENT, FORWARD_REF, Fragment, MEMO, PORTAL, Profiler, StrictMode, Suspense, type VNode } from "./jsx-runtime.ts";

const K = { Text: 0, Host: 1, Fn: 2, Class: 3, Frag: 4, Provider: 5, Portal: 6, Suspense: 7, Root: 8 } as const;
type K = (typeof K)[keyof typeof K];
export const Phase = { Insertion: 0, Layout: 1, Passive: 2 } as const;
type Phase = (typeof Phase)[keyof typeof Phase];

interface Hook {
  [k: string]: any;
  c?: (() => void) | undefined; // cleanup, run on unmount
}

export class Fiber {
  kids: Fiber[] = [];
  dom: any = null;
  i = 0;
  depth: number;
  ctx: any;
  dirty = false;
  deferred = false;
  dead = false;
  hooks: Hook[] | null = null;
  hi = 0;
  fx: Hook[] = [];
  inst: any = null;
  fn: ((props: any) => any) | null = null;
  cmp: ((a: any, b: any) => boolean) | null = null;
  ref: any = null;
  rc: (() => void) | null = null;
  subs: Set<Fiber> | null = null;
  cs: Fiber[] | null = null;
  susp: Fiber | null = null;
  pending: Set<Fiber> | null = null;
  hidden = false;
  rendering = false;
  stamp = 0;
  caught = 0;
  k: K;
  type: any;
  key: string | null;
  props: any;
  parent: Fiber | null;
  ns: string | null;
  constructor(k: K, type: any, key: string | null, props: any, parent: Fiber | null, ns: string | null) {
    this.k = k;
    this.type = type;
    this.key = key;
    this.props = props;
    this.parent = parent;
    this.ns = ns;
    this.depth = parent ? parent.depth + 1 : 0;
    this.ctx = parent ? parent.ctx : null;
  }
}

// ---------------------------------------------------------------- scheduling

type QueueEntry = Fiber | Hook | (() => void);
const Q = { mutation: [] as QueueEntry[], layout: [] as QueueEntry[], passiveDestroy: [] as QueueEntry[], passive: [] as QueueEntry[] };
let dirty: Fiber[] = [];
let deferred: Fiber[] = [];
let scheduled = false;
let flushing = false;
let batchDepth = 0;
let transitionDepth = 0;
let passiveScheduled = false;
let flushId = 0;
export let current: Fiber | null = null;
export let isServer = false;

/** True while rendering the transition lane: hooks then apply transition updates too. */
export let transitionFlush = false;
export const inTransition = () => transitionDepth > 0;

export function enqueue(f: Fiber, transition = transitionDepth > 0): void {
  if (f.dead) return;
  if (transition) {
    if (!f.deferred) (f.deferred = true), deferred.push(f) === 1 && setTimeout(flushDeferred);
    return;
  }
  if (!f.dirty) (f.dirty = true), dirty.push(f);
  if (!scheduled && !flushing && !batchDepth) (scheduled = true), queueMicrotask(flushWork);
}

function flushDeferred(): boolean {
  if (!deferred.length || flushing) return false;
  for (const f of deferred.splice(0)) {
    f.deferred = false;
    if (!f.dirty && !f.dead) (f.dirty = true), dirty.push(f);
  }
  transitionFlush = true;
  try {
    flushWork();
  } finally {
    transitionFlush = false;
  }
  return true;
}

export function startTransition(fn: () => unknown): void {
  transitionDepth++;
  try {
    fn();
  } finally {
    transitionDepth--;
  }
}

export function batchedUpdates<A, R>(fn: (a: A) => R, a?: A): R {
  batchDepth++;
  try {
    return fn(a as A);
  } finally {
    if (!--batchDepth) flushWork();
  }
}

export function flushSync<R>(fn?: () => R): R {
  const r = batchedUpdates(() => fn?.()) as R;
  flushWork();
  return r;
}

export function flushWork(): void {
  scheduled = false;
  if (flushing) return;
  flushing = true;
  flushId++;
  let uncaught: unknown;
  let guard = 0;
  try {
    flushPassive();
    while (dirty.length || Q.mutation.length || Q.layout.length) {
      if (++guard > 10_000) throw new Error("Too many re-renders.");
      while (dirty.length) {
        const list = dirty.sort((a, b) => a.depth - b.depth);
        dirty = [];
        for (const f of list) {
          if (!f.dirty || f.dead) continue;
          try {
            update(f, f.props, parentDom(f), nextDom(f));
          } catch (e) {
            uncaught ??= e;
            let root = f;
            while (root.parent) root = root.parent;
            for (const kid of root.kids) unmount(kid, true);
            root.kids = [];
          }
        }
      }
      run(Q.mutation, true);
      run(Q.layout, false);
    }
  } finally {
    flushing = false;
  }
  if ((Q.passive.length || Q.passiveDestroy.length) && !passiveScheduled) {
    passiveScheduled = true;
    later(() => {
      if (!passiveScheduled) return;
      flushPassive();
      flushWork();
    });
  }
  if (uncaught !== undefined) throw uncaught;
}

const later: (fn: () => void) => void =
  typeof MessageChannel === "function" && typeof window !== "undefined"
    ? (() => {
        const channel = new MessageChannel();
        const tasks: Array<() => void> = [];
        channel.port1.onmessage = () => tasks.shift()?.();
        return (fn) => (tasks.push(fn), channel.port2.postMessage(null));
      })()
    : (fn) => setTimeout(fn);

function flushPassive() {
  passiveScheduled = false;
  run(Q.passiveDestroy, true);
  run(Q.passive, false);
}

function run(queue: QueueEntry[], destroy: boolean) {
  if (!queue.length) return;
  const list = queue.splice(0);
  for (let i = 0; i < list.length; i += 2) {
    const f = list[i] as Fiber;
    const job = list[i + 1] as Hook | (() => void);
    if (f.dead) continue;
    try {
      if (typeof job === "function") job();
      else if (destroy) runCleanup(job);
      else {
        const r = job.cb();
        job.c = typeof r === "function" ? r : undefined;
      }
    } catch (e) {
      handleError(f, e);
    }
  }
}

function runCleanup(h: Hook) {
  const c = h.c;
  h.c = undefined;
  c?.();
}

/** Runs `fn`, then drains every render and effect it caused (React 19 `act`). */
export function act<T>(fn: () => T): T extends PromiseLike<any> ? Promise<Awaited<T>> : PromiseLike<T> {
  const drain = () => {
    do {
      flushWork();
      flushPassive();
    } while (dirty.length || flushDeferred());
  };
  const r: any = batchedUpdates(fn);
  if (r && typeof r.then === "function") return r.then((v: any) => (drain(), v));
  drain();
  return { then: (resolve: (v: T) => unknown) => resolve(r) } as any;
}

// ---------------------------------------------------------------- tree helpers

function parentDom(f: Fiber): any {
  for (let c = f, p = f.parent; p; c = p, p = p.parent) {
    if (p.k === K.Host || p.k === K.Portal || p.k === K.Root) return p.dom;
    if (p.k === K.Suspense && p.hidden && c === p.kids[0]) return p.dom;
  }
  return f.dom;
}

function nextDom(f: Fiber): any {
  for (let c = f, p = f.parent; p; c = p, p = p.parent) {
    if (p.k === K.Suspense && p.hidden && c === p.kids[0]) return null;
    for (let i = c.i + 1; i < p.kids.length; i++) {
      const d = firstDom(p.kids[i]!);
      if (d) return d;
    }
    if (p.k === K.Host || p.k === K.Portal || p.k === K.Root) return null;
  }
  return null;
}

function firstDom(f: Fiber): any {
  if (f.k === K.Host || f.k === K.Text) return f.dom;
  if (f.k === K.Portal) return null;
  for (let i = f.k === K.Suspense && f.hidden ? 1 : 0; i < f.kids.length; i++) {
    const d = firstDom(f.kids[i]!);
    if (d) return d;
  }
  return null;
}

function lastDom(f: Fiber): any {
  if (f.k === K.Host || f.k === K.Text) return f.dom;
  if (f.k === K.Portal) return null;
  const end = f.k === K.Suspense && f.hidden ? 1 : 0;
  for (let i = f.kids.length - 1; i >= end; i--) {
    const d = lastDom(f.kids[i]!);
    if (d) return d;
  }
  return null;
}

function topNodes(f: Fiber, out: any[]): any[] {
  if (f.k === K.Host || f.k === K.Text) out.push(f.dom);
  else if (f.k !== K.Portal) for (let i = f.k === K.Suspense && f.hidden ? 1 : 0; i < f.kids.length; i++) topNodes(f.kids[i]!, out);
  return out;
}

function endOf(f: Fiber, cursor: any): any {
  const last = lastDom(f);
  return last ? last.nextSibling : cursor;
}

function move(f: Fiber, pdom: any, cursor: any): any {
  const nodes = topNodes(f, []);
  for (let i = nodes.length - 1, next = cursor; i >= 0; next = nodes[i--]) {
    if (nodes[i].nextSibling !== next || nodes[i].parentNode !== pdom) pdom.insertBefore(nodes[i], next);
  }
  return cursor;
}

// ---------------------------------------------------------------- children

const EMPTY: any = {};

function normalize(c: any): any {
  if (c == null || typeof c === "boolean") return null;
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "bigint") return String(c);
  if (c.$$typeof === ELEMENT) return c;
  if (Array.isArray(c) || (typeof c[Symbol.iterator] === "function" && (c = [...c]))) return { $$typeof: ELEMENT, type: Fragment, key: null, props: { children: c } };
  throw new Error(`Objects are not valid as a React child (found: ${Object.prototype.toString.call(c)}).`);
}

const keyOf = (v: any, i: number) => (typeof v !== "string" && v.key != null ? `$${v.key}` : `.${i}`);
const sameType = (f: Fiber, v: any) => (typeof v === "string" ? f.k === K.Text : f.type === v.type && (f.k !== K.Portal || f.props.container === v.props.container));

let stampSeq = 0;

/** Keyed diff of `parent`'s children; returns the DOM cursor just past them. */
export function diffKids(parent: Fiber, children: any, pdom: any, cursor: any): any {
  const old = parent.kids;
  const ns = parent.k === K.Host && parent.type === "foreignObject" ? null : parent.ns;
  if (!Array.isArray(children)) {
    const v = normalize(children);
    const prev = old.length === 1 ? old[0]! : null;
    if (prev && v != null && prev.key === keyOf(v, 0) && sameType(prev, v)) return update(prev, typeof v === "string" ? v : v.props, pdom, cursor);
    for (const f of old) unmount(f, true);
    parent.kids = [];
    if (v == null) return cursor;
    const f = create(v, keyOf(v, 0), parent, ns);
    parent.kids = [f];
    return update(f, typeof v === "string" ? v : v.props, pdom, cursor);
  }

  const n = children.length;
  const nv: any[] = new Array(n);
  const nk: (string | null)[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const v = (nv[j] = normalize(children[j]));
    nk[j] = v == null ? null : keyOf(v, j);
  }
  const matched: (Fiber | null)[] = new Array(n).fill(null);
  const stamp = ++stampSeq;
  let os = 0, oe = old.length - 1, js = 0, je = n - 1;
  for (; js <= je; js++) {
    if (nv[js] == null) continue;
    const o = old[os];
    if (os > oe || o!.key !== nk[js] || !sameType(o!, nv[js])) break;
    (matched[js] = o!).stamp = stamp;
    os++;
  }
  for (; je >= js; je--) {
    if (nv[je] == null) continue;
    const o = old[oe];
    if (oe < os || o!.key !== nk[je] || !sameType(o!, nv[je])) break;
    (matched[je] = o!).stamp = stamp;
    oe--;
  }
  let moved: Uint8Array | null = null;
  if (js <= je && os <= oe) {
    const byKey = new Map<string, Fiber>();
    for (let i = os; i <= oe; i++) (old[i]!.i = i), byKey.set(old[i]!.key!, old[i]!);
    const sources: number[] = [];
    const slots: number[] = [];
    for (let j = js; j <= je; j++) {
      const v = nv[j];
      if (v == null) continue;
      const o = byKey.get(nk[j]!);
      if (o && sameType(o, v)) {
        byKey.delete(nk[j]!);
        (matched[j] = o).stamp = stamp;
        sources.push(o.i);
        slots.push(j);
      }
    }
    const keep = lis(sources);
    moved = new Uint8Array(n);
    for (let s = 0, k = 0; s < sources.length; s++) {
      if (keep[k] === s) k++;
      else moved[slots[s]!] = 1;
    }
  }
  let start: any;
  for (const f of old) {
    if (f.stamp !== stamp) unmount(f, true);
    else start ??= firstDom(f);
  }
  cursor = start ?? cursor;
  const kids: Fiber[] = [];
  for (let j = 0; j < n; j++) {
    const v = nv[j];
    if (v == null) continue;
    const props = typeof v === "string" ? v : v.props;
    let f = matched[j];
    if (!f) cursor = update((f = create(v, nk[j]!, parent, ns)), props, pdom, cursor);
    else if (moved?.[j]) update(f, props, pdom, cursor), (cursor = move(f, pdom, cursor));
    else cursor = update(f, props, pdom, cursor);
    f.i = kids.length;
    kids.push(f);
  }
  parent.kids = kids;
  return cursor;
}

/** Indices (into `a`) of one longest strictly increasing subsequence. */
function lis(a: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[tails[mid]!]! < a[i]!) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const out: number[] = new Array(tails.length);
  for (let i = tails.length - 1, k = tails[i]!; i >= 0; i--, k = prev[k]!) out[i] = k;
  return out;
}

function create(v: any, key: string, parent: Fiber, ns: string | null): Fiber {
  if (typeof v === "string") return new Fiber(K.Text, null, key, null, parent, ns);
  let type = v.type;
  let k: K;
  let fn: any = null;
  let cmp: any = null;
  if (typeof type === "string") (k = K.Host), (ns = type === "svg" ? SVG_NS : type === "math" ? MATH_NS : ns);
  else if (type === Fragment || type === StrictMode || type === Profiler) k = K.Frag;
  else if (type === Suspense) k = K.Suspense;
  else if (type === PORTAL) (k = K.Portal), (ns = v.props.container.namespaceURI === SVG_NS ? SVG_NS : null);
  else {
    let inner = type;
    if (inner?.$$typeof === MEMO) (cmp = inner.compare ?? shallowEqual), (inner = inner.type);
    if (inner?.$$typeof === FORWARD_REF) {
      const render = inner.render;
      (k = K.Fn), (fn = (p: any) => render(withoutRef(p), p.ref ?? null));
    } else if (inner?.$$typeof === CONTEXT) k = K.Provider;
    else if (inner?.$$typeof === CONSUMER) {
      const ctx = inner._context;
      (k = K.Fn), (fn = (p: any) => p.children(readContext(ctx)));
    } else if (typeof inner === "function") (k = inner.prototype?.isReactComponent ? K.Class : K.Fn), (fn = inner);
    else throw new Error(`Element type is invalid: ${String(type)}`);
  }
  const f = new Fiber(k, type, key, null, parent, ns);
  f.fn = fn;
  f.cmp = cmp;
  if (k === K.Provider) (f.ctx = Object.create(f.ctx)), (f.ctx[type._id] = f), (f.subs = new Set());
  if (k === K.Suspense) f.pending = new Set();
  return f;
}

export function withoutRef(p: any): any {
  if (!("ref" in p)) return p;
  const { ref: _, ...rest } = p;
  return rest;
}

export function shallowEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  let n = 0;
  for (const k in a) if (n++, !(k in b) || !Object.is(a[k], b[k])) return false;
  for (const _ in b) n--;
  return n === 0;
}

// ---------------------------------------------------------------- update

function update(f: Fiber, props: any, pdom: any, cursor: any): any {
  switch (f.k) {
    case K.Text:
      if (!f.dom) {
        f.dom = pdom.ownerDocument.createTextNode((f.props = props));
        pdom.insertBefore(f.dom, cursor);
        return cursor;
      }
      if (f.props !== props) f.dom.data = f.props = props;
      return f.dom.nextSibling;
    case K.Host:
      return updateHost(f, props, pdom, cursor);
    case K.Root:
      f.dirty = false;
      diffKids(f, props, f.dom, null);
      return null;
    case K.Portal:
      if (f.dom && f.dom !== props.container) for (const kid of f.kids.splice(0)) unmount(kid, true);
      f.dom = props.container;
      f.props = props;
      diffKids(f, props.children, f.dom, null);
      return cursor;
    case K.Provider:
      if (f.props && !Object.is(f.props.value, props.value)) for (const sub of f.subs!) enqueue(sub);
      f.props = props;
      return diffKids(f, props.children, pdom, cursor);
    case K.Frag:
      f.props = props;
      return diffKids(f, props.children, pdom, cursor);
    case K.Suspense:
      return updateSuspense(f, props, pdom, cursor);
    default:
      return updateComponent(f, props, pdom, cursor);
  }
}

function updateHost(f: Fiber, props: any, pdom: any, cursor: any): any {
  let dom = f.dom;
  const isNew = !dom;
  const old = isNew ? EMPTY : f.props;
  if (isNew) {
    const doc = pdom.ownerDocument ?? pdom;
    dom = f.dom = f.ns ? doc.createElementNS(f.ns, f.type) : props.is ? doc.createElement(f.type, { is: props.is }) : doc.createElement(f.type);
  }
  dom.__f = f;
  f.props = props;
  diffProps(dom, f.type, old, props, f.ns === SVG_NS);
  const html = props.dangerouslySetInnerHTML;
  if (html) {
    for (const kid of f.kids) unmount(kid, false);
    f.kids = [];
    if (html.__html !== old.dangerouslySetInnerHTML?.__html) dom.innerHTML = html.__html ?? "";
  } else {
    if (old.dangerouslySetInnerHTML) dom.textContent = "";
    diffKids(f, props.children, dom, null);
  }
  if (f.type === "select" && (props.value !== undefined || (isNew && props.defaultValue !== undefined))) {
    setSelect(dom, props.value ?? props.defaultValue, props.multiple);
  }
  attachRef(f, props.ref, dom);
  if (isNew && props.autoFocus) Q.layout.push(f, () => dom.focus?.());
  if (isNew) {
    pdom.insertBefore(dom, cursor);
    return cursor;
  }
  return dom.nextSibling;
}

function attachRef(f: Fiber, ref: any, value: any) {
  const prev = f.ref;
  if (prev === ref) return;
  if (prev) Q.mutation.push(f, () => clearRef(f, prev));
  if (ref) Q.layout.push(f, () => setRef(f, ref, value));
  f.ref = ref ?? null;
}

function setRef(f: Fiber, ref: any, value: any) {
  if (typeof ref === "function") {
    const cleanup = ref(value);
    f.rc = typeof cleanup === "function" ? cleanup : null;
  } else ref.current = value;
}

function clearRef(f: Fiber, ref: any) {
  if (typeof ref !== "function") ref.current = null;
  else if (f.rc) f.rc(), (f.rc = null);
  else ref(null);
}

function updateSuspense(f: Fiber, props: any, pdom: any, cursor: any): any {
  f.dirty = false;
  f.rendering = true;
  f.props = props;
  let at = firstDom(f) ?? cursor;
  let content = f.kids[0];
  const contentProps = { children: props.children };
  if (!content) (content = f.kids[0] = create({ type: Fragment, props: contentProps }, "c", f, f.ns)), (content.i = 0);
  if (f.hidden) (content.props = contentProps), diffKids(content, props.children, f.dom, null);
  else at = update(content, contentProps, pdom, at);
  f.rendering = false;
  let fallback = f.kids[1];
  if (f.pending!.size) {
    if (!f.hidden) {
      f.hidden = true;
      f.dom ??= pdom.ownerDocument.createElement("div");
      for (const node of topNodes(content, [])) f.dom.appendChild(node);
    }
    const fb = { children: props.fallback };
    if (!fallback) (fallback = f.kids[1] = create({ type: Fragment, props: fb }, "f", f, f.ns)), (fallback.i = 1);
    return update(fallback, fb, pdom, at);
  }
  if (f.hidden) {
    f.hidden = false;
    const fbFirst = fallback && firstDom(fallback);
    const end = fbFirst ? lastDom(fallback!).nextSibling : at;
    for (const node of topNodes(content, [])) pdom.insertBefore(node, fbFirst ?? at);
    if (fallback) unmount(fallback, true);
    f.kids.length = 1;
    return end;
  }
  return at;
}

// ---------------------------------------------------------------- components

const BAIL = Symbol();

function updateComponent(f: Fiber, props: any, pdom: any, cursor: any): any {
  const mounted = f.hooks !== null || f.inst !== null;
  if (mounted && !f.dirty && (props === f.props || (f.cmp && f.cmp(f.props, props)))) {
    f.props = props;
    return endOf(f, cursor);
  }
  f.dirty = false;
  f.props = props;
  const out = f.k === K.Class ? renderClass(f, props) : renderFn(f, props);
  if (out === BAIL) return endOf(f, cursor);
  if (f.susp) {
    const boundary = f.susp;
    f.susp = null;
    boundary.pending!.delete(f);
    if (!boundary.pending!.size && !boundary.rendering) enqueue(boundary);
  }
  cursor = diffKids(f, out, pdom, cursor);
  if (f.k === K.Class) commitClass(f);
  else commitEffects(f);
  return cursor;
}

function renderFn(f: Fiber, props: any): any {
  f.hooks ??= [];
  f.hi = 0;
  f.fx.length = 0;
  current = f;
  try {
    return f.fn!(props);
  } catch (e) {
    f.fx.length = 0;
    handleThrow(f, e);
    return BAIL;
  } finally {
    current = null;
  }
}

function commitEffects(f: Fiber) {
  for (const h of f.fx) {
    h.deps = h.nextDeps;
    if (h.phase === Phase.Insertion) Q.mutation.push(f, () => (runCleanup(h), (h.c = h.cb() ?? undefined)));
    else if (h.phase === Phase.Layout) Q.mutation.push(f, h), Q.layout.push(f, h);
    else Q.passiveDestroy.push(f, h), Q.passive.push(f, h);
  }
  f.fx.length = 0;
}

function renderClass(f: Fiber, rawProps: any): any {
  const C = f.type;
  const props = withoutRef(rawProps);
  current = f;
  try {
    const context = C.contextType ? readContext(C.contextType) : undefined;
    let inst = f.inst;
    if (!inst) {
      inst = f.inst = new C(props, context);
      inst.props = props;
      inst.context = context;
      inst._f = f;
      if (inst.state === undefined) inst.state = null;
      inst.state = derive(C, props, inst.state);
      inst._mount = true;
    } else {
      let state = inst.state;
      for (const p of inst._q?.splice(0) ?? []) {
        const part = typeof p === "function" ? p.call(inst, state, props) : p;
        if (part != null) state = { ...state, ...part };
      }
      state = derive(C, props, state);
      const force = inst._force;
      inst._force = false;
      const skip =
        !force &&
        (inst.shouldComponentUpdate
          ? !inst.shouldComponentUpdate(props, state, context)
          : C.prototype.isPureReactComponent && shallowEqual(inst.props, props) && shallowEqual(inst.state, state));
      inst._prev = [inst.props, inst.state];
      inst.props = props;
      inst.state = state;
      inst.context = context;
      if (skip) return flushClassCallbacks(f), BAIL;
      inst._snap = inst.getSnapshotBeforeUpdate?.(inst._prev[0], inst._prev[1]);
    }
    attachRef(f, rawProps.ref, inst);
    return inst.render();
  } catch (e) {
    handleThrow(f, e);
    return BAIL;
  } finally {
    current = null;
  }
}

function derive(C: any, props: any, state: any) {
  const part = C.getDerivedStateFromProps?.(props, state);
  return part == null ? state : { ...state, ...part };
}

function commitClass(f: Fiber) {
  const inst = f.inst;
  if (inst._mount) {
    inst._mount = false;
    if (inst.componentDidMount) Q.layout.push(f, () => inst.componentDidMount());
  } else if (inst.componentDidUpdate) {
    const [prevProps, prevState] = inst._prev;
    const snap = inst._snap;
    Q.layout.push(f, () => inst.componentDidUpdate(prevProps, prevState, snap));
  }
  flushClassCallbacks(f);
}

function flushClassCallbacks(f: Fiber) {
  const cbs = f.inst._cb;
  if (cbs?.length) Q.layout.push(f, () => cbs.splice(0).forEach((cb: () => void) => cb.call(f.inst)));
}

function handleThrow(f: Fiber, e: any) {
  if (e && typeof e.then === "function") {
    let b = f.parent;
    while (b && b.k !== K.Suspense) b = b.parent;
    if (b) b.pending!.add(f), (f.susp = b);
    const retry = () => enqueue(f);
    e.then(retry, retry);
  } else handleError(f, e);
}

export function handleError(f: Fiber, error: unknown): void {
  for (let p = f.parent; p; p = p.parent) {
    const C = p.type;
    if (p.k !== K.Class || !p.inst || p.dead || p.caught === flushId || !(C.getDerivedStateFromError || p.inst.componentDidCatch)) continue;
    p.caught = flushId;
    if (C.getDerivedStateFromError) (p.inst._q ??= []).push(C.getDerivedStateFromError(error));
    if (p.inst.componentDidCatch) Q.layout.push(p, () => p.inst.componentDidCatch(error, { componentStack: "" }));
    enqueue(p);
    return;
  }
  throw error;
}

// ---------------------------------------------------------------- unmount

function unmount(f: Fiber, remove: boolean): void {
  f.dead = true;
  try {
    if (f.hooks) for (const h of f.hooks) if (h.c) runCleanup(h);
    f.inst?.componentWillUnmount?.();
    if (f.ref) clearRef(f, f.ref);
  } catch (e) {
    reportError(e);
  }
  if (f.cs) for (const p of f.cs) p.subs!.delete(f);
  if (f.susp) {
    const b = f.susp;
    b.pending!.delete(f);
    if (!b.pending!.size) enqueue(b);
  }
  let removeKids = remove;
  if (f.k === K.Host || f.k === K.Text) {
    if (remove) f.dom.parentNode?.removeChild(f.dom);
    removeKids = false;
  } else if (f.k === K.Portal) removeKids = true;
  for (const kid of f.kids) unmount(kid, removeKids);
}

const reportError = (e: unknown) => (typeof globalThis.reportError === "function" ? globalThis.reportError(e) : console.error(e));

// ---------------------------------------------------------------- hook plumbing

export function hook(): Hook {
  const f = current;
  if (!f) throw new Error("Invalid hook call: hooks can only be called inside a function component.");
  return (f.hooks![f.hi++] ??= {});
}

export function queueEffect(h: Hook, phase: Phase, cb: () => unknown, deps: readonly unknown[] | undefined): void {
  if (!h.deps || !deps || depsChanged(h.deps, deps)) {
    h.cb = cb;
    h.phase = phase;
    h.nextDeps = deps;
    current!.fx.push(h);
  }
}

export const depsChanged = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

export function readContext(ctx: any): any {
  const f = current;
  const provider: Fiber | undefined = f?.ctx?.[ctx._id];
  if (!provider) return ctx._currentValue;
  if (!isServer && !provider.subs!.has(f!)) provider.subs!.add(f!), (f!.cs ??= []).push(provider);
  return provider.props.value;
}

// ---------------------------------------------------------------- roots

export function createRootFiber(container: any): Fiber {
  const f = new Fiber(K.Root, null, null, null, null, container.namespaceURI === SVG_NS ? SVG_NS : null);
  f.dom = container;
  f.ctx = Object.create(null);
  return f;
}

export function unmountRoot(f: Fiber): void {
  for (const kid of f.kids) unmount(kid, true);
  f.kids = [];
  f.dead = true;
}

export function createPortal(children: any, container: any, key?: string | null): VNode {
  return { $$typeof: ELEMENT, type: PORTAL, key: key == null ? null : String(key), props: { children, container } };
}

let serverFiber: Fiber | null = null;

/** Server rendering: runs a function component with hooks against a reused, inert fiber. */
export function renderServerComponent(fn: (p: any) => any, props: any, ctx: any): any {
  const prev = current;
  const prevServer = isServer;
  const f = !serverFiber || prev === serverFiber ? new Fiber(K.Fn, null, null, null, null, null) : serverFiber;
  serverFiber ??= f;
  f.ctx = ctx;
  f.hooks = [];
  f.hi = 0;
  f.dead = true; // updates scheduled during server render go nowhere
  current = f;
  isServer = true;
  try {
    return fn(props);
  } finally {
    current = prev;
    isServer = prevServer;
  }
}

export const serverContextFiber = (value: any) => new Fiber(K.Provider, null, null, { value }, null, null);
