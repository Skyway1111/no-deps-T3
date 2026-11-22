import * as Ctx from "./Context.ts";

export type LogLevel = "All" | "Fatal" | "Error" | "Warn" | "Info" | "Debug" | "Trace" | "None";
export const logLevelRank: Record<LogLevel, number> = { All: 0, Trace: 1, Debug: 2, Info: 3, Warn: 4, Error: 5, Fatal: 6, None: 7 };
export const MinimumLogLevel = Ctx.Reference<LogLevel>("effect/References/MinimumLogLevel", { defaultValue: () => "Info" });
export const CurrentLogLevel = Ctx.Reference<LogLevel>("effect/References/CurrentLogLevel", { defaultValue: () => "Info" });
export const UnhandledLogLevel = Ctx.Reference<LogLevel | undefined>("effect/References/UnhandledLogLevel", { defaultValue: () => "Error" });
export const CurrentLogAnnotations = Ctx.Reference<Readonly<Record<string, unknown>>>("effect/References/CurrentLogAnnotations", { defaultValue: () => ({}) });
export const CurrentLogSpans = Ctx.Reference<ReadonlyArray<[label: string, timestamp: number]>>("effect/References/CurrentLogSpans", { defaultValue: () => [] });
export const TracerEnabled = Ctx.Reference<boolean>("effect/References/TracerEnabled", { defaultValue: () => true });
export const TracerTimingEnabled = Ctx.Reference<boolean>("effect/References/TracerTimingEnabled", { defaultValue: () => true });
export const TracerSpanAnnotations = Ctx.Reference<Readonly<Record<string, unknown>>>("effect/References/TracerSpanAnnotations", { defaultValue: () => ({}) });
export const TracerSpanLinks = Ctx.Reference<ReadonlyArray<unknown>>("effect/References/TracerSpanLinks", { defaultValue: () => [] });
export const MaxOpsBeforeYield = Ctx.Reference<number>("effect/References/MaxOpsBeforeYield", { defaultValue: () => 2048 });
export const PreventSchedulerYield = Ctx.Reference<boolean>("effect/References/PreventSchedulerYield", { defaultValue: () => false });
export interface StackFrame { readonly name: string; readonly stack: () => string | undefined; readonly parent: StackFrame | undefined }
export const CurrentStackFrame = Ctx.Reference<StackFrame | undefined>("effect/References/CurrentStackFrame", { defaultValue: () => undefined });
export const StackFrame = CurrentStackFrame;
export const LogToStderr = Ctx.Reference<boolean>("effect/References/LogToStderr", { defaultValue: () => false });
