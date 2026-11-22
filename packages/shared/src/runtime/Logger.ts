import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";
import { CurrentLogAnnotations, CurrentLogSpans, LogToStderr, type LogLevel } from "./References.ts";

export const TypeId: unique symbol = Symbol.for("effect/Logger") as never;
export interface Options<Message> {
  readonly message: Message;
  readonly logLevel: LogLevel;
  readonly cause: I.Cause<unknown>;
  readonly fiber: I.Fiber;
  readonly date: Date;
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly spans: ReadonlyArray<[string, number]>;
}
export interface Logger<in Message, out Output> extends I.Pipeable {
  readonly [TypeId]: typeof TypeId;
  log(options: Options<Message>): Output;
}
const proto = { [TypeId]: TypeId, ...I.PipeProto };
export const make = <Message, Output>(log: (options: Options<Message>) => Output): Logger<Message, Output> =>
  Object.assign(Object.create(proto), { log });
export const isLogger = (u: unknown): u is Logger<unknown, unknown> => typeof u === "object" && u !== null && TypeId in u;
export const map = <Output, Output2>(self: Logger<any, Output>, f: (o: Output) => Output2): Logger<any, Output2> => make((o) => f(self.log(o)));

const messageText = (m: unknown): string => {
  const arr = Array.isArray(m) ? m : [m];
  return arr.map((x) => (typeof x === "string" ? x : I.safeJson(x))).join(" ");
};
const causeText = (c: I.Cause<unknown>) => (c.reasons.length ? I.prettyCause(c) : "");
export const formatLogFmt = make((o: Options<unknown>): string => {
  const parts = [`timestamp=${o.date.toISOString()}`, `level=${o.logLevel.toUpperCase()}`, `fiber=#${o.fiber.id}`, `message=${JSON.stringify(messageText(o.message))}`];
  const c = causeText(o.cause);
  if (c) parts.push(`cause=${JSON.stringify(c)}`);
  for (const [k, v] of Object.entries(o.annotations)) parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v) : I.safeJson(v)}`);
  return parts.join(" ");
});
export const formatSimple = make((o: Options<unknown>): string => {
  const c = causeText(o.cause);
  return `[${o.date.toISOString()}] ${o.logLevel.toUpperCase()} (#${o.fiber.id}): ${messageText(o.message)}${c ? `\n${c}` : ""}`;
});
export const formatStructured = make((o: Options<unknown>) => ({
  message: o.message, logLevel: o.logLevel.toUpperCase(), timestamp: o.date.toISOString(),
  cause: causeText(o.cause) || undefined, annotations: o.annotations, spans: Object.fromEntries(o.spans.map(([l, t]) => [l, o.date.getTime() - t])), fiberId: `#${o.fiber.id}`,
}));
export const formatJson = map(formatStructured, (s) => I.safeJson(s));
const consoleFor = (level: LogLevel, stderr: boolean) =>
  stderr ? console.error : level === "Error" || level === "Fatal" ? console.error : level === "Warn" ? console.warn : level === "Debug" || level === "Trace" ? console.debug : console.log;
export const withConsoleLog = <M>(self: Logger<M, unknown>): Logger<M, void> => make((o) => console.log(self.log(o)));
export const withConsoleError = <M>(self: Logger<M, unknown>): Logger<M, void> => make((o) => console.error(self.log(o)));
export const withLeveledConsole = <M>(self: Logger<M, unknown>): Logger<M, void> => make((o) => consoleFor(o.logLevel, false)(self.log(o)));
export const defaultLogger: Logger<unknown, void> = make((o) => {
  const stderr = I.lookup(o.fiber.context, LogToStderr.key) as boolean;
  consoleFor(o.logLevel, stderr)(formatSimple.log(o));
});
export const consolePretty = (_?: unknown) => defaultLogger;
export const consolePrettyBrowser = consolePretty;
export const consolePrettyTty = consolePretty;
export const consoleLogFmt = withConsoleLog(formatLogFmt);
export const consoleStructured = withConsoleLog(formatStructured);
export const consoleJson = withConsoleLog(formatJson);
export const tracerLogger: Logger<unknown, void> = make((o) => {
  const span = o.fiber.span as { event?: (n: string, t: bigint, a?: Record<string, unknown>) => void } | undefined;
  span?.event?.(messageText(o.message), BigInt(o.date.getTime()) * 1_000_000n, { "effect.logLevel": o.logLevel.toUpperCase(), ...o.annotations });
});
export const CurrentLoggers = Ctx.Reference<ReadonlySet<Logger<unknown, any>>>("effect/Loggers/CurrentLoggers", {
  defaultValue: () => new Set([defaultLogger, tracerLogger]),
});
export { LogToStderr };
export const batched = <M, O>(self: Logger<M, O>, options: { readonly window: number; readonly flush: (messages: Array<O>) => I.Effect<void> }) => {
  let buf: Array<O> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return I.make<Logger<M, void>>(() => make((o) => {
    buf.push(self.log(o));
    timer ??= setTimeout(() => {
      timer = undefined;
      const b = buf;
      buf = [];
      I.runFiber(options.flush(b), I.emptyContext);
    }, options.window);
  }));
};
type LayerLike = import("./Layer.ts").Layer<never>;
/** Replace (or extend) the current loggers. */
export const layer = (
  loggers: ReadonlyArray<Logger<unknown, unknown> | I.Effect<Logger<unknown, unknown>, any, any>>,
  options?: { readonly mergeWithExisting?: boolean },
): LayerLike => {
  const { fromBuild } = layerHooks;
  return fromBuild((f) => {
    const resolved: Array<Logger<unknown, unknown>> = [];
    let i = 0;
    const loop = (): I.Step<I.Context<never>> => {
      while (i < loggers.length) {
        const l = loggers[i++]!;
        if (isLogger(l)) resolved.push(l);
        else return I.chain(I.exec(l, f), (x) => (resolved.push(x), loop()));
      }
      const base = options?.mergeWithExisting ? [...(I.lookup(f.context, CurrentLoggers.key) as ReadonlySet<Logger<unknown, unknown>>)] : [];
      return I.makeContext(new Map([[CurrentLoggers.key, new Set([...base, ...resolved])]]));
    };
    return loop();
  });
};
/** Set by Layer.ts to avoid an import cycle. */
export const layerHooks: { fromBuild: (run: (f: I.Fiber) => I.Step<I.Context<never>>) => LayerLike } = { fromBuild: null as never };

/** Called by Effect.log*: dispatch to the current loggers. */
export function emit(f: I.Fiber, level: LogLevel, message: unknown, cause: I.Cause<unknown>): void {
  const loggers = I.lookup(f.context, CurrentLoggers.key) as ReadonlySet<Logger<unknown, unknown>>;
  if (loggers.size === 0) return;
  const o: Options<unknown> = {
    message, logLevel: level, cause, fiber: f, date: new Date(),
    annotations: I.lookup(f.context, CurrentLogAnnotations.key) as Record<string, unknown>,
    spans: I.lookup(f.context, CurrentLogSpans.key) as Array<[string, number]>,
  };
  for (const l of loggers) l.log(o);
}
