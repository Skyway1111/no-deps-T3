import * as Ctx from "./Context.ts";
import * as Layer from "./Layer.ts";
import * as I from "./internal.ts";
import type * as Stream from "./Stream.ts";
import type * as Sink from "./Sink.ts";
import type { PlatformError } from "./PlatformError.ts";

export interface StdioService {
  readonly args: I.Effect<ReadonlyArray<string>>;
  readonly stdin: Stream.Stream<Uint8Array, PlatformError>;
  readonly stdout: (options?: { readonly endOnDone?: boolean }) => Sink.Sink<void, Uint8Array | string, never, PlatformError>;
  readonly stderr: (options?: { readonly endOnDone?: boolean }) => Sink.Sink<void, Uint8Array | string, never, PlatformError>;
}
export class Stdio extends Ctx.Service<Stdio, StdioService>()("effect/Stdio") {}
export const make = (impl: StdioService): StdioService => impl;
export const layerTest = (impl: Partial<StdioService>): Layer.Layer<Stdio> => Layer.succeed(Stdio, impl as StdioService);
