import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";

export interface Console {
  readonly log: (...args: ReadonlyArray<unknown>) => void;
  readonly info: (...args: ReadonlyArray<unknown>) => void;
  readonly warn: (...args: ReadonlyArray<unknown>) => void;
  readonly error: (...args: ReadonlyArray<unknown>) => void;
  readonly debug: (...args: ReadonlyArray<unknown>) => void;
  readonly trace: (...args: ReadonlyArray<unknown>) => void;
  readonly table: (data: unknown, columns?: ReadonlyArray<string>) => void;
  readonly dir: (item: unknown, options?: unknown) => void;
  readonly group: (...label: ReadonlyArray<unknown>) => void;
  readonly groupEnd: () => void;
  readonly time: (label?: string) => void;
  readonly timeEnd: (label?: string) => void;
  readonly clear: () => void;
}
export const Console = Ctx.Reference<Console>("effect/Console", { defaultValue: () => globalThis.console as unknown as Console });
const call = (m: keyof Console) => (...args: ReadonlyArray<unknown>): I.Effect<void> =>
  I.make((f) => void ((I.lookup(f.context, Console.key) as Console)[m] as (...a: ReadonlyArray<unknown>) => void)(...args));
export const log = call("log");
export const info = call("info");
export const warn = call("warn");
export const error = call("error");
export const debug = call("debug");
export const trace = call("trace");
export const dir = call("dir");
export const table = call("table");
export const clear: I.Effect<void> = call("clear")();
export const consoleWith = <A, E, R>(f: (c: Console) => I.Effect<A, E, R>): I.Effect<A, E, R> =>
  I.make((fib) => I.exec(f(I.lookup(fib.context, Console.key) as Console), fib));
export const withGroup = <A, E, R>(self: I.Effect<A, E, R>, options?: { readonly label?: string }): I.Effect<A, E, R> =>
  I.make((fib) => {
    const c = I.lookup(fib.context, Console.key) as Console;
    c.group(options?.label);
    return I.settle(() => I.exec(self, fib), (a) => (c.groupEnd(), a), (e) => (c.groupEnd(), I.failWith(I.toCause(e))));
  });
