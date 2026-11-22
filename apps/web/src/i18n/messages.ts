import type { MFunctionType } from "@t3tools/shared/i18n";

export type MessageResolver = MFunctionType;

/**
 * `m` resolves a `msg()` string in the current UI language at call time, for code outside React
 * (toasts, stores, announcements). Components use `useMessages()` so they re-render on a switch.
 * `getActiveLocale` is the UI language for Intl formatting outside React.
 */
export { m, getLocale as getActiveLocale } from "@t3tools/shared/i18n";
