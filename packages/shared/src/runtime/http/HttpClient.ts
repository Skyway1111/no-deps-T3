import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as D from "../Duration.ts";
import * as Effect from "../Effect.ts";
import * as Req from "./HttpClientRequest.ts";
import * as Res from "./HttpClientResponse.ts";
import { HttpClientError, InvalidUrlError } from "./HttpClientError.ts";
import type * as Sched from "../Schedule.ts";

export const TypeId: unique symbol = Symbol.for("effect/http/HttpClient") as never;
type Exec<E, R> = (request: Req.HttpClientRequest) => I.Effect<Res.HttpClientResponse, E, R>;
type Method<E, R> = (url: string | URL, options?: Req.Options.NoUrl) => I.Effect<Res.HttpClientResponse, E, R>;
export interface With<E, R = never> extends I.Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly execute: Exec<E, R>;
  readonly get: Method<E, R>;
  readonly query: Method<E, R>;
  readonly head: Method<E, R>;
  readonly post: Method<E, R>;
  readonly patch: Method<E, R>;
  readonly put: Method<E, R>;
  readonly del: Method<E, R>;
  readonly options: Method<E, R>;
}
export interface HttpClient extends With<HttpClientError> {}
export declare namespace HttpClient {
  type With<E, R = never> = import("./HttpClient.ts").With<E, R>;
}
export const HttpClient = Ctx.Service<HttpClient, HttpClient>("effect/http/HttpClient");
const methods = (execute: Exec<any, any>): With<any, any> => {
  const m = (method: Req.HttpMethod) => (url: string | URL, o?: Req.Options.NoUrl) => execute(Req.make(method)(url, o));
  return {
    [TypeId]: TypeId, execute,
    get: m("GET"), query: m("QUERY"), head: m("HEAD"), post: m("POST"), patch: m("PATCH"), put: m("PUT"), del: m("DELETE"), options: m("OPTIONS"),
    pipe() {
      return I.pipeArgs(this, arguments);
    },
  };
};
export const makeWith = <E, R>(execute: Exec<E, R>): With<E, R> => methods(execute) as With<E, R>;
/** Build a client from a raw executor; the URL is validated and an AbortSignal tied to interruption is provided. */
export const make = (f: (request: Req.HttpClientRequest, url: URL, signal: AbortSignal, fiber: I.Fiber) => I.Effect<Res.HttpClientResponse, HttpClientError>): HttpClient =>
  methods((request) => I.make((fib) => {
    const url = Req.toUrl(request);
    if (url._tag === "None") return I.failWith(I.causeFail(new HttpClientError({ reason: new InvalidUrlError({ request, description: `Invalid URL: ${request.url}` }) })));
    const ctl = new AbortController();
    const un = fib.onInterrupt(() => ctl.abort());
    return I.settle(() => I.exec(f(request, url.value, ctl.signal, fib), fib), (r) => (un(), r), (e) => (un(), I.failWith(I.toCause(e))));
  })) as HttpClient;
type Lift<E, R, E1, R1> = { (self: With<E, R>): With<E1, R1> };
export const mapRequest: {
  (f: (r: Req.HttpClientRequest) => Req.HttpClientRequest): <E, R>(self: With<E, R>) => With<E, R>;
  <E, R>(self: With<E, R>, f: (r: Req.HttpClientRequest) => Req.HttpClientRequest): With<E, R>;
} = I.dual(2, (self: With<any, any>, f: (r: Req.HttpClientRequest) => Req.HttpClientRequest) => makeWith((req) => self.execute(f(req))));
export const mapRequestEffect: {
  <E2, R2>(f: (r: Req.HttpClientRequest) => I.Effect<Req.HttpClientRequest, E2, R2>): <E, R>(self: With<E, R>) => With<E | E2, R | R2>;
  <E, R, E2, R2>(self: With<E, R>, f: (r: Req.HttpClientRequest) => I.Effect<Req.HttpClientRequest, E2, R2>): With<E | E2, R | R2>;
} = I.dual(2, (self: With<any, any>, f: (r: Req.HttpClientRequest) => I.Effect<Req.HttpClientRequest, any, any>) => makeWith((req) => Effect.flatMap(f(req), self.execute)));
export const transformResponse: {
  <E, R, E1, R1>(f: (effect: I.Effect<Res.HttpClientResponse, E, R>) => I.Effect<Res.HttpClientResponse, E1, R1>): Lift<E, R, E1, R1>;
  <E, R, E1, R1>(self: With<E, R>, f: (effect: I.Effect<Res.HttpClientResponse, E, R>) => I.Effect<Res.HttpClientResponse, E1, R1>): With<E1, R1>;
} = I.dual(2, (self: With<any, any>, f: (e: I.Effect<any, any, any>) => I.Effect<any, any, any>) => makeWith((req) => f(self.execute(req))));
export const transform: {
  <E, R, E1, R1>(f: (effect: I.Effect<Res.HttpClientResponse, E, R>, request: Req.HttpClientRequest) => I.Effect<Res.HttpClientResponse, E1, R1>): Lift<E, R, E1, R1>;
  <E, R, E1, R1>(self: With<E, R>, f: (effect: I.Effect<Res.HttpClientResponse, E, R>, request: Req.HttpClientRequest) => I.Effect<Res.HttpClientResponse, E1, R1>): With<E1, R1>;
} = I.dual(2, (self: With<any, any>, f: (e: I.Effect<any, any, any>, r: Req.HttpClientRequest) => I.Effect<any, any, any>) => makeWith((req) => f(self.execute(req), req)));
export const filterStatusOk = <E, R>(self: With<E, R>): With<E | HttpClientError, R> => transformResponse(self, (e) => Effect.flatMap(e, Res.filterStatusOk));
export const filterStatus: {
  (f: (status: number) => boolean): <E, R>(self: With<E, R>) => With<E | HttpClientError, R>;
  <E, R>(self: With<E, R>, f: (status: number) => boolean): With<E | HttpClientError, R>;
} = I.dual(2, (self: With<any, any>, pred: (s: number) => boolean) => transformResponse(self, (e) => Effect.flatMap(e, Res.filterStatus(pred))));
export const tap: {
  <X, E2, R2>(f: (r: Res.HttpClientResponse) => I.Effect<X, E2, R2>): <E, R>(self: With<E, R>) => With<E | E2, R | R2>;
  <E, R, X, E2, R2>(self: With<E, R>, f: (r: Res.HttpClientResponse) => I.Effect<X, E2, R2>): With<E | E2, R | R2>;
} = I.dual(2, (self: With<any, any>, f: (r: Res.HttpClientResponse) => I.Effect<any, any, any>) => transformResponse(self, (e) => Effect.tap(e, f)));
export const tapRequest: {
  <X, E2, R2>(f: (r: Req.HttpClientRequest) => I.Effect<X, E2, R2>): <E, R>(self: With<E, R>) => With<E | E2, R | R2>;
  <E, R, X, E2, R2>(self: With<E, R>, f: (r: Req.HttpClientRequest) => I.Effect<X, E2, R2>): With<E | E2, R | R2>;
} = I.dual(2, (self: With<any, any>, f: (r: Req.HttpClientRequest) => I.Effect<any, any, any>) => makeWith((req) => Effect.andThen(f(req), self.execute(req))));
const catch_: {
  <E, E2, R2>(f: (e: E) => I.Effect<Res.HttpClientResponse, E2, R2>): <R>(self: With<E, R>) => With<E2, R | R2>;
  <E, R, E2, R2>(self: With<E, R>, f: (e: E) => I.Effect<Res.HttpClientResponse, E2, R2>): With<E2, R | R2>;
} = I.dual(2, (self: With<any, any>, f: (e: any) => I.Effect<any, any, any>) => transformResponse(self, (e) => Effect.catch(e, f)));
export { catch_ as catch };
export const retry: {
  <E, B>(policy: Sched.Schedule<B, NoInfer<E>, any, any> | { readonly times?: number; readonly schedule?: Sched.Schedule<any, E, any, any>; readonly while?: (e: E) => boolean }): <R>(self: With<E, R>) => With<E, R>;
  <E, R, B>(self: With<E, R>, policy: Sched.Schedule<B, NoInfer<E>, any, any> | { readonly times?: number; readonly schedule?: Sched.Schedule<any, E, any, any>; readonly while?: (e: E) => boolean }): With<E, R>;
} = I.dual(2, (self: With<any, any>, policy: any) => transformResponse(self, (e) => Effect.retry(e, policy)));
export const retryTransient: {
  (options?: { readonly times?: number; readonly schedule?: Sched.Schedule<any, any, any, any> }): <E, R>(self: With<E, R>) => With<E, R>;
  <E, R>(self: With<E, R>, options?: { readonly times?: number; readonly schedule?: Sched.Schedule<any, any, any, any> }): With<E, R>;
} = I.dual((args) => typeof args[0] === "object" && args[0] !== null && TypeId in args[0], (self: With<any, any>, o?: { times?: number; schedule?: Sched.Schedule<any, any, any, any> }) =>
  transformResponse(self, (e) => Effect.retry(e, { times: o?.times ?? 3, ...(o?.schedule ? { schedule: o.schedule } : {}), while: (err: unknown) => err instanceof HttpClientError && (err.reason._tag === "TransportError" || (err.reason._tag === "StatusCodeError" && [408, 429, 500, 502, 503, 504].includes(err.reason.response.status))) })));
export const timeout: {
  (d: D.Input): <E, R>(self: With<E, R>) => With<E | import("../errors.ts").TimeoutError, R>;
  <E, R>(self: With<E, R>, d: D.Input): With<E | import("../errors.ts").TimeoutError, R>;
} = I.dual(2, (self: With<any, any>, d: D.Input) => transformResponse(self, (e) => Effect.timeout(e, d)));
export const withScope = <E, R>(self: With<E, R>): With<E, R> => self;
export const followRedirects = <E, R>(self: With<E, R>, _max?: number): With<E, R> => self;
export const TracerDisabledWhen = Ctx.Reference<(request: Req.HttpClientRequest) => boolean>("effect/http/HttpClient/TracerDisabledWhen", { defaultValue: () => () => false });
export const TracerPropagationEnabled = Ctx.Reference<boolean>("effect/http/HttpClient/TracerPropagationEnabled", { defaultValue: () => true });
const withClient = <A, E, R>(f: (c: HttpClient) => I.Effect<A, E, R>): I.Effect<A, E | HttpClientError, R | HttpClient> => Effect.flatMap(HttpClient, f);
export const execute = (request: Req.HttpClientRequest) => withClient((c) => c.execute(request));
export const get = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.get(url, options));
export const post = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.post(url, options));
export const put = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.put(url, options));
export const patch = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.patch(url, options));
export const del = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.del(url, options));
export const head = (url: string | URL, options?: Req.Options.NoUrl) => withClient((c) => c.head(url, options));
