import * as O from "../Option.ts";
import * as Ctx from "../Context.ts";

/** Lower-cased header record. */
export type Headers = { readonly [name: string]: string };
export type Input = Readonly<Record<string, string | ReadonlyArray<string> | undefined>> | Iterable<readonly [string, string]>;
export const empty: Headers = Object.freeze({});
export const fromInput = (input?: Input): Headers => {
  if (!input) return empty;
  const out: Record<string, string> = {};
  const entries = Symbol.iterator in (input as object) ? (input as Iterable<readonly [string, string]>) : Object.entries(input as Record<string, string | ReadonlyArray<string> | undefined>);
  for (const [k, v] of entries) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v as string);
  return out;
};
export const set: { (key: string, value: string): (self: Headers) => Headers; (self: Headers, key: string, value: string): Headers } = function (a: any, b: any, c?: any): any {
  if (typeof a === "string") return (self: Headers) => ({ ...self, [a.toLowerCase()]: b });
  return { ...a, [b.toLowerCase()]: c };
} as never;
export const setAll: { (input: Input): (self: Headers) => Headers; (self: Headers, input: Input): Headers } = function (a: any, b?: any): any {
  if (b === undefined) return (self: Headers) => ({ ...self, ...fromInput(a) });
  return { ...a, ...fromInput(b) };
} as never;
export const remove: { (key: string): (self: Headers) => Headers; (self: Headers, key: string): Headers } = function (a: any, b?: any): any {
  const rm = (self: Headers, k: string) => {
    const { [k.toLowerCase()]: _, ...rest } = self;
    return rest;
  };
  return b === undefined ? (self: Headers) => rm(self, a) : rm(a, b);
} as never;
export const get: { (key: string): (self: Headers) => O.Option<string>; (self: Headers, key: string): O.Option<string> } = function (a: any, b?: any): any {
  return b === undefined ? (self: Headers) => O.fromUndefinedOr(self[a.toLowerCase()]) : O.fromUndefinedOr(a[b.toLowerCase()]);
} as never;
export const has = (self: Headers, key: string) => key.toLowerCase() in self;
export const CurrentRedactedNames = Ctx.Reference<ReadonlyArray<string | RegExp>>("effect/http/Headers/CurrentRedactedNames", {
  defaultValue: () => ["authorization", "cookie", "set-cookie", "x-api-key"],
});
export const redact = (self: Headers, names: ReadonlyArray<string | RegExp>): Record<string, string> =>
  Object.fromEntries(Object.entries(self).map(([k, v]) => [k, names.some((n) => (typeof n === "string" ? n === k : n.test(k))) ? "<redacted>" : v]));
