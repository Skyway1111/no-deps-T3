import * as Ctx from "./Context.ts";
import * as I from "./internal.ts";
import * as O from "./Option.ts";
import { TaggedError } from "./errors.ts";
import type { PlatformError } from "./PlatformError.ts";

export interface Key {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}
export interface UserInput {
  readonly input: O.Option<string>;
  readonly key: Key;
}
export interface Size {
  readonly columns: number;
  readonly rows: number;
}
export class QuitError extends TaggedError("QuitError")<{}> {}
export const isQuitError = (u: unknown): u is QuitError => u instanceof QuitError;
export interface TerminalService {
  readonly columns: I.Effect<number>;
  readonly rows: I.Effect<number>;
  readonly isTTY: I.Effect<boolean>;
  readonly readInput: I.Effect<unknown, never, unknown>;
  readonly readLine: I.Effect<string, QuitError>;
  readonly display: (text: string) => I.Effect<void, PlatformError>;
}
export class Terminal extends Ctx.Service<Terminal, TerminalService>()("effect/Terminal") {}
export const make = (impl: TerminalService): TerminalService => impl;
