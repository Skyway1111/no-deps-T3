/**
 * Runtime kernel. An Effect is a closure `(fiber) => A | Async<A> | Failure`: sync
 * work returns directly, async work returns an `Async` wrapping a native Promise, and
 * failure is a `Failure` carrying a Cause, either returned (cheap) or thrown.
 * `execF` hands failures back as values; `exec` throws them. No interpreter loop.
 */

// ---------- pipe ----------
export function pipeArgs(self: unknown, args: IArguments | ReadonlyArray<Function>): any {
  let out = self;
  for (let i = 0; i < args.length; i++) out = (args[i] as Function)(out);
  return out;
}
export interface Pipeable {
  pipe<A>(this: A): A;
  pipe<A, B>(this: A, ab: (a: A) => B): B;
  pipe<A, B, C>(this: A, ab: (a: A) => B, bc: (b: B) => C): C;
  pipe<A, B, C, D>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<A, B, C, D, E>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E;
  pipe<A, B, C, D, E, F>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F): F;
  pipe<A, B, C, D, E, F, G>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G): G;
  pipe<A, B, C, D, E, F, G, H>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H): H;
  pipe<A, B, C, D, E, F, G, H, I>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E, ef: (e: E) => F, fg: (f: F) => G, gh: (g: G) => H, hi: (h: H) => I): I;
  pipe(this: unknown, ...fns: ReadonlyArray<Function>): unknown;
}
export const PipeProto = {
  pipe(this: unknown) {
    return pipeArgs(this, arguments);
  },
};

/** `dual(arity, f)` lets `f(self, ...args)` also be called data-last as `f(...args)(self)`. */
export const dual = function (arity: number | ((args: IArguments) => boolean), body: Function): any {
  const isDataFirst = typeof arity === "number" ? (args: IArguments) => args.length >= arity : arity;
  return function (this: unknown) {
    if (isDataFirst(arguments)) return body.apply(this, arguments);
    const n = arguments.length;
    const a = arguments[0];
    const b = arguments[1];
    if (n === 1) return (self: unknown) => body(self, a);
    if (n === 2) return (self: unknown) => body(self, a, b);
    const args = Array.from(arguments);
    return (self: unknown) => body(self, ...args);
  };
} as <DataLast extends (...args: any) => any, DataFirst extends (...args: any) => any>(
  arity: number | ((args: IArguments) => boolean),
  body: DataFirst,
) => DataLast & DataFirst;

// ---------- equality / hashing ----------
export const EqualSymbol: unique symbol = Symbol.for("effect/Equal") as never;
export const HashSymbol: unique symbol = Symbol.for("effect/Hash") as never;
export interface Equal {
  [EqualSymbol](that: unknown): boolean;
  [HashSymbol](): number;
}
export const isEqual = (u: unknown): u is Equal =>
  typeof u === "object" && u !== null && EqualSymbol in u;

export function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (isEqual(a)) return isEqual(b) && a[EqualSymbol](b);
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  return false;
}
export function structuralEquals(a: object, b: object): boolean {
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!equals((a as any)[k], (b as any)[k])) return false;
  return true;
}
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h | 0;
}
export function hash(u: unknown): number {
  switch (typeof u) {
    case "number":
      return Number.isInteger(u) ? u | 0 : hashString(String(u));
    case "string":
      return hashString(u);
    case "boolean":
      return u ? 1 : 0;
    case "bigint":
      return hashString(u.toString());
    case "undefined":
      return 2;
    case "symbol":
      return hashString(String(u));
    case "function":
    case "object":
      if (u === null) return 3;
      if (isEqual(u)) return u[HashSymbol]();
      return randomHash(u as object);
  }
}
const hashCache = new WeakMap<object, number>();
function randomHash(o: object): number {
  let h = hashCache.get(o);
  if (h === undefined) hashCache.set(o, (h = (Math.random() * 0x7fffffff) | 0));
  return h;
}
export function structuralHash(o: object): number {
  let h = 17;
  for (const k of Object.keys(o)) h = (h * 31 + hashString(k) + hash((o as any)[k])) | 0;
  return h;
}
export const StructuralProto = {
  [EqualSymbol](this: object, that: unknown) {
    return typeof that === "object" && that !== null && structuralEquals(this, that);
  },
  [HashSymbol](this: object) {
    return structuralHash(this);
  },
};

// ---------- async boxing ----------
/** Marks an in-flight async result. Wrapping avoids confusing user Promises with ours. */
export class Async<A = unknown> {
  protected q: Promise<A> | undefined;
  constructor(p?: Promise<A>) {
    this.q = p;
  }
  get p(): Promise<A> {
    return this.q!;
  }
  /** Subscribe the single consumer. */
  listen(ok: (a: unknown) => void, err: (e: unknown) => void): void {
    this.p.then(ok, err);
  }
}
/**
 * An Async settled by callback from a Promise reaction (or interruption), so a `listen`
 * consumer runs in that same microtask with no Promise of its own; `.p` is built on demand.
 */
export class Waiter<A = unknown> extends Async<A> {
  private s: 0 | 1 | 2 = 0;
  private v: unknown = undefined;
  private ok: ((a: unknown) => void) | undefined = undefined;
  private err: ((e: unknown) => void) | undefined = undefined;
  override get p(): Promise<A> {
    return (this.q ??= new Promise<A>((res, rej) => this.listen(res as (a: unknown) => void, rej)));
  }
  override listen(ok: (a: unknown) => void, err: (e: unknown) => void): void {
    if (this.s === 0) {
      this.ok = ok;
      this.err = err;
    } else {
      const { s, v } = this;
      queueMicrotask(() => (s === 1 ? ok : err)(v));
    }
  }
  settle(failed: boolean, v: unknown): void {
    if (this.s !== 0) return;
    this.s = failed ? 2 : 1;
    this.v = v;
    const k = failed ? this.err : this.ok;
    this.ok = this.err = undefined;
    k?.(v);
  }
}
class Box {
  readonly v: unknown;
  constructor(v: unknown) {
    this.v = v;
  }
}
const isThenable = (v: unknown): boolean =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as any).then === "function";
export const box = (v: unknown): unknown => (isThenable(v) ? new Box(v) : v);
export const unbox = (v: unknown): any => (v instanceof Box ? v.v : v);
/** Turn a step result into something a `.then` callback may return. */
export const toThen = (r: unknown): unknown => {
  if (r instanceof Async) return r.p;
  if (r instanceof Failure) throw r;
  return box(r);
};

export type Step<A> = A | Async<A>;

/** `r` then `k`; stays synchronous when `r` is, and passes a returned `Failure` through. */
export function chain<A, B>(r: Step<A>, k: (a: A) => Step<B>): Step<B>;
export function chain<A, B>(r: Step<A> | Failure, k: (a: A) => Step<B> | Failure): Step<B> | Failure;
export function chain<A, B>(r: Step<A> | Failure, k: (a: A) => Step<B> | Failure): Step<B> | Failure {
  if (r instanceof Async) return new Async(r.p.then((a) => toThen(k(unbox(a))))) as Async<B>;
  return r instanceof Failure ? r : k(r);
}
/** Run `onDone` after `r` settles either way (sync or async); `onDone` may rethrow/replace. */
export function settle<A, B>(r: () => Step<A> | Failure, onOk: (a: A) => Step<B>, onErr: (e: unknown) => Step<B>): Step<B>;
export function settle<A, B>(r: () => Step<A> | Failure, onOk: (a: A) => Step<B> | Failure, onErr: (e: unknown) => Step<B> | Failure): Step<B> | Failure;
export function settle<A, B>(
  r: () => Step<A> | Failure,
  onOk: (a: A) => Step<B> | Failure,
  onErr: (e: unknown) => Step<B> | Failure,
): Step<B> | Failure {
  let out: Step<A> | Failure;
  try {
    out = r();
  } catch (e) {
    return onErr(e);
  }
  if (out instanceof Failure) return onErr(out);
  if (!(out instanceof Async)) return onOk(out);
  return new Async(
    out.p.then(
      (a) => toThen(onOk(unbox(a))),
      (e) => toThen(onErr(e)),
    ),
  ) as Async<B>;
}

// ---------- Cause / Exit data ----------
export type Reason<E> = Fail<E> | Die | Interrupt;
export interface Fail<E> {
  readonly _tag: "Fail";
  readonly error: E;
  readonly annotations: ReadonlyMap<string, unknown>;
}
export interface Die {
  readonly _tag: "Die";
  readonly defect: unknown;
  readonly annotations: ReadonlyMap<string, unknown>;
}
export interface Interrupt {
  readonly _tag: "Interrupt";
  readonly fiberId: number | undefined;
  readonly annotations: ReadonlyMap<string, unknown>;
}
export const CauseTypeId: unique symbol = Symbol.for("effect/Cause") as never;
export interface Cause<out E> extends Pipeable, Equal {
  readonly [CauseTypeId]: typeof CauseTypeId;
  readonly reasons: ReadonlyArray<Reason<E>>;
}
const emptyAnn: ReadonlyMap<string, unknown> = new Map();
const CauseProto = {
  ...PipeProto,
  [CauseTypeId]: CauseTypeId,
  [EqualSymbol](this: Cause<unknown>, that: unknown) {
    return (
      isCause(that) &&
      that.reasons.length === this.reasons.length &&
      this.reasons.every((r, i) => reasonEquals(r, that.reasons[i]!))
    );
  },
  [HashSymbol](this: Cause<unknown>) {
    return this.reasons.length;
  },
  toString(this: Cause<unknown>) {
    return prettyCause(this);
  },
  toJSON(this: Cause<unknown>) {
    return { _id: "Cause", reasons: this.reasons.map((r) => ({ ...r, annotations: undefined })) };
  },
};
function reasonEquals(a: Reason<unknown>, b: Reason<unknown>): boolean {
  if (a._tag !== b._tag) return false;
  if (a._tag === "Fail") return equals(a.error, (b as Fail<unknown>).error);
  if (a._tag === "Die") return equals(a.defect, (b as Die).defect);
  return a.fiberId === (b as Interrupt).fiberId;
}
export const isCause = (u: unknown): u is Cause<unknown> =>
  typeof u === "object" && u !== null && CauseTypeId in u;
export function makeCause<E>(reasons: ReadonlyArray<Reason<E>>): Cause<E> {
  const c = Object.create(CauseProto);
  c.reasons = reasons;
  return c;
}
export const makeFailReason = <E>(error: E): Fail<E> => ({ _tag: "Fail", error, annotations: emptyAnn });
export const makeDieReason = (defect: unknown): Die => ({ _tag: "Die", defect, annotations: emptyAnn });
export const makeInterruptReason = (fiberId?: number): Interrupt => ({
  _tag: "Interrupt",
  fiberId,
  annotations: emptyAnn,
});
export const causeEmpty: Cause<never> = makeCause([]);
export const causeFail = <E>(e: E): Cause<E> => makeCause([makeFailReason(e)]);
export const causeDie = (d: unknown): Cause<never> => makeCause([makeDieReason(d)]);
export const causeInterrupt = (id?: number): Cause<never> => makeCause([makeInterruptReason(id)]);

export function prettyCause(cause: Cause<unknown>): string {
  if (cause.reasons.length === 0) return "All fibers interrupted without error";
  return cause.reasons
    .map((r) => {
      if (r._tag === "Interrupt") return `InterruptError: interrupted${r.fiberId === undefined ? "" : ` by fiber #${r.fiberId}`}`;
      const v = r._tag === "Fail" ? r.error : r.defect;
      if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
      if (typeof v === "object" && v !== null && "_tag" in v) {
        const msg = (v as { message?: unknown }).message;
        return `${String((v as { _tag: unknown })._tag)}${typeof msg === "string" && msg ? `: ${msg}` : ""}`;
      }
      return `Error: ${typeof v === "string" ? v : safeJson(v)}`;
    })
    .join("\n");
}
export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Thrown to propagate a typed failure. Not an Error: no stack capture, cheap to throw. */
export class Failure {
  readonly cause: Cause<unknown>;
  constructor(cause: Cause<unknown>) {
    this.cause = cause;
  }
}
export const toCause = (e: unknown): Cause<unknown> => (e instanceof Failure ? e.cause : causeDie(e));
export const toFailure = (e: unknown): Failure => (e instanceof Failure ? e : new Failure(causeDie(e)));
export const failWith = (cause: Cause<unknown>): never => {
  throw new Failure(cause);
};

// ---------- Effect ----------
export const EffectTypeId: unique symbol = Symbol.for("effect/Effect") as never;
export interface Variance<A, E, R> {
  readonly _A: (_: never) => A;
  readonly _E: (_: never) => E;
  readonly _R: (_: never) => R;
}
export interface Effect<out A, out E = never, out R = never> extends Pipeable {
  readonly [EffectTypeId]: Variance<A, E, R>;
  [Symbol.iterator](): EffectIterator<Effect<A, E, R>>;
}
export interface EffectIterator<T extends Effect<any, any, any>> {
  next(...args: ReadonlyArray<any>): IteratorResult<T, T extends Effect<infer A, any, any> ? A : never>;
}
/** Internal run hook name; every effect-like value (Eff, keys, Option, Exit, errors) implements it. */
export const RUN = "~run";
export type RunFn<A = unknown> = (f: Fiber) => Step<A> | Failure;

class SingleShot {
  private done = false;
  readonly self: unknown;
  constructor(self: unknown) {
    this.self = self;
  }
  next(v: unknown): IteratorResult<unknown> {
    if (this.done) return { value: v, done: true };
    this.done = true;
    return { value: this.self, done: false };
  }
  [Symbol.iterator]() {
    return this;
  }
}
const variance = { _A: (a: never) => a, _E: (a: never) => a, _R: (a: never) => a };
export const YieldableProto = {
  [EffectTypeId]: variance,
  [Symbol.iterator](this: unknown) {
    return new SingleShot(this);
  },
  ...PipeProto,
};

export class Eff<A = unknown, E = unknown, R = unknown> {
  declare readonly [EffectTypeId]: Variance<A, E, R>;
  readonly "~run": RunFn<A>;
  constructor(run: RunFn<A>) {
    this["~run"] = run;
  }
  [Symbol.iterator](): any {
    return new SingleShot(this);
  }
  pipe() {
    return pipeArgs(this, arguments);
  }
  toJSON() {
    return { _id: "Effect" };
  }
}
(Eff.prototype as any)[EffectTypeId] = variance;

export const make = <A, E = never, R = never>(run: RunFn<A>): Effect<A, E, R> =>
  new Eff(run) as unknown as Effect<A, E, R>;
export const isEffect = (u: unknown): u is Effect<unknown, unknown, unknown> =>
  typeof u === "object" && u !== null && EffectTypeId in u ||
  (typeof u === "function" && EffectTypeId in u);

// ---------- execution ----------
let depth = 0;
const MAX_DEPTH = 1200;

/** Run an effect on a fiber, throwing its failure. Bounces through a microtask when the JS stack gets deep. */
export function exec<A>(eff: Effect<A, any, any>, f: Fiber): Step<A> {
  if (f.interrupted && f.uninterruptible === 0) throw new Failure(causeInterrupt(f.interruptor));
  if (depth > MAX_DEPTH) return bounce(eff, f);
  depth++;
  try {
    const r = (eff as any)[RUN](f);
    if (r instanceof Failure) throw r;
    return r;
  } finally {
    depth--;
  }
}
/** `exec` that returns the failure (thrown or returned) as a `Failure` value instead of throwing. */
export function execF<A>(eff: Effect<A, any, any>, f: Fiber): Step<A> | Failure {
  if (f.interrupted && f.uninterruptible === 0) return new Failure(causeInterrupt(f.interruptor));
  if (depth > MAX_DEPTH) return bounce(eff, f);
  depth++;
  try {
    return (eff as any)[RUN](f);
  } catch (e) {
    return toFailure(e);
  } finally {
    depth--;
  }
}
function bounce<A>(eff: Effect<A, any, any>, f: Fiber): Async<A> {
  return new Async(
    Promise.resolve().then(() => {
      const saved = depth;
      depth = 0;
      try {
        return toThen(exec(eff, f));
      } finally {
        depth = saved;
      }
    }),
  ) as Async<A>;
}

// ---------- Context ----------
export const ServiceTypeId: unique symbol = Symbol.for("effect/Context/Service") as never;
export interface Key<out Id, out Shape> extends Effect<Shape, never, Id> {
  readonly [ServiceTypeId]: typeof ServiceTypeId;
  readonly key: string;
  readonly Service: Shape;
  readonly Identifier: Id;
}
export const ContextTypeId: unique symbol = Symbol.for("effect/Context") as never;
export interface Context<in Services> extends Pipeable {
  readonly [ContextTypeId]: { readonly _S: (_: Services) => void };
  readonly map: ReadonlyMap<string, any>;
}
const ContextProto = { [ContextTypeId]: { _S: () => {} }, ...PipeProto };
export function makeContext<S = never>(map: ReadonlyMap<string, any>): Context<S> {
  const c = Object.create(ContextProto);
  c.map = map;
  return c;
}
export const emptyContext: Context<any> = makeContext(new Map());
export const isContext = (u: unknown): u is Context<unknown> =>
  typeof u === "object" && u !== null && ContextTypeId in u;
export function contextAdd(ctx: Context<any>, key: string, value: unknown): Context<any> {
  const m = new Map(ctx.map);
  m.set(key, value);
  return makeContext(m);
}
export function contextMerge(a: Context<any>, b: Context<any>): Context<any> {
  if (a.map.size === 0) return b;
  if (b.map.size === 0) return a;
  const m = new Map(a.map);
  for (const [k, v] of b.map) m.set(k, v);
  return makeContext(m);
}
/** Default values for `Context.Reference` keys, keyed by string id. */
export const referenceDefaults = new Map<string, () => unknown>();
const referenceCache = new Map<string, unknown>();
export function referenceDefault(key: string): unknown {
  if (referenceCache.has(key)) return referenceCache.get(key);
  const mk = referenceDefaults.get(key);
  if (!mk) return undefined;
  const v = mk();
  referenceCache.set(key, v);
  return v;
}
export function lookup(ctx: Context<any>, key: string): unknown {
  const v = ctx.map.get(key);
  if (v !== undefined || ctx.map.has(key)) return v;
  return referenceDefault(key);
}
export function hasService(ctx: Context<any>, key: string): boolean {
  return ctx.map.has(key) || referenceDefaults.has(key);
}
export function serviceNotFound(key: string): never {
  throw new Failure(causeDie(new Error(`Service not found: ${key}`)));
}

// ---------- Fiber ----------
export type Exit<A, E> = ExitSuccess<A, E> | ExitFailure<A, E>;
export const ExitTypeId: unique symbol = Symbol.for("effect/Exit") as never;
export interface ExitSuccess<out A, out E = never> extends Effect<A, E> {
  readonly [ExitTypeId]: typeof ExitTypeId;
  readonly _tag: "Success";
  readonly value: A;
}
export interface ExitFailure<out A, out E> extends Effect<A, E> {
  readonly [ExitTypeId]: typeof ExitTypeId;
  readonly _tag: "Failure";
  readonly cause: Cause<E>;
}
const ExitProto = {
  ...YieldableProto,
  [ExitTypeId]: ExitTypeId,
  [RUN](this: Exit<unknown, unknown>) {
    return this._tag === "Success" ? this.value : new Failure(this.cause);
  },
  [EqualSymbol](this: Exit<unknown, unknown>, that: unknown) {
    return (
      isExit(that) &&
      that._tag === this._tag &&
      (this._tag === "Success"
        ? equals(this.value, (that as ExitSuccess<unknown>).value)
        : equals(this.cause, (that as ExitFailure<unknown, unknown>).cause))
    );
  },
  [HashSymbol](this: Exit<unknown, unknown>) {
    return this._tag === "Success" ? hash(this.value) : 1;
  },
  toJSON(this: Exit<unknown, unknown>) {
    return this._tag === "Success"
      ? { _id: "Exit", _tag: "Success", value: this.value }
      : { _id: "Exit", _tag: "Failure", cause: (this.cause as any).toJSON() };
  },
};
export const isExit = (u: unknown): u is Exit<unknown, unknown> =>
  typeof u === "object" && u !== null && ExitTypeId in u;
export function exitSucceed<A>(value: A): Exit<A, never> {
  const e = Object.create(ExitProto);
  e._tag = "Success";
  e.value = value;
  return e;
}
export function exitFailCause<E>(cause: Cause<E>): Exit<never, E> {
  const e = Object.create(ExitProto);
  e._tag = "Failure";
  e.cause = cause;
  return e;
}
export const exitVoid: Exit<void, never> = exitSucceed(undefined);

export const FiberTypeId: unique symbol = Symbol.for("effect/Fiber") as never;
let fiberIds = 0;
export let currentFiber: Fiber | undefined;

export class Fiber<A = any, E = any> {
  declare readonly [FiberTypeId]: typeof FiberTypeId;
  readonly id = ++fiberIds;
  context: Context<any>;
  interrupted = false;
  interruptor: number | undefined = undefined;
  uninterruptible = 0;
  exit: Exit<A, E> | undefined = undefined;
  children: Set<Fiber<any, any>> | undefined = undefined;
  parent: Fiber<any, any> | undefined = undefined;
  span: unknown = undefined;
  /** An array, not a Set: a waiting fiber usually has one listener, added and removed per wait. */
  private interruptListeners: Array<() => void> | undefined = undefined;
  private observers: Array<(exit: Exit<any, any>) => void> | undefined = undefined;
  constructor(context: Context<any>) {
    this.context = context;
  }
  get currentSpan() {
    return this.span;
  }
  getRef<T>(ref: { readonly key: string }): T {
    return lookup(this.context, ref.key) as T;
  }
  setContext(context: Context<any>): void {
    this.context = context;
  }
  interruptUnsafe(fiberId?: number): void {
    this.interruptAsFork(fiberId);
  }
  pollUnsafe(): Exit<A, E> | undefined {
    return this.exit;
  }
  /** Register a wake-up for interruptible waits; returns unregister. */
  onInterrupt(cb: () => void): () => void {
    if (this.uninterruptible > 0) return noop;
    (this.interruptListeners ??= []).push(cb);
    return () => this.offInterrupt(cb);
  }
  offInterrupt(cb: () => void): void {
    const ls = this.interruptListeners;
    const i = ls ? ls.lastIndexOf(cb) : -1;
    if (i < 0) return;
    if (i === ls!.length - 1) ls!.pop();
    else ls!.splice(i, 1);
  }
  interruptAsFork(by: number | undefined): void {
    if (this.exit || this.interrupted) return;
    this.interrupted = true;
    this.interruptor = by;
    const ls = this.interruptListeners;
    if (this.uninterruptible > 0 || !ls) return;
    this.interruptListeners = undefined;
    for (const l of ls) l();
  }
  addObserver(cb: (exit: Exit<A, E>) => void): () => void {
    if (this.exit) {
      cb(this.exit);
      return noop;
    }
    (this.observers ??= []).push(cb);
    return () => {
      const i = this.observers?.indexOf(cb) ?? -1;
      if (i >= 0) this.observers!.splice(i, 1);
    };
  }
  /** Awaitable exit as a Step. */
  awaitStep(waiter: Fiber | undefined): Step<Exit<A, E>> {
    if (this.exit) return this.exit;
    return new Async(
      new Promise<Exit<A, E>>((resolve, reject) => {
        let un = noop;
        const off = this.addObserver((e) => {
          un();
          resolve(e);
        });
        if (waiter)
          un = waiter.onInterrupt(() => {
            off();
            reject(new Failure(causeInterrupt(waiter.interruptor)));
          });
      }),
    );
  }
  complete(exit: Exit<A, E>): void {
    if (this.exit) return;
    this.exit = exit;
    this.parent?.children?.delete(this);
    const obs = this.observers;
    this.observers = undefined;
    if (obs) for (const o of obs) o(exit);
  }
  pipe() {
    return pipeArgs(this, arguments);
  }
}
(Fiber.prototype as any)[FiberTypeId] = FiberTypeId;
export const noop = () => {};

/** Interrupt all children, waiting for them to finish. */
function interruptChildren(f: Fiber): Step<void> {
  if (!f.children || f.children.size === 0) return undefined;
  const kids = [...f.children];
  let pending: Array<Promise<unknown>> | undefined;
  for (const k of kids) {
    k.interruptAsFork(f.id);
    const r = k.awaitStep(undefined);
    if (r instanceof Async) (pending ??= []).push(r.p);
  }
  return pending ? (new Async(Promise.all(pending).then(noop)) as Async<void>) : undefined;
}

function finishFiber<A, E>(f: Fiber<A, E>, exit: Exit<A, E>): void {
  const r = interruptChildren(f);
  if (r instanceof Async) r.p.then(() => f.complete(exit));
  else f.complete(exit);
}
/** Start a fiber running `eff`. Runs synchronously until the first async boundary; only fibers that suspend are registered as children. */
export function runFiber<A, E>(
  eff: Effect<A, E, any>,
  context: Context<any>,
  parent?: Fiber,
  opts?: { uninterruptible?: boolean | undefined; inheritFrom?: Fiber | undefined },
): Fiber<A, E> {
  const f = new Fiber<A, E>(context);
  if (opts) {
    if (opts.inheritFrom) f.span = opts.inheritFrom.span;
    if (opts.uninterruptible) f.uninterruptible = 1;
  }
  if (parent) {
    f.parent = parent;
    f.span ??= parent.span;
  }
  const prev = currentFiber;
  currentFiber = f;
  const r = execF(eff, f);
  currentFiber = prev;
  if (r instanceof Failure) finishFiber(f, exitFailCause(r.cause) as Exit<A, E>);
  else if (r instanceof Async) {
    if (parent) (parent.children ??= new Set()).add(f);
    r.p.then(
      (v) => finishFiber(f, exitSucceed(unbox(v)) as Exit<A, E>),
      (e) => finishFiber(f, exitFailCause(toCause(e)) as Exit<A, E>),
    );
  } else finishFiber(f, exitSucceed(r) as Exit<A, E>);
  return f;
}

/** Wait for an async result while honoring interruption of `f`. */
export function interruptibleWait<A>(
  f: Fiber,
  register: (resolve: (a: A) => void, reject: (e: unknown) => void) => (() => void) | void,
): Async<A> {
  return new Async(
    new Promise<A>((resolve, reject) => {
      let cleanup: (() => void) | void;
      const un = f.onInterrupt(() => {
        if (cleanup) cleanup();
        reject(new Failure(causeInterrupt(f.interruptor)));
      });
      cleanup = register(
        (a) => {
          un();
          resolve(box(a) as A);
        },
        (e) => {
          un();
          reject(e);
        },
      );
    }),
  );
}
