import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as Stream from "../Stream.ts";
import * as Schema from "../Schema.ts";
import * as Headers from "./Headers.ts";
import { DecodeError, HttpClientError, StatusCodeError } from "./HttpClientError.ts";
import type { HttpClientRequest } from "./HttpClientRequest.ts";

export const TypeId: unique symbol = Symbol.for("effect/http/HttpClientResponse") as never;
export interface HttpClientResponse extends I.Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly request: HttpClientRequest;
  readonly url: string;
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly remoteAddress: O.Option<string>;
  readonly json: I.Effect<unknown, HttpClientError>;
  readonly text: I.Effect<string, HttpClientError>;
  readonly arrayBuffer: I.Effect<ArrayBuffer, HttpClientError>;
  readonly formData: I.Effect<FormData, HttpClientError>;
  readonly urlParamsBody: I.Effect<ReadonlyArray<readonly [string, string]>, HttpClientError>;
  readonly stream: Stream.Stream<Uint8Array, HttpClientError>;
  readonly raw: Response;
}
/** Wrap a WHATWG Response; the body is read at most once and shared. */
export const fromWeb = (request: HttpClientRequest, response: Response): HttpClientResponse => {
  let textCache: Promise<string> | undefined;
  const body = <A>(read: () => Promise<A>, description: string): I.Effect<A, HttpClientError> =>
    I.make((f) => I.interruptibleWait<A>(f, (res, rej) => {
      read().then(res, (cause) => rej(new I.Failure(I.causeFail(new HttpClientError({ reason: new DecodeError({ request, response: self, cause, description }) })))));
    }));
  const text = body(() => (textCache ??= response.text()), "text");
  const self: HttpClientResponse = {
    [TypeId]: TypeId,
    request,
    url: response.url || request.url,
    status: response.status,
    headers: Headers.fromInput(response.headers as unknown as Iterable<[string, string]>),
    remoteAddress: O.none(),
    text,
    json: body(async () => {
      const t = await (textCache ??= response.text());
      return t === "" ? null : JSON.parse(t);
    }, "json"),
    arrayBuffer: body(() => response.arrayBuffer(), "arrayBuffer"),
    formData: body(() => response.formData(), "formData"),
    urlParamsBody: body(async () => [...new URLSearchParams(await (textCache ??= response.text()))], "urlParams"),
    stream: Stream.suspend(() =>
      response.body
        ? Stream.fromAsyncIterable(response.body as unknown as AsyncIterable<Uint8Array>, (cause) => new HttpClientError({ reason: new DecodeError({ request, response: self, cause, description: "stream" }) }))
        : Stream.empty),
    raw: response,
    pipe() {
      return I.pipeArgs(this, arguments);
    },
  };
  return self;
};
export const filterStatusOk = (self: HttpClientResponse): I.Effect<HttpClientResponse, HttpClientError> =>
  I.make(() => (self.status >= 200 && self.status < 300 ? self : I.failWith(I.causeFail(new HttpClientError({ reason: new StatusCodeError({ request: self.request, response: self, description: "non 2xx status code" }) })))));
export const filterStatus: { (f: (status: number) => boolean): (self: HttpClientResponse) => I.Effect<HttpClientResponse, HttpClientError>; (self: HttpClientResponse, f: (status: number) => boolean): I.Effect<HttpClientResponse, HttpClientError> } =
  I.dual(2, (self: HttpClientResponse, pred: (s: number) => boolean) =>
    I.make(() => (pred(self.status) ? self : I.failWith(I.causeFail(new HttpClientError({ reason: new StatusCodeError({ request: self.request, response: self, description: "invalid status code" }) }))))));
export const schemaBodyJson = <S extends Schema.Top>(schema: S, options?: Schema.ParseOptions) => {
  const decode = Schema.decodeUnknownEffect(schema, options);
  return (self: HttpClientResponse): I.Effect<S["Type"], HttpClientError | Schema.SchemaError, S["DecodingServices"]> =>
    I.make((f) => I.chain(I.exec(self.json, f), (j) => I.exec(decode(j), f)));
};
export const schemaJson = <S extends Schema.Top>(schema: S, options?: Schema.ParseOptions) => {
  const decode = Schema.decodeUnknownEffect(schema, options);
  return (self: HttpClientResponse) =>
    I.make((f) => I.chain(I.exec(self.json, f), (body) => I.exec(decode({ status: self.status, headers: self.headers, body }), f)));
};
export const matchStatus = <A>(cases: Record<number | `${number}xx` | "orElse", (r: HttpClientResponse) => A>) => (self: HttpClientResponse): A =>
  (cases[self.status] ?? cases[`${Math.floor(self.status / 100)}xx` as `${number}xx`] ?? cases.orElse)(self);
