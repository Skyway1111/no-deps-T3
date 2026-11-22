import { TaggedError } from "../errors.ts";
import type { HttpClientRequest } from "./HttpClientRequest.ts";
import type { HttpClientResponse } from "./HttpClientResponse.ts";

export class TransportError extends TaggedError("TransportError")<{ readonly request: HttpClientRequest; readonly cause?: unknown; readonly description?: string }> {}
export class EncodeError extends TaggedError("EncodeError")<{ readonly request: HttpClientRequest; readonly cause?: unknown; readonly description?: string }> {}
export class InvalidUrlError extends TaggedError("InvalidUrlError")<{ readonly request: HttpClientRequest; readonly cause?: unknown; readonly description?: string }> {}
export class StatusCodeError extends TaggedError("StatusCodeError")<{ readonly request: HttpClientRequest; readonly response: HttpClientResponse; readonly description?: string }> {}
export class DecodeError extends TaggedError("DecodeError")<{ readonly request: HttpClientRequest; readonly response: HttpClientResponse; readonly cause?: unknown; readonly description?: string }> {}
export class EmptyBodyError extends TaggedError("EmptyBodyError")<{ readonly request: HttpClientRequest; readonly response: HttpClientResponse; readonly description?: string }> {}
export type HttpClientErrorReason = TransportError | EncodeError | InvalidUrlError | StatusCodeError | DecodeError | EmptyBodyError;
export class HttpClientError extends TaggedError("HttpClientError")<{ readonly reason: HttpClientErrorReason }> {
  get request(): HttpClientRequest {
    return this.reason.request;
  }
  get response(): HttpClientResponse | undefined {
    return "response" in this.reason ? this.reason.response : undefined;
  }
  override get message(): string {
    const r = this.reason;
    const status = "response" in r ? ` (${r.response.status})` : "";
    return `${r._tag}: ${r.request.method} ${r.request.url}${status}${r.description ? ` - ${r.description}` : ""}`;
  }
}
export const isHttpClientError = (u: unknown): u is HttpClientError => u instanceof HttpClientError;
