import { resolveLocale } from "@t3tools/client-runtime/locales";
import { setLocale, type Catalog } from "@t3tools/shared/i18n";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

export { subscribeI18n } from "@t3tools/shared/i18n";

const catalogs = new Map<string, Promise<Catalog | undefined>>();
let requestedLocale = DEFAULT_LOCALE;

// English is the source text, so it never loads a chunk.
function loadCatalog(locale: string): Promise<Catalog | undefined> {
  if (locale === DEFAULT_LOCALE) return Promise.resolve(undefined);
  let load = catalogs.get(locale);
  if (!load) {
    // A failed load stays uncached: English renders now and the next request retries.
    load = import(`./translations/${locale}.json`).then(
      (module: { default: Catalog }) => module.default,
      () => {
        catalogs.delete(locale);
        return undefined;
      },
    );
    catalogs.set(locale, load);
  }
  return load;
}

/** Resolves once the requested locale's translations are active; immediate for English. */
export function whenLocaleReady(): Promise<void> {
  const locale = requestedLocale;
  return loadCatalog(locale).then((catalog) => {
    if (requestedLocale !== locale) return;
    const active = catalog ? locale : DEFAULT_LOCALE;
    setLocale(active, catalog);
    document.documentElement.lang = active;
  });
}

function applyLanguageSetting(): void {
  // Not desktopBridge.getSystemLocale(): that is the regional/time locale, not the UI language.
  requestedLocale = resolveLocale(
    getClientSettings().language,
    navigator.languages,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  void whenLocaleReady();
}

export function startI18n(): void {
  subscribeClientSettings(applyLanguageSetting);
  applyLanguageSetting();
}
