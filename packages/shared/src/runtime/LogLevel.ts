import { logLevelRank, type LogLevel as L } from "./References.ts";

export type LogLevel = L;
export type Severity = Exclude<L, "All" | "None">;
export const values: ReadonlyArray<LogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"];
export const isGreaterThan = (self: LogLevel, that: LogLevel) => logLevelRank[self] > logLevelRank[that];
export const isGreaterThanOrEqualTo = (self: LogLevel, that: LogLevel) => logLevelRank[self] >= logLevelRank[that];
export const isLessThan = (self: LogLevel, that: LogLevel) => logLevelRank[self] < logLevelRank[that];
export const isLessThanOrEqualTo = (self: LogLevel, that: LogLevel) => logLevelRank[self] <= logLevelRank[that];
export const Order = (a: LogLevel, b: LogLevel): -1 | 0 | 1 => (logLevelRank[a] < logLevelRank[b] ? -1 : logLevelRank[a] > logLevelRank[b] ? 1 : 0);
