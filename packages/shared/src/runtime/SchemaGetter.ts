import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as Iss from "./SchemaIssue.ts";
import { makeGetter, OMIT_KEY, runEffectInDecode, type SchemaGetterLike } from "./Schema.ts";

export type Getter<T, E, R = never> = SchemaGetterLike<T, E, R>;
export const transform = <T, E>(f: (e: E) => T): Getter<T, E> => makeGetter((v: E) => f(v));
export const transformEffect = <T, E, R = never>(f: (e: E) => I.Effect<T, Iss.Issue, R>): Getter<T, E, R> => makeGetter((v: E, ctx) => runEffectInDecode(f(v), ctx, v));
export const transformOrFail = transformEffect;
/** Runs for present values and for missing keys; returning None omits the key. */
export const transformOptional = <T, E>(f: (o: O.Option<E>) => O.Option<T>): Getter<T, E> =>
  makeGetter((v: E) => {
    const r = f(O.some(v));
    return r._tag === "Some" ? r.value : (OMIT_KEY as never);
  }, () => f(O.none()));
export const succeed = <T>(value: T): Getter<T, any> => makeGetter(() => value);
export const passthrough = <T>(): Getter<T, T> => makeGetter((v: T) => v);
export const forbidden = <T = never, E = unknown>(message: string | ((e: E) => string)): Getter<T, E> =>
  makeGetter((v: E) => {
    throw new Iss.Forbidden({ message: typeof message === "function" ? message(v) : message }, v);
  });
export const fail = <T = never, E = unknown>(f: (e: E) => Iss.Issue): Getter<T, E> =>
  makeGetter((v: E) => {
    throw f(v);
  });
export const parseJson = <T = unknown>(): Getter<T, string> =>
  makeGetter((s: string) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new Iss.InvalidValue({ message: (e as Error).message }, s);
    }
  });
export const stringifyJson = (): Getter<string, unknown> => makeGetter((v: unknown) => JSON.stringify(v));
export const compose = <T, M, E>(first: Getter<M, E, any>, second: Getter<T, M, any>): Getter<T, E> =>
  makeGetter((v: E, ctx) => I.chain(first["~getter"](v, ctx), (m) => second["~getter"](m, ctx)));
export const String = <E>(): Getter<string, E> => makeGetter((v: E) => globalThis.String(v));
export const Number = <E>(): Getter<number, E> => makeGetter((v: E) => globalThis.Number(v));
export const trim = (): Getter<string, string> => makeGetter((s: string) => s.trim());
export const toLowerCase = (): Getter<string, string> => makeGetter((s: string) => s.toLowerCase());
export const toUpperCase = (): Getter<string, string> => makeGetter((s: string) => s.toUpperCase());
