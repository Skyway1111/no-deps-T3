import {
  getFiletypeFromFileName,
  getInitialState,
  resolveTheme,
  stateEquals,
  tokenizeLine,
  type LexerState,
} from "@t3tools/shared/highlight";

/** Documents with more lines than this render as plain text. */
const DEFAULT_TOKENIZE_MAX_LENGTH = 100_000;
/** Longer lines render as one plain token (they still advance the lexer). */
const MAX_LINE_LENGTH = 1_000;
/** A request further than this past the scanned lines finishes in idle time instead. */
const SYNC_SCAN_LINES = 2_000;
const CACHE_SIZE = 240;

const idle: (callback: () => void) => void =
  typeof requestIdleCallback === "function"
    ? (callback) => requestIdleCallback(callback, { timeout: 200 })
    : (callback) => setTimeout(callback, 16);

/** Splits like the renderer breaks lines: at `\n`, `\r\n`, and a lone `\r`. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

export function languageOf(name: string, lang?: string): string {
  return lang ?? getFiletypeFromFileName(name);
}

/**
 * Per-line `(end, tokenId)` pairs, scanned lazily up to the lines asked for. An edit rescans
 * from its first line until the lexer state converges with the old one.
 */
export class LineTokens {
  readonly lines: string[];
  readonly plain: boolean;
  version = 0;
  private states: LexerState[];
  private pairs: Array<Uint32Array | undefined> = [];
  private known = 0;
  private carry: {
    readonly states: LexerState[];
    readonly pairs: Array<Uint32Array | undefined>;
    readonly known: number;
    readonly shift: number;
    readonly from: number;
  } | null = null;
  private target = 0;
  private scheduled = false;
  private readonly listeners = new Set<() => void>();

  constructor(lines: string[], language: string) {
    this.lines = lines;
    this.plain = language === "text" || lines.length > DEFAULT_TOKENIZE_MAX_LENGTH;
    this.states = [getInitialState(language)];
  }

  /** `undefined` renders the line plain: no grammar, or idle scanning has not reached it. */
  tokens(line: number): Uint32Array | undefined {
    if (this.plain || line >= this.lines.length) return undefined;
    if (line >= this.known) {
      if (line - this.known > SYNC_SCAN_LINES) {
        this.target = Math.max(this.target, line + 1);
        this.schedule();
        return undefined;
      }
      while (this.known <= line) this.scan(this.known);
    }
    return this.pairs[line];
  }

  edit(from: number, deleteCount: number, inserted: ReadonlyArray<string>): void {
    this.lines.splice(from, deleteCount, ...inserted);
    if (this.known > from) {
      this.carry = {
        states: this.states,
        pairs: this.pairs,
        known: this.known,
        shift: inserted.length - deleteCount,
        from: from + inserted.length,
      };
      this.states = this.states.slice(0, from + 1);
      this.pairs = this.pairs.slice(0, from);
      this.known = from;
    }
    this.version++;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private scan(line: number) {
    const { pairs, endState } = tokenizeLine(
      this.lines[line]!,
      this.states[line]!,
      MAX_LINE_LENGTH,
    );
    this.pairs[line] = pairs;
    this.states[line + 1] = endState;
    this.known = line + 1;
    const carry = this.carry;
    if (carry === null || line + 1 < carry.from) return;
    const old = line + 1 - carry.shift;
    if (old >= carry.known) {
      this.carry = null;
      return;
    }
    if (!stateEquals(carry.states[old]!, endState)) return;
    // Past the edit an unchanged start state means every later line is unchanged too.
    for (let at = line + 1, from = old; from < carry.known; at++, from++) {
      this.pairs[at] = carry.pairs[from];
      this.states[at + 1] = carry.states[from + 1]!;
    }
    this.known = carry.known + carry.shift;
    this.carry = null;
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    const step = () => {
      const deadline = performance.now() + 8;
      while (this.known < this.target && performance.now() < deadline) this.scan(this.known);
      if (this.known < this.target) return idle(step);
      this.scheduled = false;
      this.version++;
      for (const listener of this.listeners) listener();
    };
    idle(step);
  }
}

const cache = new Map<string, LineTokens>();
const uncached = new WeakMap<object, LineTokens>();

/**
 * Tokens shared by every view of the same content: by `cacheKey` (which names content), else by
 * the identity of the source the lines came from.
 */
export function tokensFor(
  cacheKey: string | undefined,
  source: object,
  language: string,
  getLines: () => string[],
): LineTokens {
  if (cacheKey === undefined) {
    let tokens = uncached.get(source);
    if (!tokens) uncached.set(source, (tokens = new LineTokens(getLines(), language)));
    return tokens;
  }
  const key = `${language}:${cacheKey}`;
  let tokens = cache.get(key);
  if (tokens) cache.delete(key);
  else {
    tokens = new LineTokens(getLines(), language);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, tokens);
  return tokens;
}

const themeStyles = new Set<string>();

/** Token colors come from one stylesheet per theme, so a theme switch re-renders no rows. */
export function ensureThemeStyles(name: string): string {
  if (themeStyles.has(name) || typeof document === "undefined") return name;
  let theme;
  try {
    theme = resolveTheme(name);
  } catch {
    return name === "pierre-dark" ? name : ensureThemeStyles("pierre-dark");
  }
  themeStyles.add(name);
  const scope = `[data-hl-theme="${name}"]`;
  let css = `${scope}{--diffs-light:${theme.fg};--diffs-dark:${theme.fg};--diffs-light-bg:${theme.bg};--diffs-dark-bg:${theme.bg}}`;
  theme.styles.forEach(([color, font], id) => {
    css += `${scope} .hl-${id}{color:${color}${font & 1 ? ";font-style:italic" : ""}${font & 2 ? ";font-weight:bold" : ""}}`;
  });
  const style = document.createElement("style");
  style.dataset.hlTheme = name;
  style.textContent = `@layer components{${css}}`;
  document.head.append(style);
  return name;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeHtml = (text: string) => text.replace(/[&<>]/gu, (character) => ESCAPES[character]!);

/**
 * A line's token spans as HTML: one string per row keeps React out of per-token reconciliation.
 * `emphasis` holds sorted `[start, end)` ranges (changed words), each in a `[data-diff-span]`.
 */
export function lineHtml(
  text: string,
  pairs: Uint32Array | undefined,
  emphasis?: ReadonlyArray<number>,
): string {
  if (text === "") return "<br>";
  if (!pairs && !emphasis) return `<span>${escapeHtml(text)}</span>`;
  const tokens = pairs ?? Uint32Array.of(text.length, 0);
  let html = "";
  let start = 0;
  let range = 0;
  let open = false;
  for (let index = 0; index < tokens.length && start < text.length; index += 2) {
    const end = Math.min(tokens[index]!, text.length);
    const className = pairs ? ` class="hl-${tokens[index + 1]}"` : "";
    while (start < end) {
      const rangeStart = emphasis?.[range];
      const rangeEnd = emphasis?.[range + 1] ?? end;
      if (!open && rangeStart !== undefined && rangeStart <= start) {
        html += '<span data-diff-span="">';
        open = true;
      }
      let stop = open ? Math.min(end, rangeEnd) : Math.min(end, rangeStart ?? end);
      if (stop <= start) stop = end;
      html += `<span${className}>${escapeHtml(text.slice(start, stop))}</span>`;
      start = stop;
      if (open && start >= rangeEnd) {
        html += "</span>";
        open = false;
        range += 2;
      }
    }
  }
  if (start < text.length) html += `<span>${escapeHtml(text.slice(start))}</span>`;
  return open ? `${html}</span>` : html;
}
