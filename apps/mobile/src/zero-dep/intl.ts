// Minimal Intl.getCanonicalLocales / Locale / DisplayNames (English) / PluralRules for runtimes without them (Hermes).
// Plural data covers the app's shipped locales; unknown languages get English cardinals and no ordinal forms.

const TAG = /^([a-z]{2,3}|[a-z]{5,8})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?((?:[-_][a-z\d]{1,8})*)$/i;

interface Parts {
  language: string;
  script?: string;
  region?: string;
  rest: string;
}

function parse(tag: string): Parts {
  const m = typeof tag === "string" ? TAG.exec(tag) : null;
  if (!m) throw new RangeError(`Incorrect locale information provided: ${tag}`);
  const parts: Parts = { language: m[1]!.toLowerCase(), rest: m[4]!.toLowerCase().replace(/_/g, "-") };
  if (m[2]) parts.script = m[2][0]!.toUpperCase() + m[2].slice(1).toLowerCase();
  if (m[3]) parts.region = m[3].toUpperCase();
  return parts;
}

const join = (p: Parts) => [p.language, p.script, p.region].filter(Boolean).join("-");

export function getCanonicalLocales(locales?: string | ReadonlyArray<string>): string[] {
  if (locales === undefined) return [];
  const tags = typeof locales === "string" ? [locales] : locales;
  return [...new Set(tags.map((tag) => {
    const p = parse(tag);
    return join(p) + p.rest;
  }))];
}

const LIKELY: Record<string, string> = {
  en: "Latn-US", es: "Latn-ES", fr: "Latn-FR", de: "Latn-DE", pt: "Latn-BR", sv: "Latn-SE",
  ru: "Cyrl-RU", ja: "Jpan-JP", ko: "Kore-KR", zh: "Hans-CN", it: "Latn-IT", nl: "Latn-NL",
};

export class Locale {
  readonly language: string;
  readonly script?: string;
  readonly region?: string;
  readonly baseName: string;
  readonly #rest: string;
  constructor(tag: string | Locale, options: { language?: string | undefined; script?: string | undefined; region?: string | undefined } = {}) {
    const p = parse(String(tag));
    if (options.language) p.language = options.language.toLowerCase();
    if (options.script) p.script = options.script[0]!.toUpperCase() + options.script.slice(1).toLowerCase();
    if (options.region) p.region = options.region.toUpperCase();
    this.language = p.language;
    if (p.script) this.script = p.script;
    if (p.region) this.region = p.region;
    this.baseName = join(p);
    this.#rest = p.rest;
  }
  maximize(): Locale {
    const [script, region] = (LIKELY[this.language] ?? "").split("-");
    return new Locale(this.baseName, { script: this.script ?? script, region: this.region ?? region });
  }
  minimize(): Locale {
    return new Locale(this.language);
  }
  toString(): string {
    return this.baseName + this.#rest;
  }
}

const NAMES = {
  language: {
    en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", "pt-BR": "Brazilian Portuguese",
    "pt-PT": "European Portuguese", sv: "Swedish", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese",
    "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese", it: "Italian", nl: "Dutch", pl: "Polish",
    tr: "Turkish", uk: "Ukrainian", ar: "Arabic", he: "Hebrew", hi: "Hindi", id: "Indonesian", vi: "Vietnamese",
    th: "Thai", cs: "Czech", da: "Danish", fi: "Finnish", no: "Norwegian", nb: "Norwegian Bokmål", el: "Greek",
    hu: "Hungarian", ro: "Romanian", ca: "Catalan", ms: "Malay", fa: "Persian", bn: "Bangla", ta: "Tamil",
    "en-US": "American English", "en-GB": "British English", "es-419": "Latin American Spanish",
  },
  region: {
    US: "United States", GB: "United Kingdom", BR: "Brazil", PT: "Portugal", ES: "Spain", MX: "Mexico",
    FR: "France", DE: "Germany", SE: "Sweden", RU: "Russia", JP: "Japan", KR: "South Korea", CN: "China",
    TW: "Taiwan", HK: "Hong Kong", CA: "Canada", AU: "Australia", IN: "India", IT: "Italy", NL: "Netherlands",
    "419": "Latin America",
  },
  script: { Latn: "Latin", Cyrl: "Cyrillic", Hans: "Simplified Han", Hant: "Traditional Han", Jpan: "Japanese", Kore: "Korean", Arab: "Arabic" },
} as Record<string, Record<string, string>>;

type DisplayNamesType = "language" | "region" | "script";

export class DisplayNames {
  readonly #type: DisplayNamesType;
  readonly #fallback: "code" | "none";
  constructor(_locales: unknown, options: { type: DisplayNamesType; fallback?: "code" | "none" }) {
    if (!options || !(options.type in NAMES)) throw new TypeError("Intl.DisplayNames requires a valid type");
    this.#type = options.type;
    this.#fallback = options.fallback ?? "code";
  }
  of(code: string): string | undefined {
    const table = NAMES[this.#type]!;
    if (this.#type !== "language") return table[code] ?? table[code.toUpperCase()] ?? (this.#fallback === "code" ? code : undefined);
    const p = parse(code);
    const name = table[join(p)] ?? table[`${p.language}-${p.script}`];
    if (name) return name;
    const base = table[p.language];
    if (!base) return this.#fallback === "code" ? join(p) : undefined;
    const extra = [p.script && NAMES.script![p.script], p.region && NAMES.region![p.region]].filter(Boolean);
    return extra.length ? `${base} (${extra.join(", ")})` : base;
  }
  resolvedOptions() {
    return { locale: "en", style: "long", type: this.#type, fallback: this.#fallback };
  }
  static supportedLocalesOf(locales: string | string[]) {
    return getCanonicalLocales(locales).filter((l) => l.startsWith("en"));
  }
}

type Plural = "zero" | "one" | "two" | "few" | "many" | "other";
type Rule = (i: number, v: number, n: number) => Plural;

const millions = (i: number, v: number): Plural => (i !== 0 && i % 1e6 === 0 && v === 0 ? "many" : "other");
const oneInt: Rule = (i, v) => (i === 1 && v === 0 ? "one" : "other");
const other: Rule = () => "other";
const CARDINAL: Record<string, Rule> = {
  en: oneInt, de: oneInt, sv: oneInt, it: oneInt, nl: oneInt,
  "pt-PT": (i, v) => (i === 1 && v === 0 ? "one" : millions(i, v)),
  es: (i, v, n) => (n === 1 ? "one" : millions(i, v)),
  fr: (i, v) => (i <= 1 ? "one" : millions(i, v)),
  pt: (i, v) => (i <= 1 ? "one" : millions(i, v)),
  ru: (i, v) => {
    if (v !== 0) return "other";
    const d = i % 10, h = i % 100;
    return d === 1 && h !== 11 ? "one" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "few" : "many";
  },
  ja: other, ko: other, zh: other,
};
const ORDINAL: Record<string, Rule> = {
  en: (_i, _v, n) => {
    const d = n % 10, h = n % 100;
    return d === 1 && h !== 11 ? "one" : d === 2 && h !== 12 ? "two" : d === 3 && h !== 13 ? "few" : "other";
  },
  fr: (_i, _v, n) => (n === 1 ? "one" : "other"),
  sv: (_i, _v, n) => ((n % 10 === 1 || n % 10 === 2) && n % 100 !== 11 && n % 100 !== 12 ? "one" : "other"),
};
const ORDER: Plural[] = ["zero", "one", "two", "few", "many", "other"];
const SAMPLES = [0, 1, 2, 3, 5, 11, 21, 1e6, 1.5];

export class PluralRules {
  readonly #locale: string;
  readonly #type: "cardinal" | "ordinal";
  readonly #rule: Rule;
  constructor(locales?: string | string[], options: { type?: "cardinal" | "ordinal" } = {}) {
    const p = parse(getCanonicalLocales(locales ?? "en")[0] ?? "en");
    this.#type = options.type ?? "cardinal";
    const table = this.#type === "ordinal" ? ORDINAL : CARDINAL;
    this.#locale = join(p);
    this.#rule = table[`${p.language}-${p.region}`] ?? table[p.language] ?? (this.#type === "ordinal" ? other : oneInt);
  }
  select(value: number): Plural {
    const n = Math.abs(Number(value));
    if (!Number.isFinite(n)) return "other";
    const fraction = String(n).split(".")[1] ?? "";
    return this.#rule(Math.trunc(n), fraction.length, n);
  }
  resolvedOptions() {
    const found = new Set(SAMPLES.map((n) => this.select(n)));
    return {
      locale: this.#locale,
      type: this.#type,
      pluralCategories: ORDER.filter((c) => found.has(c)),
      minimumIntegerDigits: 1,
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    };
  }
  static supportedLocalesOf(locales: string | string[]) {
    return getCanonicalLocales(locales);
  }
}

/** Installs each fallback only where the runtime's Intl lacks it. */
export function installIntlPolyfills(intl: Record<string, unknown> = Intl as never): void {
  const fallbacks = { getCanonicalLocales, Locale, DisplayNames, PluralRules };
  for (const [name, impl] of Object.entries(fallbacks)) {
    if (typeof intl[name] !== "function") Object.defineProperty(intl, name, { value: impl, writable: true, configurable: true });
  }
}
