import { resolveLocale } from "@t3tools/client-runtime/locales";
import { DEFAULT_LOCALE, getLocale, setLocale, type Catalog } from "@t3tools/shared/i18n";
import * as Effect from "effect/Effect";

import * as ElectronApp from "../electron/ElectronApp.ts";

/** `m` resolves a `msg()` string in the active UI language at call time. */
export { m, subscribeI18n as onLocaleChange } from "@t3tools/shared/i18n";

// English is the source text and loads nothing. Keep the keys in step with gt.config.json.
const CATALOGS: Readonly<Record<string, () => Promise<{ readonly default: Catalog }>>> = {
  de: () => import("./translations/de.json", { with: { type: "json" } }),
  es: () => import("./translations/es.json", { with: { type: "json" } }),
  fr: () => import("./translations/fr.json", { with: { type: "json" } }),
  ja: () => import("./translations/ja.json", { with: { type: "json" } }),
  ko: () => import("./translations/ko.json", { with: { type: "json" } }),
  "pt-BR": () => import("./translations/pt-BR.json", { with: { type: "json" } }),
  ru: () => import("./translations/ru.json", { with: { type: "json" } }),
  sv: () => import("./translations/sv.json", { with: { type: "json" } }),
  zh: () => import("./translations/zh.json", { with: { type: "json" } }),
};
const SUPPORTED_LOCALES = [DEFAULT_LOCALE, ...Object.keys(CATALOGS)];

const loadedCatalogs = new Map<string, Catalog>();
let requestedLocale = DEFAULT_LOCALE;

const loadCatalog = async (locale: string): Promise<Catalog | undefined> => {
  const load = CATALOGS[locale];
  if (!load) return undefined;
  let catalog = loadedCatalogs.get(locale);
  if (!catalog) loadedCatalogs.set(locale, (catalog = (await load()).default));
  return catalog;
};

/** Activates the saved `language` client setting; "system" follows the OS language order. */
export const applyLanguage = Effect.fn("desktop.i18n.applyLanguage")(function* (language: string) {
  const electronApp = yield* ElectronApp.ElectronApp;
  const locale = resolveLocale(
    language,
    yield* electronApp.preferredSystemLanguages,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
  requestedLocale = locale;
  if (locale === getLocale()) return;
  const catalog = yield* Effect.promise(() => loadCatalog(locale));
  // A later call may have asked for another language while this catalog loaded.
  if (requestedLocale !== locale) return;
  setLocale(locale, catalog);
});
