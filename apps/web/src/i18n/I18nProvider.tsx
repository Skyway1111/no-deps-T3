import { useSyncExternalStore } from "react";

import { getFormattingLocale, subscribeI18n } from "./runtime";

export { LocaleProvider as I18nProvider } from "@t3tools/shared/i18n/react";

export function useFormattingLocale(): string | undefined {
  return useSyncExternalStore(subscribeI18n, getFormattingLocale);
}
