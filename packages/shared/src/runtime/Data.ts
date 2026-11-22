import { StructuralProto } from "./internal.ts";
import { TaggedError as TE, YieldableError } from "./errors.ts";

/** Classes with structural equality: `class P extends Data.Class<{ x: number }> {}` */
export const Class: new <A extends Record<string, any> = {}>(args: {} extends A ? void | Readonly<A> : Readonly<A>) => Readonly<A> = (function () {
  function Base(this: any, args?: object) {
    if (args) Object.assign(this, args);
  }
  Object.assign(Base.prototype, StructuralProto);
  return Base;
})() as never;
export const TaggedClass = <Tag extends string>(tag: Tag): new <A extends Record<string, any> = {}>(args: {} extends A ? void | Readonly<A> : Readonly<A>) => Readonly<A> & { readonly _tag: Tag } =>
  class extends (Class as any) {
    readonly _tag = tag;
  } as never;
export const struct = <A extends Record<string, any>>(a: A): Readonly<A> => Object.assign(Object.create(StructuralProto), a);
export const tuple = <A extends ReadonlyArray<any>>(...as: A): Readonly<A> => Object.assign(Object.create(Object.assign([], StructuralProto)), as) as never;
export const array = <A extends ReadonlyArray<any>>(as: A): Readonly<A> => tuple(...as) as never;
export const tagged = <A extends { _tag: string }>(tag: A["_tag"]) => (args: Omit<A, "_tag">): A => struct({ ...args, _tag: tag } as A);
export const Error = YieldableError as new <A extends Record<string, any> = {}>(args: {} extends A ? void | Readonly<A> : Readonly<A>) => YieldableError & Readonly<A>;
export const TaggedError = TE;

export type TaggedEnum<A extends Record<string, Record<string, any>>> = {
  readonly [K in keyof A]: Readonly<A[K]> & { readonly _tag: K };
}[keyof A];
export declare namespace TaggedEnum {
  type Constructor<A extends { _tag: string }> = {
    readonly [K in A["_tag"]]: (args: Omit<Extract<A, { _tag: K }>, "_tag">) => Extract<A, { _tag: K }>;
  } & {
    readonly $is: <K extends A["_tag"]>(tag: K) => (u: unknown) => u is Extract<A, { _tag: K }>;
    readonly $match: <Cases extends { [K in A["_tag"]]: (a: Extract<A, { _tag: K }>) => any }>(cases: Cases) => (a: A) => ReturnType<Cases[A["_tag"]]>;
  };
}
/** Proxy constructor object: `const T = Data.taggedEnum<T>(); T.Foo({...})`. */
export const taggedEnum = <A extends { _tag: string }>(): TaggedEnum.Constructor<A> =>
  new Proxy({} as TaggedEnum.Constructor<A>, {
    get(_, key) {
      if (key === "$is") return (tag: string) => (u: unknown) => typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === tag;
      if (key === "$match") return (cases: Record<string, (a: any) => any>) => (a: A) => cases[a._tag]!(a);
      return (args: object) => struct({ ...args, _tag: key });
    },
  });
