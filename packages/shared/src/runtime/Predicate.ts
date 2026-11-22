export type Predicate<in A> = (a: A) => boolean;
export type Refinement<in A, out B extends A> = (a: A) => a is B;
export const isString = (u: unknown): u is string => typeof u === "string";
export const isNumber = (u: unknown): u is number => typeof u === "number";
export const isBoolean = (u: unknown): u is boolean => typeof u === "boolean";
export const isBigInt = (u: unknown): u is bigint => typeof u === "bigint";
export const isSymbol = (u: unknown): u is symbol => typeof u === "symbol";
export const isFunction = (u: unknown): u is Function => typeof u === "function";
export const isUndefined = (u: unknown): u is undefined => u === undefined;
export const isNull = (u: unknown): u is null => u === null;
export const isNotUndefined = <A>(a: A): a is Exclude<A, undefined> => a !== undefined;
export const isNotNull = <A>(a: A): a is Exclude<A, null> => a !== null;
export const isNullish = (u: unknown): u is null | undefined => u == null;
export const isNotNullish = <A>(a: A): a is NonNullable<A> => a != null;
export const isUnknown = (_: unknown): _ is unknown => true;
export const isNever = (_: unknown): _ is never => false;
/** Objects and functions (not null). */
export const isObject = (u: unknown): u is object => (typeof u === "object" && u !== null) || typeof u === "function";
export const isObjectKeyword = isObject;
export const isReadonlyObject = (u: unknown): u is { readonly [x: PropertyKey]: unknown } => typeof u === "object" && u !== null;
export const isRecord = (u: unknown): u is { [x: string | symbol]: unknown } => typeof u === "object" && u !== null && !Array.isArray(u);
export const isReadonlyRecord = isRecord as (u: unknown) => u is { readonly [x: string | symbol]: unknown };
export const isIterable = (u: unknown): u is Iterable<unknown> => isObject(u) && Symbol.iterator in u;
export const isPromise = (u: unknown): u is Promise<unknown> => u instanceof Promise;
export const isPromiseLike = (u: unknown): u is PromiseLike<unknown> => isObject(u) && typeof (u as { then?: unknown }).then === "function";
export const isDate = (u: unknown): u is Date => u instanceof Date;
export const isRegExp = (u: unknown): u is RegExp => u instanceof RegExp;
export const isError = (u: unknown): u is Error => u instanceof Error;
export const isUint8Array = (u: unknown): u is Uint8Array => u instanceof Uint8Array;
export const isMap = (u: unknown): u is Map<unknown, unknown> => u instanceof Map;
export const isSet = (u: unknown): u is Set<unknown> => u instanceof Set;
export const isTruthy = (u: unknown): boolean => !!u;
export const hasProperty: {
  <P extends PropertyKey>(property: P): (self: unknown) => self is { [K in P]: unknown };
  <P extends PropertyKey>(self: unknown, property: P): self is { [K in P]: unknown };
} = function (this: unknown): any {
  if (arguments.length === 1) {
    const p = arguments[0];
    return (self: unknown) => isObject(self) && p in self;
  }
  return isObject(arguments[0]) && arguments[1] in arguments[0];
} as never;
export const isTagged: {
  <K extends string>(tag: K): (self: unknown) => self is { _tag: K };
  <K extends string>(self: unknown, tag: K): self is { _tag: K };
} = function (this: unknown): any {
  if (arguments.length === 1) {
    const t = arguments[0];
    return (self: unknown) => isObject(self) && (self as { _tag?: unknown })._tag === t;
  }
  return isObject(arguments[0]) && (arguments[0] as { _tag?: unknown })._tag === arguments[1];
} as never;
export const not = <A>(p: Predicate<A>): Predicate<A> => (a) => !p(a);
export const and = <A>(a: Predicate<A>, b: Predicate<A>): Predicate<A> => (x) => a(x) && b(x);
export const or = <A>(a: Predicate<A>, b: Predicate<A>): Predicate<A> => (x) => a(x) || b(x);
export const compose: {
  <A, B extends A, C extends B>(bc: Refinement<B, C>): (ab: Refinement<A, B>) => Refinement<A, C>;
  <A, B extends A, C extends B>(ab: Refinement<A, B>, bc: Refinement<B, C>): Refinement<A, C>;
} = function (this: unknown): any {
  if (arguments.length === 1) {
    const bc = arguments[0];
    return (ab: Function) => (a: unknown) => ab(a) && bc(a);
  }
  const [ab, bc] = arguments;
  return (a: unknown) => ab(a) && bc(a);
} as never;
export const mapInput = <A, B>(p: Predicate<A>, f: (b: B) => A): Predicate<B> => (b) => p(f(b));
export const every = <A>(ps: Iterable<Predicate<A>>): Predicate<A> => (a) => [...ps].every((p) => p(a));
export const some = <A>(ps: Iterable<Predicate<A>>): Predicate<A> => (a) => [...ps].some((p) => p(a));
