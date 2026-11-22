/**
 * Zero-dependency i18n engine. English is the source text, so the default locale formats in
 * place and never hashes or looks anything up. Other locales read catalogs in the gt CLI's
 * format: keys are GT's source hashes, values are ICU strings or `<T>` JSX trees.
 */
import { bytesToHex, sha256 } from "../parsers/crypto.ts";

const UTF8_ENCODER = new TextEncoder();
const utf8ToBytes = (value: string): Uint8Array => UTF8_ENCODER.encode(value);

export const DEFAULT_LOCALE = "en";

export type TranslationOptions = Readonly<Record<string, unknown>> & {
  readonly $context?: string;
};
export type GTFunctionType = (message: string, options?: TranslationOptions) => string;
export type MFunctionType = <T extends string | null | undefined>(
  encodedMsg: T,
  options?: TranslationOptions,
) => T extends string ? string : T;
export type Catalog = Readonly<Record<string, unknown>>;

// ---- ICU: {var}, {n, plural, =0 {…} one {# …} other {…}}, {x, select, …}, '' and '{…}' quoting ----

const POUND = 0;
interface Arg {
  readonly name: string;
}
interface Choice extends Arg {
  readonly plural: boolean;
  readonly offset: number;
  readonly options: Readonly<Record<string, ReadonlyArray<Part>>>;
}
type Part = string | typeof POUND | Arg | Choice;

const SPACE = /\s/;
const IDENTIFIER_END = /[\s!-/:-@[-^`{-~]/;

function parse(src: string): ReadonlyArray<Part> {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`Malformed ICU message: ${src}`);
  };
  const skipSpace = () => {
    while (i < src.length && SPACE.test(src[i]!)) i++;
  };
  const identifier = () => {
    skipSpace();
    const start = i;
    while (i < src.length && !IDENTIFIER_END.test(src[i]!)) i++;
    return src.slice(start, i);
  };
  const expect = (char: string) => {
    skipSpace();
    if (src[i++] !== char) fail();
  };
  const message = (nested: boolean, inPlural: boolean): Part[] => {
    const parts: Part[] = [];
    let text = "";
    const flush = () => {
      if (text) parts.push(text);
      text = "";
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "'") {
        const next = src[i + 1];
        if (next === "'") {
          text += "'";
          i += 2;
        } else if (next !== undefined && ("{}<>".includes(next) || (next === "#" && inPlural))) {
          for (i++; i < src.length; ) {
            if (src[i] !== "'") text += src[i++];
            else if (src[i + 1] === "'") (text += "'"), (i += 2);
            else break;
          }
          i++;
        } else (text += c), i++;
      } else if (c === "{") {
        flush();
        parts.push(argument());
      } else if (c === "}" && nested) break;
      else if (c === "#" && inPlural) {
        flush();
        parts.push(POUND);
        i++;
      } else (text += c), i++;
    }
    flush();
    return parts;
  };
  const argument = (): Arg | Choice => {
    i++;
    const name = identifier() || fail();
    skipSpace();
    if (src[i] === "}") return i++, { name };
    expect(",");
    const type = identifier();
    if (type !== "plural" && type !== "select") {
      // number/date/time styles: unused in our catalogs, so they print the raw value.
      while (i < src.length && src[i] !== "}") i++;
      return i++, { name };
    }
    const plural = type === "plural";
    expect(",");
    let offset = 0;
    let selector = identifier();
    if (plural && selector === "offset") {
      expect(":");
      skipSpace();
      const start = i;
      while (/[-+\d]/.test(src[i] ?? "")) i++;
      offset = Number(src.slice(start, i));
      selector = identifier();
    }
    const options: Record<string, ReadonlyArray<Part>> = Object.create(null);
    for (;;) {
      if (!selector && plural && src[i] === "=") {
        const start = i++;
        while (/[-+\d]/.test(src[i] ?? "")) i++;
        selector = src.slice(start, i);
      }
      if (!selector) break;
      expect("{");
      options[selector] = message(true, plural);
      expect("}");
      selector = identifier();
    }
    expect("}");
    return { name, plural, offset, options };
  };
  return message(false, false);
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

export function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  if (locale === DEFAULT_LOCALE) return Math.abs(n) === 1 ? "one" : "other";
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules.select(n);
}

function formatNumber(locale: string, n: number): string {
  let format = numberFormats.get(locale);
  if (!format) numberFormats.set(locale, (format = new Intl.NumberFormat(locale)));
  return format.format(n);
}

function render(
  parts: ReadonlyArray<Part>,
  vars: TranslationOptions,
  locale: string,
  pound?: number,
): string {
  let out = "";
  for (const part of parts) {
    if (typeof part === "string") out += part;
    else if (part === POUND) out += pound === undefined ? "" : formatNumber(locale, pound);
    else {
      if (!(part.name in vars)) throw new Error(`Missing ICU variable "${part.name}"`);
      const value = vars[part.name];
      if (!("options" in part)) out += value == null ? "" : String(value);
      else if (!part.plural) {
        const branch = part.options[String(value)] ?? part.options.other;
        if (!branch) throw new Error(`No ICU branch for "${part.name}"`);
        out += render(branch, vars, locale);
      } else {
        const n = Number(value) - part.offset;
        const branch =
          part.options[`=${String(value)}`] ??
          part.options[pluralCategory(locale, n)] ??
          part.options.other;
        if (!branch) throw new Error(`No ICU branch for "${part.name}"`);
        out += render(branch, vars, locale, n);
      }
    }
  }
  return out;
}

const compiled = new Map<string, ReadonlyArray<Part>>();
const NO_VARS: TranslationOptions = {};

/** Formats an ICU message; throws on malformed syntax or a missing variable. */
export function formatICU(message: string, vars: TranslationOptions, locale: string): string {
  // Without braces or quotes the message is its own output.
  if (!message.includes("{") && !message.includes("'")) return message;
  let parts = compiled.get(message);
  if (!parts) compiled.set(message, (parts = parse(message)));
  return render(parts, vars, locale);
}

// ---- Catalog keys: GT's hashSource (sha256 of a key-sorted JSON payload, first 16 hex) ----

function stableStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const field = stableStringify(record[key]);
    if (field) fields.push(`${JSON.stringify(key)}:${field}`);
  }
  return `{${fields.join(",")}}`;
}

const keys = new Map<string, string>();

/** The catalog key for an ICU string or a sanitized `<T>` tree. Memoized: sources are finite. */
export function catalogKey(source: unknown, format: "ICU" | "JSX", context?: string): string {
  const payload = stableStringify({ source, dataFormat: format, ...(context && { context }) })!;
  let key = keys.get(payload);
  if (!key) keys.set(payload, (key = bytesToHex(sha256(utf8ToBytes(payload))).slice(0, 16)));
  return key;
}

// ---- msg(): `english:base64(json options)`, the wire format GT clients and servers share ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type EncodedOptions = TranslationOptions & {
  readonly $_source: string;
  readonly $_hash: string;
};

/** Marks a message for later translation; `useMessages()` / `m()` resolve it. */
export function msg(message: string, options?: TranslationOptions): string {
  if (!options) return message;
  let english: string;
  try {
    english = formatICU(message, options, DEFAULT_LOCALE);
  } catch {
    return message;
  }
  const encoded: EncodedOptions = {
    ...options,
    $_source: message,
    $_hash: catalogKey(message, "ICU", options.$context),
  };
  let binary = "";
  for (const byte of encoder.encode(JSON.stringify(encoded))) binary += String.fromCharCode(byte);
  const result = `${english}:${btoa(binary)}`;
  remember(result, encoded);
  return result;
}

type Options = Readonly<Record<string, unknown>>;
// msg() output is usually resolved right after it is made, so most decodes are memo hits.
const decoded = new Map<string, Options | null>();
const remember = (message: string, options: Options | null) => {
  if (decoded.size >= 1024) decoded.clear();
  decoded.set(message, options);
};

function parseOptions(base64: string): Options | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const options: unknown = JSON.parse(decoder.decode(bytes));
    return options && typeof options === "object" ? (options as Options) : null;
  } catch {
    return null;
  }
}

/** The options `msg()` encoded, or null for a plain string. */
export function decodeOptions(message: string): Options | null {
  const colon = message.lastIndexOf(":");
  // Encoded JSON objects always start `{"`, which is base64 `ey`.
  if (colon === -1 || !message.startsWith("ey", colon + 1)) return null;
  let options = decoded.get(message);
  if (options === undefined) remember(message, (options = parseOptions(message.slice(colon + 1))));
  return options;
}

function decodeEncoded(message: string): EncodedOptions | null {
  const options = decodeOptions(message);
  return typeof options?.$_source === "string" ? (options as EncodedOptions) : null;
}

/** The English text of a `msg()` string. */
export function decodeMsg<T>(message: T): T {
  if (typeof message !== "string") return message;
  const colon = message.lastIndexOf(":");
  return (colon === -1 ? message : message.slice(0, colon)) as T;
}

// ---- Locale state ----

export interface I18nState {
  readonly locale: string;
  /** null for English: the source text renders as-is. */
  readonly catalog: Catalog | null;
  readonly gt: GTFunctionType;
  readonly m: MFunctionType;
}

function formatSource(message: string, options: TranslationOptions = NO_VARS): string {
  try {
    return formatICU(message, options, DEFAULT_LOCALE);
  } catch {
    return message;
  }
}

function createState(locale: string, catalog: Catalog | null): I18nState {
  const gt: GTFunctionType = catalog
    ? (message, options = NO_VARS) => {
        const target = catalog[catalogKey(message, "ICU", options.$context)];
        if (typeof target === "string") {
          try {
            return formatICU(target, options, locale);
          } catch {}
        }
        // Untranslated text is English, so it takes English plural rules.
        return formatSource(message, options);
      }
    : formatSource;
  const m = ((message: string | null | undefined, options?: TranslationOptions) => {
    if (message == null) return message;
    const encoded = decodeEncoded(message);
    if (!encoded) return gt(message, options);
    // msg() already rendered the English.
    return catalog ? gt(encoded.$_source, encoded) : decodeMsg(message);
  }) as MFunctionType;
  return { locale, catalog, gt, m };
}

const ENGLISH = createState(DEFAULT_LOCALE, null);
let state = ENGLISH;
const listeners = new Set<() => void>();

/** English formatting, for code with no resolver handed in (logs, English comparisons). */
export const gtFallback: GTFunctionType = ENGLISH.gt;
export const mFallback: MFunctionType = ENGLISH.m;

export const getI18nState = (): I18nState => state;
export const getLocale = (): string => state.locale;

/** Activates `locale` with its loaded catalog; English needs none. */
export function setLocale(locale: string, catalog: Catalog = {}): void {
  if (locale === state.locale && (locale === DEFAULT_LOCALE || catalog === state.catalog)) return;
  state = locale === DEFAULT_LOCALE ? ENGLISH : createState(locale, catalog);
  for (const listener of listeners) listener();
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call-time resolvers in the active locale, for code outside React. */
export const gt: GTFunctionType = (message, options) => state.gt(message, options);
export const m = ((message, options) => state.m(message, options)) as MFunctionType;
