import { ANSI_RESET, ansiLine, type AnsiState } from "./ansi.ts";
import { getLexer } from "./grammars.ts";
import { resolveLanguage } from "./languages.ts";
import { initialState, Records, Scanner, scanLine, stateEquals, type LexerState } from "./lexer.ts";
import {
  getResolvedOrResolveTheme,
  resolveTheme,
  type ResolvedSyntaxTheme,
  type ThemeInput,
} from "./themes.ts";
import { LINE_END, TOKEN_COUNT, TOKEN_NAMES } from "./tokens.ts";

export { LINE_END, TOKEN_NAMES, type TokenName } from "./tokens.ts";
export {
  compileTextMateTheme,
  contrastOnLightCode,
  DEFAULT_THEMES,
  getResolvedOrResolveTheme,
  readableOnLightCode,
  readableSyntaxColor,
  registerCustomTheme,
  resolveTheme,
  type ResolvedSyntaxTheme,
  type TextMateTheme,
  type ThemeInput,
  type TokenStyle,
  type ZedTheme,
  type ZedThemeFamily,
} from "./themes.ts";
export {
  getFiletypeFromFileName,
  isKnownLanguage,
  resolveLanguage,
  setCustomExtension,
} from "./languages.ts";
export { stateEquals, type LexerState } from "./lexer.ts";

/** Lines longer than this render as one plain token (they still advance lexer state). */
const DEFAULT_MAX_LINE_LENGTH = 1_000;

function lexerFor(language: string) {
  return getLexer(resolveLanguage(language)) ?? getLexer("text")!;
}

/** The state before the first line of a document in `language`. */
export function getInitialState(language: string): LexerState {
  return initialState(lexerFor(language));
}

const lineRecords = new Records();
const lineScanner = new Scanner(lineRecords);

/** Tokenizes one line (no line break) into line-relative `(end, tokenId)` pairs. */
export function tokenizeLine(
  line: string,
  state: LexerState,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH,
): { readonly pairs: Uint32Array; readonly endState: LexerState } {
  lineRecords.len = 0;
  const endState = scanLine(lineScanner, line, 0, state, maxLineLength);
  return { pairs: lineRecords.finish(), endState };
}

/** End of the line starting at `start`, excluding a `\r\n` or `\n` break. */
function lineEnd(code: string, start: number): [end: number, next: number] {
  const newline = code.indexOf("\n", start);
  if (newline < 0) return [code.length, -1];
  return [
    newline > start && code.charCodeAt(newline - 1) === 13 ? newline - 1 : newline,
    newline + 1,
  ];
}

/**
 * Tokenizes a document into absolute `(endUtf16, tokenId)` records with one
 * `(nextLineStart, LINE_END)` record between lines.
 */
export function tokenizeRecords(
  code: string,
  language: string,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH,
): Uint32Array {
  const out = new Records();
  if (code.length > 128) out.buf = new Uint32Array(Math.min(code.length >> 1, 1 << 22));
  const scanner = new Scanner(out);
  let state = getInitialState(language);
  for (let start = 0; ;) {
    const [end, next] = lineEnd(code, start);
    state = scanLine(scanner, code.slice(start, end), start, state, maxLineLength);
    if (next < 0) break;
    out.push(next, LINE_END);
    start = next;
  }
  return out.finish();
}

/** A Shiki-compatible styled run. */
export interface ThemedToken {
  content: string;
  offset: number;
  color?: string;
  bgColor?: string;
  /** italic 1, bold 2, underline 4, strikethrough 8. */
  fontStyle?: number;
  htmlStyle?: Record<string, string>;
  htmlAttrs?: Record<string, string>;
  /** 1 comment, 2 string, 3 regex. */
  type?: number;
}

export interface TokensResult {
  tokens: ThemedToken[][];
  fg?: string;
  bg?: string;
  themeName?: string;
  rootStyle?: string | false;
}

export interface CodeToTokensOptions {
  readonly lang: string;
  readonly theme?: ThemeInput;
  /** Named themes rendered with CSS custom properties, such as `{ light, dark }`. */
  readonly themes?: Readonly<Record<string, ThemeInput>>;
  /** The `themes` key colored inline. Defaults to `light`; `false` uses variables only. */
  readonly defaultColor?: string | false;
  readonly cssVariablePrefix?: string;
  readonly tokenizeMaxLineLength?: number;
  readonly maxLineLength?: number;
}

const STANDARD_TYPES = new Uint8Array(TOKEN_COUNT);
for (let id = 0; id < TOKEN_COUNT; id++) {
  const name = TOKEN_NAMES[id]!;
  STANDARD_TYPES[id] =
    name === "string.regex"
      ? 3
      : name.startsWith("comment")
        ? 1
        : name.startsWith("string")
          ? 2
          : 0;
}

interface Palette {
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly theme: ResolvedSyntaxTheme;
  /** One `htmlStyle` per token for multi-theme output. */
  readonly htmlStyles?: ReadonlyArray<Record<string, string>>;
  readonly rootStyle?: string;
}

const paletteCache = new Map<string, Palette>();

function palette(options: CodeToTokensOptions): Palette {
  if (!options.themes) {
    const theme = resolveTheme(options.theme ?? "pierre-dark");
    return { name: theme.name, fg: theme.fg, bg: theme.bg, theme };
  }
  const prefix = options.cssVariablePrefix ?? "--hls-";
  const defaultColor = options.defaultColor ?? "light";
  const entries = Object.entries(options.themes).map(
    ([key, input]) => [key, resolveTheme(input)] as const,
  );
  const cacheKey = `${prefix}|${defaultColor}|${entries.map(([key, theme]) => `${key}=${theme.name}`).join(",")}`;
  const cached = paletteCache.get(cacheKey);
  if (cached) return cached;
  const inline = entries.find(([key]) => key === defaultColor)?.[1];
  const others = entries.filter(([key]) => key !== defaultColor);
  const htmlStyles = Array.from({ length: TOKEN_COUNT }, (_, id) => {
    const style: Record<string, string> = {};
    if (inline) {
      const [color, font] = inline.styles[id]!;
      style.color = color;
      if (font & 1) style["font-style"] = "italic";
      if (font & 2) style["font-weight"] = "bold";
    }
    for (const [key, theme] of others) {
      const [color, font] = theme.styles[id]!;
      style[`${prefix}${key}`] = color;
      if (font & 1) style[`${prefix}${key}-font-style`] = "italic";
      if (font & 2) style[`${prefix}${key}-font-weight`] = "bold";
    }
    return style;
  });
  const declarations = (field: "fg" | "bg") =>
    [
      ...(inline ? [inline[field]] : []),
      ...others.map(
        ([key, theme]) => `${prefix}${key}${field === "bg" ? "-bg" : ""}:${theme[field]}`,
      ),
    ].join(";");
  const base = inline ?? entries[0]![1];
  const result: Palette = {
    name: `highlights-themes ${entries.map(([, theme]) => theme.name).join(" ")}`,
    fg: declarations("fg"),
    bg: declarations("bg"),
    theme: base,
    htmlStyles,
    ...(inline ? {} : { rootStyle: `${declarations("fg")};${declarations("bg")}` }),
  };
  paletteCache.set(cacheKey, result);
  return result;
}

function themedToken(content: string, offset: number, token: number, colors: Palette): ThemedToken {
  const result: ThemedToken = { content, offset };
  if (colors.htmlStyles) result.htmlStyle = colors.htmlStyles[token]!;
  else {
    const [color, fontStyle] = colors.theme.styles[token]!;
    result.color = color;
    result.fontStyle = fontStyle;
  }
  const type = STANDARD_TYPES[token]!;
  if (type !== 0) result.type = type;
  return result;
}

/** Themed tokens for one line from line-relative pairs. */
function pairsToTokens(
  line: string,
  pairs: Uint32Array,
  base: number,
  colors: Palette,
): ThemedToken[] {
  const tokens: ThemedToken[] = [];
  let start = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const end = pairs[i]!;
    if (end <= start) continue;
    tokens.push(themedToken(line.slice(start, end), base + start, pairs[i + 1]!, colors));
    start = end;
  }
  return tokens;
}

function ansiTokens(line: string, state: AnsiState, base: number, colors: Palette) {
  const { runs, state: next } = ansiLine(line, state, colors.theme);
  const tokens: ThemedToken[] = runs.map((run) => {
    const token: ThemedToken = {
      content: run.content,
      offset: base + run.offset,
      color: run.color ?? colors.theme.fg,
    };
    if (run.bgColor) token.bgColor = run.bgColor;
    token.fontStyle = run.fontStyle;
    return token;
  });
  return { tokens, state: next };
}

/** Incrementally tokenizes complete lines, keeping only the lexer state between them. */
class LineTokenizer {
  private state: LexerState;
  private ansi: AnsiState = ANSI_RESET;
  readonly isAnsi: boolean;
  readonly language: string;
  readonly colors: Palette;
  readonly maxLineLength: number;

  constructor(language: string, colors: Palette, maxLineLength: number) {
    this.language = language;
    this.colors = colors;
    this.maxLineLength = maxLineLength;
    this.isAnsi = language.trim().toLowerCase() === "ansi";
    this.state = getInitialState(language);
  }

  /** Tokens for `line`; `commit` advances the state past it. */
  line(line: string, base: number, commit: boolean): ThemedToken[] {
    if (this.isAnsi) {
      const { tokens, state } = ansiTokens(line, this.ansi, base, this.colors);
      if (commit) this.ansi = state;
      if (this.maxLineLength > 0 && line.length > this.maxLineLength) {
        return [
          {
            content: tokens.map((token) => token.content).join(""),
            offset: base,
            color: this.colors.theme.fg,
            fontStyle: 0,
          },
        ];
      }
      return tokens;
    }
    const { pairs, endState } = tokenizeLine(
      line,
      this.state,
      this.maxLineLength || Number.MAX_SAFE_INTEGER,
    );
    if (commit) this.state = endState;
    return pairsToTokens(line, pairs, base, this.colors);
  }

  copyFrom(other: LineTokenizer): void {
    this.state = other.state;
    this.ansi = other.ansi;
  }

  reset(): void {
    this.state = getInitialState(this.language);
    this.ansi = ANSI_RESET;
  }
}

function maxLength(options: CodeToTokensOptions): number {
  return options.tokenizeMaxLineLength ?? options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
}

/** Shiki-compatible tokens: one array per line, offsets into `code`. */
export function codeToTokens(code: string, options: CodeToTokensOptions): TokensResult {
  const colors = palette(options);
  const max = maxLength(options) || Number.MAX_SAFE_INTEGER;
  const tokens: ThemedToken[][] = [];
  if (options.lang.trim().toLowerCase() === "ansi") {
    const lines = new LineTokenizer(options.lang, colors, max);
    for (let start = 0; ;) {
      const [end, next] = lineEnd(code, start);
      tokens.push(lines.line(code.slice(start, end), start, true));
      if (next < 0) break;
      start = next;
    }
  } else {
    const records = tokenizeRecords(code, options.lang, max);
    let line: ThemedToken[] = [];
    let start = 0;
    for (let i = 0; i < records.length; i += 2) {
      const end = records[i]!;
      const token = records[i + 1]!;
      if (token === LINE_END) {
        tokens.push(line);
        line = [];
        start = end;
      } else if (end > start) {
        line.push(themedToken(code.slice(start, end), start, token, colors));
        start = end;
      }
    }
    tokens.push(line);
  }
  return {
    tokens,
    fg: colors.fg,
    bg: colors.bg,
    themeName: colors.name,
    ...(colors.rootStyle ? { rootStyle: colors.rootStyle } : {}),
  };
}

export interface HighlightedRun {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export interface CompactTokens {
  /** Retained UTF-16 source plus records and line indexes. */
  readonly byteLength: number;
  readonly lineCount: number;
  /** Styled runs for one line; plain text and over-long lines have a null color. */
  highlightLine(index: number, theme: ThemeInput): ReadonlyArray<HighlightedRun> | undefined;
}

/** Keeps records compact and expands only the lines a client displays. */
export function tokenizeCompact(
  code: string,
  language: string,
  options: { readonly maxLineLength?: number } = {},
): CompactTokens {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const name = resolveLanguage(language);
  const plain = name === "text" || name === "ansi";
  const records = plain ? null : tokenizeRecords(code, name, Number.MAX_SAFE_INTEGER);
  const offsets = [0];
  if (records) {
    for (let at = 1; at < records.length; at += 2)
      if (records[at] === LINE_END) offsets.push(at + 1);
  } else {
    for (let at = code.indexOf("\n"); at !== -1; at = code.indexOf("\n", at + 1))
      offsets.push(at + 1);
  }
  const lineStarts = Uint32Array.from(offsets);
  const ansiStates: AnsiState[] = [ANSI_RESET];
  return {
    byteLength: code.length * 2 + (records?.byteLength ?? 0) + lineStarts.byteLength,
    lineCount: lineStarts.length,
    highlightLine(index, themeInput) {
      if (index < 0 || index >= lineStarts.length) return undefined;
      const first = lineStarts[index]!;
      const next = lineStarts[index + 1];
      if (!records) {
        const end =
          next === undefined ? code.length : next - (code.charCodeAt(next - 2) === 13 ? 2 : 1);
        const content = code.slice(first, end);
        if (name !== "ansi" || content === "")
          return content ? [{ content, color: null, fontStyle: null }] : [];
        const theme = resolveTheme(themeInput);
        for (let line = ansiStates.length - 1; line < index; line++) {
          const lineEndAt = lineStarts[line + 1]! - 1;
          ansiStates.push(
            ansiLine(code.slice(lineStarts[line]!, lineEndAt), ansiStates[line]!, theme).state,
          );
        }
        return ansiLine(content, ansiStates[index]!, theme).runs.map((run) => ({
          content: run.content,
          color: run.color ?? null,
          fontStyle: run.fontStyle || null,
        }));
      }
      let start = first === 0 ? 0 : records[first - 2]!;
      const last = next === undefined ? records.length : next - 2;
      const end = last === first ? start : records[last - 2]!;
      if (end - start > maxLineLength)
        return [{ content: code.slice(start, end), color: null, fontStyle: null }];
      const styles = resolveTheme(themeInput).styles;
      const line: HighlightedRun[] = [];
      for (let at = first; at < last; at += 2) {
        const tokenEnd = records[at]!;
        if (tokenEnd <= start) continue;
        const [color, fontStyle] = styles[records[at + 1]!] ?? styles[0]!;
        line.push({ content: code.slice(start, tokenEnd), color, fontStyle });
        start = tokenEnd;
      }
      return line;
    },
  };
}

export interface HastText {
  type: "text";
  value: string;
}

export interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, string | number | undefined>;
  children: Array<HastElement | HastText>;
}

export interface HastRoot {
  type: "root";
  children: HastElement[];
}

/** CSS declarations for a token. */
function tokenStyle(token: ThemedToken): string {
  if (token.htmlStyle) {
    let style = "";
    for (const name in token.htmlStyle)
      style += `${style === "" ? "" : ";"}${name}:${token.htmlStyle[name]}`;
    return style;
  }
  let style = token.color != null ? `color:${token.color}` : "";
  if (token.bgColor != null) style += `${style ? ";" : ""}background-color:${token.bgColor}`;
  const font = token.fontStyle ?? 0;
  if (font & 1) style += `${style ? ";" : ""}font-style:italic`;
  if (font & 2) style += `${style ? ";" : ""}font-weight:bold`;
  if (font & 12) {
    const decorations = [font & 4 ? "underline" : "", font & 8 ? "line-through" : ""]
      .filter(Boolean)
      .join(" ");
    style += `${style ? ";" : ""}text-decoration:${decorations}`;
  }
  return style;
}

/** One `span.line` element per line of tokens. */
export function renderTokenLines(
  lines: ReadonlyArray<ReadonlyArray<ThemedToken>>,
  _options: object = {},
): HastElement[] {
  return lines.map((tokens) => ({
    type: "element",
    tagName: "span",
    properties: { class: "line" },
    children: tokens
      .filter((token) => token.content !== "")
      .map((token) => {
        const style = tokenStyle(token);
        return {
          type: "element",
          tagName: "span",
          properties: { ...token.htmlAttrs, ...(style ? { style } : {}) },
          children: [{ type: "text", value: token.content }],
        };
      }),
  }));
}

function preStyle(result: TokensResult): string | undefined {
  if (result.rootStyle === false) return undefined;
  return (
    result.rootStyle ??
    [result.bg ? `background-color:${result.bg}` : "", result.fg ? `color:${result.fg}` : ""]
      .filter(Boolean)
      .join(";")
  );
}

export function codeToHast(code: string, options: CodeToTokensOptions): HastRoot {
  const result = codeToTokens(code, options);
  const lines = renderTokenLines(result.tokens);
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: { class: "highlights", style: preStyle(result), tabindex: 0 },
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: lines.flatMap((line, index): Array<HastElement | HastText> =>
              index === 0 ? [line] : [{ type: "text", value: "\n" }, line],
            ),
          },
        ],
      },
    ],
  };
}

function escapeHtml(text: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const entity =
      c === 38
        ? "&amp;"
        : c === 60
          ? "&lt;"
          : c === 62
            ? "&gt;"
            : c === 34
              ? "&quot;"
              : c === 39
                ? "&#39;"
                : "";
    if (entity === "") continue;
    out += text.slice(last, i) + entity;
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Highlighted HTML: `<pre class="highlights"><code>` with one `span.line` per line. */
export function codeToHtml(code: string, options: CodeToTokensOptions): string {
  const result = codeToTokens(code, options);
  const style = preStyle(result);
  let html = `<pre class="highlights"${style ? ` style="${escapeHtml(style)}"` : ""} tabindex="0"><code>`;
  for (let line = 0; line < result.tokens.length; line++) {
    if (line > 0) html += "\n";
    html += '<span class="line">';
    for (const token of result.tokens[line]!) {
      const tokenCss = tokenStyle(token);
      html += tokenCss
        ? `<span style="${escapeHtml(tokenCss)}">${escapeHtml(token.content)}</span>`
        : `<span>${escapeHtml(token.content)}</span>`;
    }
    html += "</span>";
  }
  return `${html}</code></pre>`;
}

export interface StreamTokenizerUpdate {
  /** How many previously returned unstable tokens to remove. */
  readonly recall: number;
  readonly stable: ThemedToken[];
  readonly unstable: ThemedToken[];
}

export interface StreamTokenizer {
  enqueue(chunk: string): StreamTokenizerUpdate;
  close(): { stable: ThemedToken[] };
  clear(): void;
  clone(): StreamTokenizer;
  dispose(): void;
}

/**
 * Tokens for streamed text. Complete lines are stable; the final line stays
 * provisional until a line break. Every prefix tokenizes exactly as
 * `codeToTokens` would, with one extra token per line-break character.
 */
export function createStreamTokenizer(options: CodeToTokensOptions): StreamTokenizer {
  const colors = palette(options);
  const lines = new LineTokenizer(options.lang, colors, maxLength(options));
  return streamTokenizer(lines, { tail: "", tailOffset: 0, unstable: [] });
}

interface StreamState {
  tail: string;
  tailOffset: number;
  unstable: ThemedToken[];
}

function streamTokenizer(lines: LineTokenizer, state: StreamState): StreamTokenizer {
  let disposed = false;
  const assertActive = () => {
    if (disposed) throw new Error("stream tokenizer is disposed");
  };
  return {
    enqueue(chunk) {
      assertActive();
      const recall = state.unstable.length;
      const stable: ThemedToken[] = [];
      let text = state.tail + chunk;
      let offset = state.tailOffset;
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        const crlf = newline > 0 && text.charCodeAt(newline - 1) === 13;
        const end = crlf ? newline - 1 : newline;
        for (const token of lines.line(text.slice(0, end), offset, true)) stable.push(token);
        if (crlf) stable.push({ content: "\r", offset: offset + end });
        stable.push({ content: "\n", offset: offset + newline });
        offset += newline + 1;
        text = text.slice(newline + 1);
      }
      state.tail = text;
      state.tailOffset = offset;
      state.unstable = text === "" ? [] : lines.line(text, offset, false);
      return { recall, stable, unstable: state.unstable };
    },
    close() {
      const stable = state.unstable;
      this.dispose();
      return { stable };
    },
    clear() {
      assertActive();
      state.tail = "";
      state.tailOffset = 0;
      state.unstable = [];
      lines.reset();
    },
    clone() {
      assertActive();
      const copy = new LineTokenizer(lines.language, lines.colors, lines.maxLineLength);
      copy.copyFrom(lines);
      return streamTokenizer(copy, { ...state, unstable: state.unstable.slice() });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.unstable = [];
    },
  };
}

/** `[character, color, text]`, as in @pierre/diffs' editor. */
export type HighlightedToken = [char: number, fg: string, text: string];

export interface EditorTokenizerOptions {
  readonly lang: string;
  readonly theme: ThemeInput;
  readonly text?: string;
  readonly maxLineLength?: number;
}

export interface EditorTokenizer {
  readonly lineCount: number;
  setText(text: string): void;
  /**
   * Replaces `deleteCount` lines at `startLine` with `lines` and re-tokenizes
   * until lexer states converge. Returns the `[from, to)` lines whose tokens changed.
   */
  edit(
    startLine: number,
    deleteCount: number,
    lines: ReadonlyArray<string>,
  ): readonly [from: number, to: number];
  getLineText(line: number): string;
  /** Line-relative tokens. */
  getLineTokens(line: number): ThemedToken[];
  getHighlightedTokens(line: number): HighlightedToken[];
  /** String, comment, and regex ranges for bracket matching, or null when there are none. */
  getStringCommentRegexpRangesInLine(line: number): Array<[number, number]> | null;
  setTheme(theme: ThemeInput): void;
  dispose(): void;
}

export function createEditorTokenizer(options: EditorTokenizerOptions): EditorTokenizer {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const initial = getInitialState(options.lang);
  let colors = palette({ lang: options.lang, theme: options.theme });
  let lines: string[] = [""];
  // `starts[i]` is the state before line `i` (one past the last line too);
  // lines below `known` have cached pairs and trusted states.
  let starts: LexerState[] = [initial];
  let pairs: Uint32Array[] = [];
  let known = 0;

  const scan = (line: number) => {
    const result = tokenizeLine(lines[line]!, starts[line]!, maxLineLength);
    pairs[line] = result.pairs;
    starts[line + 1] = result.endState;
  };
  const ensure = (line: number) => {
    for (; known <= line && known < lines.length; known++) scan(known);
  };
  const setText = (text: string) => {
    lines = text.split(/\r?\n/u);
    starts = [initial];
    pairs = [];
    known = 0;
  };
  if (options.text !== undefined) setText(options.text);

  const tokensOf = (line: number): ThemedToken[] => {
    if (line < 0 || line >= lines.length) return [];
    ensure(line);
    return pairsToTokens(lines[line]!, pairs[line]!, 0, colors);
  };

  return {
    get lineCount() {
      return lines.length;
    },
    setText,
    edit(startLine, deleteCount, inserted) {
      const from = Math.max(0, Math.min(startLine, lines.length));
      ensure(from - 1);
      const oldStarts = starts;
      const oldPairs = pairs;
      const oldKnown = known;
      const shift = inserted.length - deleteCount;
      lines.splice(from, deleteCount, ...inserted);
      if (lines.length === 0) lines.push("");
      starts = oldStarts.slice(0, from + 1);
      pairs = oldPairs.slice(0, from);
      known = from;
      for (let line = from; line < lines.length; line++) {
        scan(line);
        known = line + 1;
        const next = line + 1;
        // Past the edit, an unchanged start state means every later line is unchanged too.
        if (
          next >= from + inserted.length &&
          next - shift <= oldKnown &&
          next < lines.length &&
          stateEquals(oldStarts[next - shift]!, starts[next]!)
        ) {
          for (let k = next; k - shift <= oldKnown; k++) {
            starts[k] = oldStarts[k - shift]!;
            if (k - shift < oldKnown) pairs[k] = oldPairs[k - shift]!;
          }
          known = oldKnown + shift;
          return [from, next] as const;
        }
      }
      return [from, lines.length] as const;
    },
    getLineText: (line) => lines[line] ?? "",
    getLineTokens: tokensOf,
    getHighlightedTokens(line) {
      return tokensOf(line).map((token) => [token.offset, token.color ?? colors.fg, token.content]);
    },
    getStringCommentRegexpRangesInLine(line) {
      if (line < 0 || line >= lines.length) return null;
      ensure(line);
      const linePairs = pairs[line]!;
      const ranges: Array<[number, number]> = [];
      let start = 0;
      for (let i = 0; i < linePairs.length; i += 2) {
        const end = linePairs[i]!;
        if (end > start && STANDARD_TYPES[linePairs[i + 1]!] !== 0) {
          const last = ranges[ranges.length - 1];
          if (last && last[1] === start) last[1] = end;
          else ranges.push([start, end]);
        }
        start = Math.max(start, end);
      }
      return ranges.length > 0 ? ranges : null;
    },
    setTheme(next) {
      colors = palette({ lang: options.lang, theme: next });
    },
    dispose() {
      setText("");
    },
  };
}

export interface Highlighter {
  readonly name: "highlights";
  readonly isDisposed: boolean;
  getTheme(name: string): ResolvedSyntaxTheme;
  codeToTokens(code: string, options: CodeToTokensOptions): TokensResult;
  codeToHtml(code: string, options: CodeToTokensOptions): string;
  codeToHast(code: string, options: CodeToTokensOptions): HastRoot;
  createStreamTokenizer(options: CodeToTokensOptions): StreamTokenizer;
  createEditorTokenizer(options: EditorTokenizerOptions): EditorTokenizer;
  /** Every grammar is bundled; these resolve immediately. */
  loadLanguages(languages: ReadonlyArray<string>): Promise<void>;
  hasLoadedLanguages(languages: ReadonlyArray<string>): boolean;
  attachLanguages(languages: ReadonlyArray<unknown>): void;
  dispose(): void;
}

let shared: Highlighter | undefined;

function createHighlighter(): Highlighter {
  let disposed = false;
  return {
    name: "highlights",
    get isDisposed() {
      return disposed;
    },
    getTheme: (name) => resolveTheme(name),
    codeToTokens,
    codeToHtml,
    codeToHast,
    createStreamTokenizer,
    createEditorTokenizer,
    loadLanguages: async () => {},
    hasLoadedLanguages: () => true,
    attachLanguages: () => {},
    dispose() {
      disposed = true;
      if (shared === this) shared = undefined;
    },
  };
}

export interface HighlighterOptions {
  readonly themes?: ReadonlyArray<string>;
  readonly langs?: ReadonlyArray<string>;
  readonly preferredHighlighter?: string;
}

/** The shared highlighter once its named themes have loaded. */
export async function getSharedHighlighter(options: HighlighterOptions = {}): Promise<Highlighter> {
  await Promise.all((options.themes ?? []).map((name) => getResolvedOrResolveTheme(name)));
  shared ??= createHighlighter();
  return shared;
}

export async function preloadHighlighter(options: HighlighterOptions = {}): Promise<void> {
  await getSharedHighlighter(options);
}

export async function disposeHighlighter(): Promise<void> {
  shared?.dispose();
  shared = undefined;
}
