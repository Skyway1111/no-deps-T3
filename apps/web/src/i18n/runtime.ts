import { setLocale, subscribeI18n as subscribeCoreI18n, type Catalog } from "@t3tools/shared/i18n";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { DEFAULT_LOCALE, resolveWebLocaleSelection } from "./locales";

const catalogs = new Map<string, Promise<Catalog | undefined>>();
const formattingListeners = new Set<() => void>();
let activeFormattingLocale: string | undefined;
let requestedLocale: ReturnType<typeof resolveWebLocaleSelection> = {
  catalogLocale: DEFAULT_LOCALE,
  formattingLocale: undefined,
};

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
  const selection = requestedLocale;
  const locale = selection.catalogLocale;
  return loadCatalog(locale).then((catalog) => {
    if (requestedLocale !== selection) return;
    const active = catalog ? locale : DEFAULT_LOCALE;
    const formattingChanged = activeFormattingLocale !== selection.formattingLocale;
    activeFormattingLocale = selection.formattingLocale;
    setLocale(active, catalog);
    document.documentElement.lang = active;
    if (formattingChanged) {
      for (const listener of formattingListeners) listener();
    }
  });
}

function applyLanguageSetting(): void {
  // Not desktopBridge.getSystemLocale(): that is the regional/time locale, not the UI language.
  requestedLocale = resolveWebLocaleSelection(getClientSettings().language, navigator.languages);
  void whenLocaleReady();
}

export function startI18n(): void {
  subscribeClientSettings(applyLanguageSetting);
  applyLanguageSetting();
}

export function subscribeI18n(listener: () => void): () => void {
  const unsubscribeCore = subscribeCoreI18n(listener);
  formattingListeners.add(listener);
  return () => {
    unsubscribeCore();
    formattingListeners.delete(listener);
  };
}

export function getFormattingLocale(): string | undefined {
  return activeFormattingLocale;
}
