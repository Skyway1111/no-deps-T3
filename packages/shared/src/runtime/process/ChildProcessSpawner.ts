import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as Stream from "../Stream.ts";
import * as Sink from "../Sink.ts";
import * as ScopeM from "../Scope.ts";
import type { Brand } from "../Brand.ts";
import type { PlatformError } from "../PlatformError.ts";
import type { Command, KillOptions } from "./ChildProcess.ts";

export const HandleTypeId: unique symbol = Symbol.for("effect/process/ChildProcessHandle") as never;
export type ExitCode = number & Brand<"ExitCode">;
export type ProcessId = number & Brand<"ProcessId">;
export const ExitCode = (n: number): ExitCode => n as ExitCode;
export const ProcessId = (n: number): ProcessId => n as ProcessId;
export interface Reref {
  readonly reref: I.Effect<void>;
}
export interface ChildProcessHandle {
  readonly [HandleTypeId]: typeof HandleTypeId;
  readonly pid: ProcessId;
  readonly exitCode: I.Effect<ExitCode, PlatformError>;
  readonly isRunning: I.Effect<boolean, PlatformError>;
  readonly kill: (options?: KillOptions) => I.Effect<void, PlatformError>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError>;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly all: Stream.Stream<Uint8Array, PlatformError>;
  readonly getInputFd: (fd: number) => Sink.Sink<void, Uint8Array, never, PlatformError>;
  readonly getOutputFd: (fd: number) => Stream.Stream<Uint8Array, PlatformError>;
  readonly unref: I.Effect<I.Effect<void>, PlatformError>;
}
export const makeHandle = (params: Omit<ChildProcessHandle, typeof HandleTypeId>): ChildProcessHandle => ({ [HandleTypeId]: HandleTypeId, ...params });
type Opts = { readonly includeStderr?: boolean };
export interface ChildProcessSpawnerService {
  spawn(command: Command): I.Effect<ChildProcessHandle, PlatformError, ScopeM.Scope>;
  exitCode(command: Command): I.Effect<ExitCode, PlatformError>;
  streamString(command: Command, options?: Opts): Stream.Stream<string, PlatformError>;
  streamLines(command: Command, options?: Opts): Stream.Stream<string, PlatformError>;
  lines(command: Command, options?: Opts): I.Effect<Array<string>, PlatformError>;
  string(command: Command, options?: Opts): I.Effect<string, PlatformError>;
}
export class ChildProcessSpawner extends Ctx.Service<ChildProcessSpawner, ChildProcessSpawnerService>()("effect/process/ChildProcessSpawner") {}
const scoped = <A, E>(eff: I.Effect<A, E, ScopeM.Scope>): I.Effect<A, E> => I.make((f) => I.exec(ScopeM.useScope(new ScopeM.ScopeImpl(), eff), f));
/** Derive the convenience methods from `spawn`. */
export const make = (spawn: ChildProcessSpawnerService["spawn"]): ChildProcessSpawnerService => {
  const output = (cmd: Command, o?: Opts) =>
    Stream.unwrap(I.make((f) => I.chain(I.exec(spawn(cmd), f), (h) => (o?.includeStderr ? h.all : h.stdout)))) as Stream.Stream<Uint8Array, PlatformError>;
  const streamString = (cmd: Command, o?: Opts) => Stream.decodeText(output(cmd, o));
  return {
    spawn,
    exitCode: (cmd) => scoped(I.make((f) => I.chain(I.exec(spawn(cmd), f), (h) => I.exec(h.exitCode, f)))),
    streamString,
    streamLines: (cmd, o) => Stream.splitLines(streamString(cmd, o)),
    lines: (cmd, o) => Stream.runCollect(Stream.splitLines(streamString(cmd, o))) as I.Effect<Array<string>, PlatformError>,
    string: (cmd, o) => Stream.mkString(streamString(cmd, o)) as I.Effect<string, PlatformError>,
  };
};
