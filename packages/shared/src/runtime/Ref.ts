import * as I from "./internal.ts";

export const TypeId: unique symbol = Symbol.for("effect/Ref") as never;
export class Ref<in out A> implements I.Pipeable {
  readonly [TypeId]: typeof TypeId = TypeId;
  value: A;
  constructor(value: A) {
    this.value = value;
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const isRef = (u: unknown): u is Ref<unknown> => u instanceof Ref;
export const makeUnsafe = <A>(value: A): Ref<A> => new Ref(value);
export const make = <A>(value: A): I.Effect<Ref<A>> => I.make(() => new Ref(value));
export const getUnsafe = <A>(self: Ref<A>): A => self.value;
export const get = <A>(self: Ref<A>): I.Effect<A> => I.make(() => self.value);
export const set: { <A>(value: A): (self: Ref<A>) => I.Effect<void>; <A>(self: Ref<A>, value: A): I.Effect<void> } =
  I.dual(2, (self: Ref<any>, v: unknown) => I.make(() => void (self.value = v)));
export const getAndSet: { <A>(value: A): (self: Ref<A>) => I.Effect<A>; <A>(self: Ref<A>, value: A): I.Effect<A> } =
  I.dual(2, (self: Ref<any>, v: unknown) => I.make(() => {
    const old = self.value;
    self.value = v;
    return old;
  }));
export const setAndGet: { <A>(value: A): (self: Ref<A>) => I.Effect<A>; <A>(self: Ref<A>, value: A): I.Effect<A> } =
  I.dual(2, (self: Ref<any>, v: unknown) => I.make(() => (self.value = v)));
export const update: { <A>(f: (a: A) => A): (self: Ref<A>) => I.Effect<void>; <A>(self: Ref<A>, f: (a: A) => A): I.Effect<void> } =
  I.dual(2, (self: Ref<any>, f: (a: any) => any) => I.make(() => void (self.value = f(self.value))));
export const updateAndGet: { <A>(f: (a: A) => A): (self: Ref<A>) => I.Effect<A>; <A>(self: Ref<A>, f: (a: A) => A): I.Effect<A> } =
  I.dual(2, (self: Ref<any>, f: (a: any) => any) => I.make(() => (self.value = f(self.value))));
export const getAndUpdate: { <A>(f: (a: A) => A): (self: Ref<A>) => I.Effect<A>; <A>(self: Ref<A>, f: (a: A) => A): I.Effect<A> } =
  I.dual(2, (self: Ref<any>, f: (a: any) => any) => I.make(() => {
    const old = self.value;
    self.value = f(old);
    return old;
  }));
export const modify: {
  <A, B>(f: (a: A) => readonly [B, A]): (self: Ref<A>) => I.Effect<B>;
  <A, B>(self: Ref<A>, f: (a: A) => readonly [B, A]): I.Effect<B>;
} = I.dual(2, (self: Ref<any>, f: (a: any) => readonly [any, any]) => I.make(() => {
  const [b, a] = f(self.value);
  self.value = a;
  return b;
}));
export const updateSome: { <A>(f: (a: A) => import("./Option.ts").Option<A>): (self: Ref<A>) => I.Effect<void>; <A>(self: Ref<A>, f: (a: A) => import("./Option.ts").Option<A>): I.Effect<void> } =
  I.dual(2, (self: Ref<any>, f: (a: any) => any) => I.make(() => {
    const o = f(self.value);
    if (o._tag === "Some") self.value = o.value;
  }));
