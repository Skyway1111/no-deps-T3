import type { MFunctionType } from "@t3tools/shared/i18n";

export type MessageResolver = MFunctionType;

/**
 * `m` resolves a `msg()` string in the current UI language at call time, for code outside React
 * (alerts, stores, notifications). Components use `useMessages()` so they re-render on a switch.
 */
export { m } from "@t3tools/shared/i18n";

/**
 * Keeps `msg()` text unresolved, for helpers whose result is cached past a language switch.
 * Only for helpers that pass a whole `msg()` string; display sites resolve the result.
 */
export const keepMarked = ((message: string) => message) as MessageResolver;
