import { PIERRE_PALETTE } from "./palette.ts";
import { TOKEN_COUNT, TOKEN_NAMES } from "./tokens.ts";

export interface ZedSyntaxStyle {
  readonly color?: string;
  readonly font_style?: string;
  readonly font_weight?: number;
}

export interface ZedTheme {
  readonly name: string;
  readonly appearance: string;
  readonly style: {
    readonly syntax?: Readonly<Record<string, string | ZedSyntaxStyle>>;
  } & Readonly<Record<string, unknown>>;
}

export interface ZedThemeFamily {
  readonly name?: string;
  readonly themes: ReadonlyArray<ZedTheme>;
}

export interface TextMateTheme {
  readonly name?: string;
  readonly type?: string;
  readonly colors?: Readonly<Record<string, string>>;
  readonly tokenColors?: ReadonlyArray<{
    readonly scope?: string | ReadonlyArray<string>;
    readonly settings: { readonly foreground?: string; readonly fontStyle?: string };
  }>;
}

/** Shiki font-style bits: italic 1, bold 2, underline 4, strikethrough 8. */
export type TokenStyle = readonly [color: string, fontStyle: number];

export interface ResolvedSyntaxTheme {
  readonly name: string;
  readonly type: "light" | "dark";
  readonly fg: string;
  readonly bg: string;
  /** One entry per token ID. */
  readonly styles: ReadonlyArray<TokenStyle>;
  /** The 16 SGR colors, black through bright white. */
  readonly ansi: ReadonlyArray<string>;
  readonly zed?: ZedTheme;
}

export type ThemeInput = string | ZedTheme | ZedThemeFamily | TextMateTheme | ResolvedSyntaxTheme;

export const DEFAULT_THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;
const READABLE_LIGHT_THEME_NAME = "t3-light";

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright_black",
  "bright_red",
  "bright_green",
  "bright_yellow",
  "bright_blue",
  "bright_magenta",
  "bright_cyan",
  "bright_white",
];
// VS Code's terminal palette, used where a theme leaves a color out.
const ANSI_DEFAULTS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

/** Lowercase `#rrggbb[aa]`, or undefined for anything that is not a hex color. */
function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let color = value.trim().toLowerCase();
  if (color.charCodeAt(0) !== 35 || ![4, 5, 7, 9].includes(color.length)) return undefined;
  for (let i = 1; i < color.length; i++) {
    const c = color.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return undefined;
  }
  if (color.length <= 5) {
    let long = "#";
    for (let i = 1; i < color.length; i++) long += color[i]! + color[i]!;
    color = long;
  }
  if (color.length === 9 && color.endsWith("ff")) color = color.slice(0, 7);
  return color === "#00000000" ? undefined : color;
}

// Zed resolution: the nearest scope with a color wins; the nearest scope's font settings stick.
function resolveZedSyntax(
  syntax: Readonly<Record<string, string | ZedSyntaxStyle>>,
  name: string,
): ZedSyntaxStyle | undefined {
  let settings: ZedSyntaxStyle | undefined;
  for (let key = name; key !== "";) {
    const value = syntax[key];
    if (typeof value === "string") return { ...settings, color: value };
    if (value != null && typeof value === "object") {
      settings ??= value;
      if (value.color != null) return { ...settings, color: value.color };
    }
    const dot = key.lastIndexOf(".");
    key = dot < 0 ? "" : key.slice(0, dot);
  }
  return settings;
}

function fontBits(style: ZedSyntaxStyle | undefined): number {
  return (style?.font_style === "italic" ? 1 : 0) | ((style?.font_weight ?? 0) >= 550 ? 2 : 0);
}

function ansiColors(style: Readonly<Record<string, unknown>>): string[] {
  return ANSI_NAMES.map(
    (name, i) => normalizeColor(style[`terminal.ansi.${name}`]) ?? ANSI_DEFAULTS[i]!,
  );
}

function appearance(value: string | undefined, bg: string): "light" | "dark" {
  if (value === "light" || value === "dark") return value;
  return relativeLuminance(hexRgb(bg) ?? [0, 0, 0]) > 0.5 ? "light" : "dark";
}

function compileZedTheme(theme: ZedTheme, name = theme.name): ResolvedSyntaxTheme {
  const style = theme.style;
  const fg =
    normalizeColor(style["editor.foreground"] ?? style.text ?? style.foreground) ?? "#000000";
  const bg = normalizeColor(style["editor.background"] ?? style.background) ?? "#ffffff";
  const syntax = style.syntax ?? {};
  const styles: TokenStyle[] = [[fg, 0]];
  for (let id = 1; id < TOKEN_COUNT; id++) {
    const tokenName = TOKEN_NAMES[id]!;
    if (tokenName === "background" || tokenName === "foreground") {
      styles.push([fg, 0]);
      continue;
    }
    const resolved = resolveZedSyntax(syntax, tokenName);
    styles.push([normalizeColor(resolved?.color) ?? fg, fontBits(resolved)]);
  }
  return {
    name,
    type: appearance(theme.appearance, bg),
    fg,
    bg,
    styles,
    ansi: ansiColors(style),
    zed: theme,
  };
}

// TextMate scopes to try for each token, most specific first. Tokens without
// a match inherit their parent token's style (`keyword.control` → `keyword`).
const TEXTMATE_SCOPES: Readonly<Record<string, ReadonlyArray<string>>> = {
  attribute: ["entity.other.attribute-name", "meta.decorator"],
  "attribute.jsx": ["entity.other.attribute-name.jsx"],
  boolean: ["constant.language.boolean", "constant.language"],
  comment: ["comment"],
  "comment.doc": ["comment.block.documentation"],
  constant: ["variable.other.constant", "constant"],
  "constant.builtin": ["constant.language", "support.constant"],
  constructor: ["entity.name.function.constructor", "entity.name.type.class"],
  "diff.minus": ["markup.deleted"],
  "diff.plus": ["markup.inserted"],
  emphasis: ["markup.italic"],
  "emphasis.strong": ["markup.bold"],
  function: ["entity.name.function", "support.function"],
  "function.method": ["entity.name.function.member"],
  keyword: ["keyword", "storage"],
  "keyword.control": ["keyword.control"],
  "keyword.declaration": ["storage.type", "storage"],
  "keyword.import": ["keyword.control.import"],
  "keyword.operator": ["keyword.operator.expression", "keyword.operator"],
  label: ["entity.name.label"],
  namespace: ["entity.name.namespace", "entity.name.type.module"],
  number: ["constant.numeric"],
  operator: ["keyword.operator"],
  preproc: ["meta.preprocessor", "keyword.control.directive"],
  property: [
    "variable.other.property",
    "variable.other.object.property",
    "support.variable.property",
  ],
  "property.json_key": ["support.type.property-name.json", "support.type.property-name"],
  punctuation: ["punctuation"],
  "punctuation.bracket": ["punctuation.section", "meta.brace"],
  "punctuation.bracket.html": ["punctuation.definition.tag"],
  "punctuation.bracket.jsx": ["punctuation.definition.tag"],
  "punctuation.delimiter": ["punctuation.separator", "punctuation.terminator"],
  "punctuation.list_marker": ["punctuation.definition.list.begin.markdown", "markup.list"],
  "punctuation.markup": ["punctuation.definition.quote", "markup.quote"],
  "punctuation.special": [
    "punctuation.definition.template-expression",
    "punctuation.section.embedded",
  ],
  selector: ["entity.name.tag.css"],
  "selector.class": ["entity.other.attribute-name.class"],
  "selector.id": ["entity.other.attribute-name.id"],
  "selector.pseudo": ["entity.other.attribute-name.pseudo-class"],
  string: ["string"],
  "string.escape": ["constant.character.escape"],
  "string.regex": ["string.regexp"],
  "string.special": ["constant.character.entity", "string.other"],
  "string.special.symbol": ["constant.other.symbol"],
  tag: ["entity.name.tag"],
  "tag.doctype": ["meta.tag.metadata.doctype"],
  "tag.component.jsx": ["support.class.component"],
  "text.literal": ["markup.inline.raw", "markup.raw"],
  title: ["markup.heading", "entity.name.section"],
  type: ["entity.name.type", "support.type"],
  "type.builtin": ["support.type.primitive", "support.type"],
  "type.class": ["entity.name.type.class", "entity.name.class"],
  variable: ["variable.other.readwrite", "variable"],
  "variable.parameter": ["variable.parameter"],
  "variable.special": ["variable.language"],
  enum: ["entity.name.type.enum"],
  hint: ["comment"],
  "keyword.jsdoc": ["storage.type.class.jsdoc"],
  link_text: ["string.other.link.title", "markup.underline.link"],
  link_uri: ["markup.underline.link"],
  "type.jsdoc": ["entity.name.type.instance.jsdoc"],
  "variable.jsdoc": ["variable.other.jsdoc"],
  variant: ["variable.other.enummember", "constant.other.enum"],
};

interface TextMateRule {
  readonly selector: string;
  readonly order: number;
  readonly foreground?: string | undefined;
  readonly fontStyle?: number | undefined;
}

function textMateFontBits(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  let bits = 0;
  for (const part of value.split(" ")) {
    if (part === "italic") bits |= 1;
    else if (part === "bold") bits |= 2;
    else if (part === "underline") bits |= 4;
    else if (part === "strikethrough") bits |= 8;
  }
  return bits;
}

export function compileTextMateTheme(
  theme: TextMateTheme,
  name = theme.name ?? "textmate",
): ResolvedSyntaxTheme {
  const rules: TextMateRule[] = [];
  let globalFg: string | undefined;
  let order = 0;
  for (const { scope, settings } of theme.tokenColors ?? []) {
    const foreground = normalizeColor(settings.foreground);
    const fontStyle = textMateFontBits(settings.fontStyle);
    if (scope == null) {
      globalFg ??= foreground;
      continue;
    }
    for (const entry of typeof scope === "string" ? scope.split(",") : scope) {
      // Descendant selectors (`a b`) match by their last scope.
      const parts = entry.trim().split(" ");
      const selector = parts[parts.length - 1]!;
      if (selector !== "") rules.push({ selector, order: order++, foreground, fontStyle });
    }
  }
  const fg = normalizeColor(theme.colors?.["editor.foreground"]) ?? globalFg ?? "#000000";
  const bg = normalizeColor(theme.colors?.["editor.background"]) ?? "#ffffff";
  const memo = new Map<string, TokenStyle>();
  const styleFor = (tokenName: string): TokenStyle => {
    const cached = memo.get(tokenName);
    if (cached) return cached;
    let best: TextMateRule | undefined;
    let fontRule: TextMateRule | undefined;
    for (const scope of TEXTMATE_SCOPES[tokenName] ?? []) {
      for (const rule of rules) {
        if (scope !== rule.selector && !scope.startsWith(`${rule.selector}.`)) continue;
        const better = (current: TextMateRule | undefined) =>
          !current ||
          rule.selector.length > current.selector.length ||
          (rule.selector.length === current.selector.length && rule.order > current.order);
        if (rule.foreground && better(best)) best = rule;
        if (rule.fontStyle != null && better(fontRule)) fontRule = rule;
      }
      if (best) break;
    }
    const dot = tokenName.lastIndexOf(".");
    const parent: TokenStyle = dot > 0 ? styleFor(tokenName.slice(0, dot)) : [fg, 0];
    const style: TokenStyle = [best?.foreground ?? parent[0], fontRule?.fontStyle ?? parent[1]];
    memo.set(tokenName, style);
    return style;
  };
  const styles: TokenStyle[] = [[fg, 0]];
  for (let id = 1; id < TOKEN_COUNT; id++) {
    const tokenName = TOKEN_NAMES[id]!;
    styles.push(
      tokenName === "background" || tokenName === "foreground" ? [fg, 0] : styleFor(tokenName),
    );
  }
  const ansi = ANSI_NAMES.map((ansiName, i) => {
    const key = ansiName
      .split("_")
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join("");
    return normalizeColor(theme.colors?.[`terminal.ansi${key}`]) ?? ANSI_DEFAULTS[i]!;
  });
  return { name, type: appearance(theme.type, bg), fg, bg, styles, ansi };
}

function hexRgb(color: string): [number, number, number] | undefined {
  const hex = normalizeColor(color);
  if (!hex) return undefined;
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

const MIN_CONTRAST = 4.5;
// The darkest light code surface is a changed word on a deleted line (#f8d3d4,
// luminance 0.71), rounded down for margin.
const DARKEST_SURFACE_LUMINANCE = 0.69;

/** Contrast of a color against the darkest light code surface. */
export function contrastOnLightCode(color: string): number {
  const rgb = hexRgb(color);
  return rgb ? (DARKEST_SURFACE_LUMINANCE + 0.05) / (relativeLuminance(rgb) + 0.05) : 0;
}

/** Darkens a #rrggbb(aa) color in hue-keeping steps until it reads on light code. */
export function readableOnLightCode(color: string, minContrast = MIN_CONTRAST): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return color;
  let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  const contrast = () => (DARKEST_SURFACE_LUMINANCE + 0.05) / (relativeLuminance(rgb) + 0.05);
  if (contrast() >= minContrast) return color;
  while (contrast() < minContrast) {
    rgb = rgb.map((channel) => Math.floor(channel * 0.96)) as [number, number, number];
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
}

// Pairs that differ only in lightness would merge at one floor. The darker of
// each pair goes further, keeping pierre-light's order: numbers darker than
// operators, punctuation darker than comments, decorators darker than properties.
const FURTHER_COLORS = new Set(["#1ca1c7", "#636363", "#1a85d4"]);
const FURTHER_MIN_CONTRAST = 6;

/** The t3-light color for a pierre-light syntax color. */
export function readableSyntaxColor(color: string): string {
  return readableOnLightCode(
    color,
    FURTHER_COLORS.has(color.toLowerCase()) ? FURTHER_MIN_CONTRAST : MIN_CONTRAST,
  );
}

function pierreTheme(name: string, column: 1 | 2, readable = false): ZedTheme {
  const style: Record<string, unknown> = {};
  const syntax: Record<string, ZedSyntaxStyle> = {};
  for (const row of PIERRE_PALETTE) {
    const raw = row[column];
    const font = row[3];
    if (row[0].startsWith("syntax:")) {
      const color = raw === "" ? undefined : readable ? readableSyntaxColor(raw) : raw;
      syntax[row[0].slice(7)] = { ...font, ...(color ? { color } : {}) };
    } else style[row[0]] = raw;
  }
  return { name, appearance: column === 1 ? "dark" : "light", style: { ...style, syntax } };
}

const BUILT_IN_THEMES: Readonly<Record<string, () => ZedTheme>> = {
  "pierre-dark": () => pierreTheme("pierre-dark", 1),
  "pierre-light": () => pierreTheme("pierre-light", 2),
  [READABLE_LIGHT_THEME_NAME]: () => pierreTheme(READABLE_LIGHT_THEME_NAME, 2, true),
};

type ThemeLoader = () => ThemeInput | Promise<ThemeInput>;
const customLoaders = new Map<string, ThemeLoader>();
const resolvedThemes = new Map<string, ResolvedSyntaxTheme>();
const pendingThemes = new Map<string, Promise<ResolvedSyntaxTheme>>();
const objectThemes = new WeakMap<object, ResolvedSyntaxTheme>();

/** Registers a named theme; the loader may return any `ThemeInput` (Zed, TextMate, resolved). */
export function registerCustomTheme(
  name: string,
  loader: ThemeLoader | Exclude<ThemeInput, string>,
): void {
  customLoaders.set(name, typeof loader === "function" ? loader : () => loader);
  resolvedThemes.delete(name);
  pendingThemes.delete(name);
}

function compile(input: Exclude<ThemeInput, string>, name?: string): ResolvedSyntaxTheme {
  if ("styles" in input && Array.isArray(input.styles)) {
    return name && input.name !== name ? { ...input, name } : input;
  }
  if ("themes" in input && Array.isArray(input.themes)) {
    const first = input.themes[0];
    if (!first) throw new TypeError("invalid theme: empty theme family");
    return compileZedTheme(first, name);
  }
  if ("style" in input && input.style != null) return compileZedTheme(input as ZedTheme, name);
  if ("tokenColors" in input || "colors" in input) return compileTextMateTheme(input, name);
  throw new TypeError("invalid theme: expected a Zed theme, theme family, or TextMate theme");
}

/** Synchronously resolves a theme object or an already loaded/built-in name. */
export function resolveTheme(input: ThemeInput): ResolvedSyntaxTheme {
  if (typeof input !== "string") {
    let resolved = objectThemes.get(input);
    if (!resolved) objectThemes.set(input, (resolved = compile(input)));
    return resolved;
  }
  const cached = resolvedThemes.get(input);
  if (cached) return cached;
  const loader = customLoaders.get(input);
  if (loader) {
    const loaded = loader();
    if (loaded instanceof Promise) throw new Error(`theme ${input} is still loading`);
    const resolved = typeof loaded === "string" ? resolveTheme(loaded) : compile(loaded, input);
    resolvedThemes.set(input, resolved);
    return resolved;
  }
  const builtIn = BUILT_IN_THEMES[input];
  if (!builtIn) throw new Error(`unknown theme: ${input}`);
  const resolved = compileZedTheme(builtIn(), input);
  resolvedThemes.set(input, resolved);
  return resolved;
}

/** A loaded theme synchronously, otherwise a promise for its async loader. */
export function getResolvedOrResolveTheme(
  name: string,
): ResolvedSyntaxTheme | Promise<ResolvedSyntaxTheme> {
  const cached = resolvedThemes.get(name);
  if (cached) return cached;
  const loader = customLoaders.get(name);
  if (!loader) return resolveTheme(name);
  let pending = pendingThemes.get(name);
  if (!pending) {
    pending = Promise.resolve(loader()).then((loaded) => {
      const resolved = typeof loaded === "string" ? resolveTheme(loaded) : compile(loaded, name);
      resolvedThemes.set(name, resolved);
      pendingThemes.delete(name);
      return resolved;
    });
    pendingThemes.set(name, pending);
  }
  return pending;
}
