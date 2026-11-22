import * as I from "../internal.ts";
import type * as Red from "../Redacted.ts";
import type * as Stream from "../Stream.ts";
import type * as Sink from "../Sink.ts";
import type * as D from "../Duration.ts";
import type { PlatformError } from "../PlatformError.ts";
import type { Scope } from "../Scope.ts";
import type { ChildProcessHandle, ChildProcessSpawner } from "./ChildProcessSpawner.ts";

export type Word = string | Red.Redacted<string>;
export type TemplateExpressionItem = string | number | boolean | Red.Redacted<string>;
export type TemplateExpression = TemplateExpressionItem | ReadonlyArray<TemplateExpressionItem>;
export type Signal = NodeJS.Signals | "SIGBREAK" | "SIGLOST" | "SIGINFO";
export type CommandInput = "pipe" | "inherit" | "ignore" | "overlapped" | Stream.Stream<Uint8Array, PlatformError>;
export type CommandOutput = "pipe" | "inherit" | "ignore" | "overlapped" | Sink.Sink<Uint8Array, Uint8Array, never, PlatformError>;
export interface KillOptions {
  readonly killSignal?: Signal;
  readonly forceKillAfter?: D.Input;
}
export interface CommandOptions extends KillOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | Red.Redacted<string> | undefined>;
  readonly extendEnv?: boolean;
  readonly shell?: boolean | string;
  readonly detached?: boolean;
  readonly windowsHide?: boolean;
  readonly stdin?: CommandInput | { readonly stream: CommandInput; readonly endOnDone?: boolean; readonly encoding?: string };
  readonly stdout?: CommandOutput | { readonly stream: CommandOutput };
  readonly stderr?: CommandOutput | { readonly stream: CommandOutput };
  readonly additionalFds?: Record<`fd${number}`, { readonly type: "input" | "output"; readonly stream?: unknown }>;
}
export interface PipeOptions {
  readonly from?: "stdout" | "stderr" | "all" | `fd${number}`;
  readonly to?: "stdin" | `fd${number}`;
}
export interface StandardCommand extends I.Effect<ChildProcessHandle, PlatformError, ChildProcessSpawner | Scope> {
  readonly _tag: "StandardCommand";
  readonly command: string;
  readonly args: ReadonlyArray<Word>;
  readonly options: CommandOptions;
}
export interface PipedCommand extends I.Effect<ChildProcessHandle, PlatformError, ChildProcessSpawner | Scope> {
  readonly _tag: "PipedCommand";
  readonly left: Command;
  readonly right: Command;
  readonly options: PipeOptions;
}
export type Command = StandardCommand | PipedCommand;
const SpawnerKey = "effect/process/ChildProcessSpawner";
const proto = {
  ...I.YieldableProto,
  [I.RUN](this: Command, f: I.Fiber) {
    const spawner = f.context.map.get(SpawnerKey) as { spawn: (c: Command) => I.Effect<ChildProcessHandle, PlatformError, Scope> } | undefined;
    if (!spawner) return I.serviceNotFound(SpawnerKey);
    return I.exec(spawner.spawn(this), f);
  },
};
const standard = (command: string, args: ReadonlyArray<Word>, options: CommandOptions): StandardCommand =>
  Object.assign(Object.create(proto), { _tag: "StandardCommand", command, args, options });
/** Split a template into words, keeping each interpolation as one argument. */
const fromTemplate = (options: CommandOptions, strings: TemplateStringsArray, exprs: ReadonlyArray<TemplateExpression>): StandardCommand => {
  const words: Array<Word> = [];
  let cur: Word | undefined;
  const push = () => {
    if (cur !== undefined && cur !== "") words.push(cur);
    cur = undefined;
  };
  strings.forEach((s, i) => {
    const parts = s.split(/\s+/);
    parts.forEach((p, j) => {
      if (j > 0) push();
      if (p) cur = typeof cur === "string" ? cur + p : p;
    });
    if (i < exprs.length) {
      const e = exprs[i]!;
      if (Array.isArray(e)) {
        push();
        for (const x of e) words.push(typeof x === "object" ? (x as Red.Redacted<string>) : String(x));
      } else if (typeof e === "object") {
        push();
        words.push(e as Red.Redacted<string>);
      } else cur = (typeof cur === "string" ? cur : "") + String(e);
    }
  });
  push();
  const [command, ...args] = words;
  return standard(typeof command === "string" ? command : String(command), args, options);
};
export const make: {
  (command: string, options?: CommandOptions): StandardCommand;
  (command: string, args: ReadonlyArray<Word>, options?: CommandOptions): StandardCommand;
  (options: CommandOptions): (templates: TemplateStringsArray, ...expressions: ReadonlyArray<TemplateExpression>) => StandardCommand;
  (templates: TemplateStringsArray, ...expressions: ReadonlyArray<TemplateExpression>): StandardCommand;
} = function (a: any, ...rest: Array<any>): any {
  if (typeof a === "string") return Array.isArray(rest[0]) ? standard(a, rest[0], rest[1] ?? {}) : standard(a, [], rest[0] ?? {});
  if (Array.isArray(a) && "raw" in a) return fromTemplate({}, a as TemplateStringsArray, rest);
  return (strings: TemplateStringsArray, ...exprs: Array<TemplateExpression>) => fromTemplate(a, strings, exprs);
} as never;
export const pipeTo: {
  (that: Command, options?: PipeOptions): (self: Command) => PipedCommand;
  (self: Command, that: Command, options?: PipeOptions): PipedCommand;
} = I.dual((args) => typeof args[0] === "object" && args[0] !== null && "_tag" in args[0] && typeof args[1] === "object" && args[1] !== null && "_tag" in args[1], (left: Command, right: Command, options?: PipeOptions) =>
  Object.assign(Object.create(proto), { _tag: "PipedCommand", left, right, options: options ?? {} }));
export const isCommand = (u: unknown): u is Command => typeof u === "object" && u !== null && ((u as Command)._tag === "StandardCommand" || (u as Command)._tag === "PipedCommand");
export const isStandardCommand = (u: unknown): u is StandardCommand => isCommand(u) && u._tag === "StandardCommand";
export const isPipedCommand = (u: unknown): u is PipedCommand => isCommand(u) && u._tag === "PipedCommand";
export const setCwd: { (cwd: string): <C extends Command>(self: C) => C; <C extends Command>(self: C, cwd: string): C } =
  I.dual(2, (self: StandardCommand, cwd: string) => standard(self.command, self.args, { ...self.options, cwd }));
export const setEnv: { (env: Record<string, string>): <C extends Command>(self: C) => C; <C extends Command>(self: C, env: Record<string, string>): C } =
  I.dual(2, (self: StandardCommand, env: Record<string, string>) => standard(self.command, self.args, { ...self.options, env: { ...self.options.env, ...env } }));
