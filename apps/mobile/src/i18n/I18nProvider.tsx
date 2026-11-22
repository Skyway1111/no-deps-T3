import { resolveLocaleSelection } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { LocaleProvider, setLocale, type Catalog } from "@t3tools/shared/i18n/react";
import { createContext, use, useLayoutEffect, type ReactNode } from "react";
import { Platform, TurboModuleRegistry, type TurboModule } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

const FormattingLocaleContext = createContext(DEFAULT_LOCALE);

export function useFormattingLocale(): string {
  return use(FormattingLocaleContext);
}

// English is the source. Required on demand: Metro runs every statically imported module at
// startup, and only one locale's catalog is ever used.
const CATALOGS: Readonly<Record<string, () => Catalog>> = {
  es: () => require("./translations/es.json"),
  zh: () => require("./translations/zh.json"),
  "pt-BR": () => require("./translations/pt-BR.json"),
  fr: () => require("./translations/fr.json"),
  de: () => require("./translations/de.json"),
  ja: () => require("./translations/ja.json"),
  ko: () => require("./translations/ko.json"),
  ru: () => require("./translations/ru.json"),
  sv: () => require("./translations/sv.json"),
};

// Device languages in preference order, from gt-react-native's native module.
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LOCALE)
    : DEFAULT_LOCALE;
}

/** Translates the app into the saved language; "system" follows the device. Mounted once in App. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  const { catalogLocale, formattingLocale } = resolveLocaleSelection(
    useLanguagePreference(),
    readSystemLocales(),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the locale store also serves call-time m() outside React; layout timing switches before paint
  useLayoutEffect(() => setLocale(catalogLocale, CATALOGS[catalogLocale]?.()), [catalogLocale]);
  return (
    <LocaleProvider>
      <FormattingLocaleContext value={formattingLocale}>{props.children}</FormattingLocaleContext>
    </LocaleProvider>
  );
}
