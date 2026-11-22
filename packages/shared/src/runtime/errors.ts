import { causeFail, EffectTypeId, EqualSymbol, Failure, HashSymbol, pipeArgs, RUN, structuralEquals, structuralHash, type Effect, type EffectIterator, type Pipeable, type Variance } from "./internal.ts";

/** One immutable Failure per error instance, kept off the object so it never shows in spreads or JSON. */
const failures = new WeakMap<object, Failure>();
/** An Error that is also an Effect failing with itself: `yield* new MyError()`. */
/** Fails with the concrete subclass (`this`), so `yield* new MyError()` is typed `Effect<never, MyError>`. */
export interface YieldableError extends Error, Pipeable {
  readonly [EffectTypeId]: Variance<never, this, never>;
  [Symbol.iterator](): EffectIterator<Effect<never, this, never>>;
}
export const YieldableError: new (message?: string, options?: ErrorOptions) => YieldableError = class extends Error {
  [RUN]() {
    let f = failures.get(this);
    if (!f) failures.set(this, (f = new Failure(causeFail(this))));
    return f;
  }
  [Symbol.iterator]() {
    let done = false;
    const self = this;
    return { next: (v: unknown) => (done ? { value: v, done: true } : ((done = true), { value: self, done: false })), [Symbol.iterator]() { return this; } };
  }
  pipe() {
    return pipeArgs(this, arguments);
  }
  [EqualSymbol](that: unknown) {
    return this === that || (typeof that === "object" && that !== null && structuralEquals(this, that));
  }
  [HashSymbol]() {
    return structuralHash(this);
  }
  toJSON() {
    return { ...this, message: this.message || undefined };
  }
} as never;
(YieldableError.prototype as any)[EffectTypeId] = { _A: (a: never) => a, _E: (a: never) => a, _R: (a: never) => a };

/** `class E extends TaggedError("E")<{ a: string }> {}` */
export const TaggedError = <Tag extends string>(tag: Tag) => {
  class Base extends YieldableError {
    readonly _tag = tag;
    constructor(args?: Record<string, unknown>) {
      super(typeof args?.message === "string" ? args.message : undefined, args && "cause" in args ? { cause: args.cause } : undefined);
      if (args) Object.assign(this, args);
      this.name = tag;
    }
  }
  return Base as unknown as new <A extends Record<string, any> = {}>(
    args: {} extends A ? void | { readonly [K in keyof A]: A[K] } : { readonly [K in keyof A]: A[K] },
  ) => YieldableError & { readonly _tag: Tag } & Readonly<A>;
};

export class NoSuchElementError extends TaggedError("NoSuchElementError")<{ message?: string }> {
  constructor(message?: string) {
    super(message === undefined ? undefined : { message } as never);
  }
}
export class TimeoutError extends TaggedError("TimeoutError")<{ message?: string }> {
  constructor(message?: string) {
    super(message === undefined ? undefined : { message } as never);
  }
}
export class IllegalArgumentError extends TaggedError("IllegalArgumentError")<{ message?: string }> {
  constructor(message?: string) {
    super(message === undefined ? undefined : { message } as never);
  }
}
export class ExceededCapacityError extends TaggedError("ExceededCapacityError")<{ message?: string }> {
  constructor(message?: string) {
    super(message === undefined ? undefined : { message } as never);
  }
}
export class UnknownError extends TaggedError("UnknownError")<{ message?: string; cause: unknown }> {
  constructor(cause: unknown, message?: string) {
    super({ cause, message } as never);
  }
}

export const DoneTypeId: unique symbol = Symbol.for("effect/Cause/Done") as never;
export interface Done<A = void> {
  readonly [DoneTypeId]: typeof DoneTypeId;
  readonly _tag: "Done";
  readonly value: A;
}
const doneVoid: Done<void> = { [DoneTypeId]: DoneTypeId, _tag: "Done", value: undefined };
export const Done = <A = void>(value?: A): Done<A> =>
  value === undefined ? (doneVoid as Done<A>) : { [DoneTypeId]: DoneTypeId, _tag: "Done", value: value as A };
export const isDone = (u: unknown): u is Done<unknown> => typeof u === "object" && u !== null && DoneTypeId in u;
