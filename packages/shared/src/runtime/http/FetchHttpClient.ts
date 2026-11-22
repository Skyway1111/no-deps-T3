import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import { HttpClient, make } from "./HttpClient.ts";
import { fromWeb } from "./HttpClientResponse.ts";
import { HttpClientError, TransportError } from "./HttpClientError.ts";

export const Fetch = Ctx.Reference<typeof globalThis.fetch>("effect/http/FetchHttpClient/Fetch", { defaultValue: () => globalThis.fetch });
export const RequestInit = Ctx.Reference<globalThis.RequestInit>("effect/http/FetchHttpClient/RequestInit", { defaultValue: () => ({}) });
export const fetchClient = make((request, url, signal, fiber) => I.make((f) => {
  const fetchFn = I.lookup(fiber.context, Fetch.key) as typeof globalThis.fetch;
  const init = I.lookup(fiber.context, RequestInit.key) as globalThis.RequestInit;
  const b = request.body;
  const body = b._tag === "Uint8Array" ? b.body : b._tag === "FormData" ? b.formData : b._tag === "Raw" ? (b.body as BodyInit) : b._tag === "Stream" ? (Stream.toAsyncIterable(b.stream) as unknown as BodyInit) : undefined;
  return I.interruptibleWait(f, (res, rej) => {
    fetchFn(url, { ...init, method: request.method, headers: request.headers, body, signal, ...(b._tag === "Stream" ? { duplex: "half" } : {}) } as globalThis.RequestInit).then(
      (r) => res(fromWeb(request, r)),
      (cause) => rej(new I.Failure(I.causeFail(new HttpClientError({ reason: new TransportError({ request, cause, description: (cause as Error)?.message }) })))),
    );
  });
}));
export const layer: Layer.Layer<HttpClient> = Layer.succeed(HttpClient, fetchClient);
