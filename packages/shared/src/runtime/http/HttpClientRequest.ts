import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as Headers from "./Headers.ts";
import * as Red from "../Redacted.ts";
import type * as Stream from "../Stream.ts";

export const TypeId: unique symbol = Symbol.for("effect/http/HttpClientRequest") as never;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "QUERY";
export type HttpBody =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Uint8Array"; readonly body: Uint8Array; readonly contentType: string }
  | { readonly _tag: "Raw"; readonly body: unknown; readonly contentType?: string }
  | { readonly _tag: "FormData"; readonly formData: FormData }
  | { readonly _tag: "Stream"; readonly stream: Stream.Stream<Uint8Array, unknown>; readonly contentType: string };
export type UrlParams = ReadonlyArray<readonly [string, string]>;
export interface HttpClientRequest extends I.Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly method: HttpMethod;
  readonly url: string;
  readonly urlParams: UrlParams;
  readonly hash: O.Option<string>;
  readonly headers: Headers.Headers;
  readonly body: HttpBody;
}
export declare namespace Options {
  interface NoUrl {
    readonly headers?: Headers.Input;
    readonly urlParams?: Readonly<Record<string, string | number | boolean | undefined | ReadonlyArray<string>>> | UrlParams;
    readonly body?: HttpBody;
    readonly accept?: string;
    readonly acceptJson?: boolean;
    readonly hash?: string;
  }
}
const proto = { [TypeId]: TypeId, ...I.PipeProto };
const empty: HttpBody = { _tag: "Empty" };
const mk = (o: Omit<HttpClientRequest, typeof TypeId | "pipe">): HttpClientRequest => Object.assign(Object.create(proto), o);
const toParams = (p: Options.NoUrl["urlParams"]): UrlParams =>
  !p ? [] : Array.isArray(p) ? (p as UrlParams) : Object.entries(p).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, String(x)] as const) : [[k, String(v)] as const]));
export const make = (method: HttpMethod) => (url: string | URL, options?: Options.NoUrl): HttpClientRequest => {
  let headers = Headers.fromInput(options?.headers);
  if (options?.accept) headers = Headers.set(headers, "accept", options.accept);
  if (options?.acceptJson) headers = Headers.set(headers, "accept", "application/json");
  return mk({ method, url: url.toString(), urlParams: toParams(options?.urlParams), hash: O.fromUndefinedOr(options?.hash), headers, body: options?.body ?? empty });
};
export const get = make("GET");
export const post = make("POST");
export const put = make("PUT");
export const patch = make("PATCH");
export const del = make("DELETE");
export const head = make("HEAD");
export const options = make("OPTIONS");
const upd = (f: (r: HttpClientRequest) => Partial<HttpClientRequest>) => (r: HttpClientRequest): HttpClientRequest => mk({ ...r, ...f(r) });
type Upd<Args extends Array<any>> = { (...args: Args): (self: HttpClientRequest) => HttpClientRequest; (self: HttpClientRequest, ...args: Args): HttpClientRequest };
const dualUpd = <Args extends Array<any>>(n: number, f: (r: HttpClientRequest, ...args: Args) => Partial<HttpClientRequest>): Upd<Args> =>
  I.dual(n + 1, (r: HttpClientRequest, ...args: Args) => upd((x) => f(x, ...args))(r));
export const setHeader: Upd<[key: string, value: string]> = dualUpd(2, (r, k: string, v: string) => ({ headers: Headers.set(r.headers, k, v) }));
export const setHeaders: Upd<[input: Headers.Input]> = dualUpd(1, (r, h: Headers.Input) => ({ headers: Headers.setAll(r.headers, h) }));
export const bearerToken: Upd<[token: string | Red.Redacted<string>]> = dualUpd(1, (r, t: string | Red.Redacted<string>) => ({ headers: Headers.set(r.headers, "authorization", `Bearer ${Red.isRedacted(t) ? Red.value(t) : t}`) }));
export const basicAuth: Upd<[user: string, password: string]> = dualUpd(2, (r, u: string, p: string) => ({ headers: Headers.set(r.headers, "authorization", `Basic ${btoa(`${u}:${p}`)}`) }));
export const accept: Upd<[mediaType: string]> = dualUpd(1, (r, m: string) => ({ headers: Headers.set(r.headers, "accept", m) }));
export const acceptJson = accept("application/json");
export const setMethod: Upd<[method: HttpMethod]> = dualUpd(1, (_, method: HttpMethod) => ({ method }));
export const setUrl: Upd<[url: string | URL]> = dualUpd(1, (_, url: string | URL) => ({ url: url.toString() }));
export const prependUrl: Upd<[prefix: string]> = dualUpd(1, (r, p: string) => ({ url: p.endsWith("/") && r.url.startsWith("/") ? p + r.url.slice(1) : p + r.url }));
export const appendUrl: Upd<[suffix: string]> = dualUpd(1, (r, s: string) => ({ url: r.url + s }));
export const setUrlParam: Upd<[key: string, value: string]> = dualUpd(2, (r, k: string, v: string) => ({ urlParams: [...r.urlParams.filter(([x]) => x !== k), [k, v]] }));
export const setUrlParams: Upd<[params: Options.NoUrl["urlParams"]]> = dualUpd(1, (r, p: Options.NoUrl["urlParams"]) => ({ urlParams: [...r.urlParams, ...toParams(p)] }));
export const appendUrlParam = setUrlParam;
export const setBody: Upd<[body: HttpBody]> = dualUpd(1, (r, body: HttpBody) => ({ body, headers: "contentType" in body && body.contentType ? Headers.set(r.headers, "content-type", body.contentType) : r.headers }));
const enc = new TextEncoder();
export const bodyText: Upd<[text: string, contentType?: string]> = I.dual((args) => typeof args[0] === "object" && TypeId in args[0], (r: HttpClientRequest, text: string, ct = "text/plain") =>
  setBody(r, { _tag: "Uint8Array", body: enc.encode(text), contentType: ct }));
export const bodyUint8Array: Upd<[body: Uint8Array, contentType?: string]> = I.dual((args) => typeof args[0] === "object" && TypeId in args[0], (r: HttpClientRequest, body: Uint8Array, ct = "application/octet-stream") =>
  setBody(r, { _tag: "Uint8Array", body, contentType: ct }));
export const bodyJsonUnsafe: Upd<[body: unknown]> = dualUpd(1, (r, b: unknown) => setBody(r, { _tag: "Uint8Array", body: enc.encode(JSON.stringify(b)), contentType: "application/json" }));
export const bodyJson = (body: unknown) => (r: HttpClientRequest): I.Effect<HttpClientRequest> => I.make(() => bodyJsonUnsafe(r, body));
export const bodyUrlParams: Upd<[params: Options.NoUrl["urlParams"]]> = dualUpd(1, (r, p: Options.NoUrl["urlParams"]) =>
  setBody(r, { _tag: "Uint8Array", body: enc.encode(new URLSearchParams(toParams(p) as Array<[string, string]>).toString()), contentType: "application/x-www-form-urlencoded" }));
export const bodyFormData: Upd<[data: FormData]> = dualUpd(1, (r, formData: FormData) => setBody(r, { _tag: "FormData", formData }));
export const bodyStream: Upd<[stream: Stream.Stream<Uint8Array, unknown>, contentType?: string]> = I.dual((args) => typeof args[0] === "object" && TypeId in args[0], (r: HttpClientRequest, stream: Stream.Stream<Uint8Array, unknown>, ct = "application/octet-stream") =>
  setBody(r, { _tag: "Stream", stream, contentType: ct }));
export const toUrl = (r: HttpClientRequest): O.Option<URL> => {
  try {
    const u = new URL(r.url);
    for (const [k, v] of r.urlParams) u.searchParams.append(k, v);
    if (r.hash._tag === "Some") u.hash = r.hash.value;
    return O.some(u);
  } catch {
    return O.none();
  }
};
export const isHttpClientRequest = (u: unknown): u is HttpClientRequest => typeof u === "object" && u !== null && TypeId in u;
