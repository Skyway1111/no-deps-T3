import { T } from "./tokens.ts";

/**
 * An immutable, interned frame stack. Equal stacks are usually the same
 * object; `stateEquals` falls back to the key if the intern table was reset.
 */
export interface LexerState {
  readonly key: string;
  readonly parent: LexerState | null;
  readonly lexer: Lexer;
  readonly mode: number;
  readonly data: string;
  /** Embed boundaries at or below this frame. */
  readonly embeds: number;
}

export interface Lexer {
  readonly name: string;
  /** Scans from `s.pos` up to `s.end`. Returns early after switching to another lexer's frame. */
  step(s: Scanner, state: LexerState): LexerState;
  /** Line-end transitions, such as dropping an unterminated single-line string. */
  eol?(s: Scanner, state: LexerState): LexerState;
  /** The state before the first line, when it is not a plain root frame. */
  initial?(parent: LexerState | null): LexerState;
  /** For embed frames: where the embedded region ends on this line at or after `pos`, or -1. */
  embedEnd?(line: string, pos: number, state: LexerState): number;
}

/** Modes at or above this value mark embed boundaries (`<script>`, fences). */
export const EMBED = 1 << 16;
export const ROOT = 0;

let internTable = new Map<string, LexerState>();
const lexerIds = new WeakMap<Lexer, number>();
let nextLexerId = 1;

function lexerId(lexer: Lexer): number {
  let id = lexerIds.get(lexer);
  if (id === undefined) lexerIds.set(lexer, (id = nextLexerId++));
  return id;
}

export function push(parent: LexerState | null, lexer: Lexer, mode: number, data = ""): LexerState {
  const key = `${parent === null ? "" : parent.key}/${lexerId(lexer)}:${mode}:${data}`;
  let state = internTable.get(key);
  if (state === undefined) {
    // States are tiny; the cap only guards against unbounded heredoc delimiters.
    if (internTable.size > 100_000) internTable = new Map();
    state = {
      key,
      parent,
      lexer,
      mode,
      data,
      embeds: (parent?.embeds ?? 0) + (mode >= EMBED ? 1 : 0),
    };
    internTable.set(key, state);
  }
  return state;
}

export function replace(state: LexerState, mode: number, data = ""): LexerState {
  return push(state.parent, state.lexer, mode, data);
}

export function initialState(lexer: Lexer, parent: LexerState | null = null): LexerState {
  return lexer.initial ? lexer.initial(parent) : push(parent, lexer, ROOT);
}

export function stateEquals(a: LexerState | null, b: LexerState | null): boolean {
  return a === b || (a !== null && b !== null && a.key === b.key);
}

/** Growable `(end, tokenId)` record buffer. */
export class Records {
  buf = new Uint32Array(256);
  len = 0;

  push(end: number, token: number): void {
    if (this.len + 2 > this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = end;
    this.buf[this.len++] = token;
  }

  finish(): Uint32Array {
    return this.buf.slice(0, this.len);
  }
}

/** Per-line cursor shared by every lexer that scans the line. */
export class Scanner {
  line = "";
  pos = 0;
  end = 0;
  /** Absolute offset of the line within the document. */
  base = 0;
  /** First record of the current line. */
  lineStart = 0;
  out: Records;
  /** Whether the last significant token ended a value (`/` divides, `<` compares). */
  valueEnd = false;
  /** Lexer-owned scratch flags; reset each line. */
  flags = 0;
  pending = "";

  constructor(out: Records) {
    this.out = out;
  }

  reset(line: string, base: number): void {
    this.line = line;
    this.pos = 0;
    this.end = line.length;
    this.base = base;
    this.lineStart = this.out.len;
    this.valueEnd = false;
    this.flags = 0;
    this.pending = "";
  }

  /** Colors `[pos, to)`, merging into an adjacent run of the same token. */
  emit(to: number, token: number): void {
    if (to <= this.pos) return;
    const out = this.out;
    if (out.len > this.lineStart && out.buf[out.len - 1] === token)
      out.buf[out.len - 2] = this.base + to;
    else out.push(this.base + to, token);
    this.pos = to;
  }

  /** Skips spaces and tabs; they join the previous token so runs stay long. */
  ws(): void {
    const line = this.line;
    let at = this.pos;
    const end = this.end;
    while (at < end) {
      const c = line.charCodeAt(at);
      if (c !== 32 && c !== 9) break;
      at++;
    }
    if (at === this.pos) return;
    const out = this.out;
    if (out.len > this.lineStart) {
      out.buf[out.len - 2] = this.base + at;
      this.pos = at;
    } else this.emit(at, T.none);
  }

  peek(offset = 0): number {
    const at = this.pos + offset;
    return at < this.end ? this.line.charCodeAt(at) : -1;
  }

  startsWith(text: string, at = this.pos): boolean {
    return at + text.length <= this.end && this.line.startsWith(text, at);
  }

  /** Emits the rest of the scan range as one token. */
  rest(token: number): void {
    this.emit(this.end, token);
  }
}

function embedLimit(line: string, pos: number, state: LexerState): [number, LexerState | null] {
  let limit = line.length;
  let frame: LexerState | null = null;
  for (let f: LexerState | null = state; f !== null && f.embeds > 0; f = f.parent) {
    if (f.mode < EMBED) continue;
    const end = f.lexer.embedEnd!(line, pos, f);
    if (end >= pos && end <= limit) {
      limit = end;
      frame = f;
    }
  }
  return [limit, frame];
}

/**
 * Tokenizes one line (without its line break) into `s.out` and returns the
 * state for the next line. Lines longer than `maxLineLength` still advance the
 * state but render as one plain token.
 */
export function scanLine(
  s: Scanner,
  line: string,
  base: number,
  state: LexerState,
  maxLineLength: number,
): LexerState {
  s.reset(line, base);
  const len = line.length;
  let st = state;
  for (let guard = 0; ; guard++) {
    let limit = len;
    let boundary: LexerState | null = null;
    if (st.embeds > 0) [limit, boundary] = embedLimit(line, s.pos, st);
    const before = s.pos;
    const beforeState = st;
    if (boundary !== null && s.pos >= limit) {
      s.end = len;
      st = boundary.lexer.step(s, boundary);
    } else {
      if (s.pos >= len) break;
      s.end = limit;
      st = st.lexer.step(s, st);
    }
    if (s.pos === before && st === beforeState) {
      // A lexer made no progress; consume one character so the line always ends.
      if (s.pos >= len) break;
      s.end = len;
      s.emit(s.pos + 1, T.none);
    }
    if (guard > len * 4 + 64) {
      s.end = len;
      s.rest(T.none);
      break;
    }
  }
  s.end = len;
  for (let i = 0; i < 8 && st.lexer.eol; i++) {
    const next = st.lexer.eol(s, st);
    if (next === st) break;
    st = next;
  }
  if (len > maxLineLength) {
    s.out.len = s.lineStart;
    s.out.push(base + len, T.none);
  }
  return st;
}

const CHAR_LETTER = 1;
const CHAR_DIGIT = 2;
const charClass = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) charClass[c] = CHAR_LETTER;
  if (c >= 48 && c <= 57) charClass[c] = CHAR_DIGIT;
}

export function isLetter(c: number): boolean {
  return c >= 128 ? c !== 0xa0 && c !== 0xfeff : c >= 0 && (charClass[c]! & CHAR_LETTER) !== 0;
}

export function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

export function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}

export function isWordChar(c: number): boolean {
  return c >= 128 ? c !== 0xa0 && c !== 0xfeff : c >= 0 && charClass[c] !== 0;
}

export function isSpace(c: number): boolean {
  return c === 32 || c === 9;
}

/** End of the `[A-Za-z0-9_]` (plus `extra`) run starting at `at`. */
export function wordEnd(line: string, at: number, end: number, extra = ""): number {
  while (at < end) {
    const c = line.charCodeAt(at);
    if (!isWordChar(c) && (extra === "" || extra.indexOf(line[at]!) < 0)) break;
    at++;
  }
  return at;
}

/** End of a number literal starting at `at`: radix prefixes, `_`, fractions, exponents, suffixes. */
export function numberEnd(line: string, at: number, end: number): number {
  let p = at;
  const c0 = line.charCodeAt(p);
  const c1 = p + 1 < end ? line.charCodeAt(p + 1) : -1;
  if (c0 === 48 && (c1 === 120 || c1 === 88 || c1 === 98 || c1 === 66 || c1 === 111 || c1 === 79)) {
    return wordEnd(line, p + 2, end);
  }
  while (p < end && (isDigit(line.charCodeAt(p)) || line.charCodeAt(p) === 95)) p++;
  if (p + 1 < end && line.charCodeAt(p) === 46 && isDigit(line.charCodeAt(p + 1))) {
    p++;
    while (p < end && (isDigit(line.charCodeAt(p)) || line.charCodeAt(p) === 95)) p++;
  }
  const e = p < end ? line.charCodeAt(p) : -1;
  if (e === 101 || e === 69) {
    let q = p + 1;
    const sign = q < end ? line.charCodeAt(q) : -1;
    if (sign === 43 || sign === 45) q++;
    if (q < end && isDigit(line.charCodeAt(q))) {
      p = q;
      while (p < end && isDigit(line.charCodeAt(p))) p++;
    }
  }
  return wordEnd(line, p, end);
}

/** Case-insensitive `indexOf` for ASCII needles that are already lowercase. */
export function indexOfLower(line: string, needle: string, from: number): number {
  const first = needle.charCodeAt(0);
  for (let at = from; at + needle.length <= line.length; at++) {
    if ((line.charCodeAt(at) | 32) !== (first | 32) && line.charCodeAt(at) !== first) continue;
    let k = 1;
    for (; k < needle.length; k++) {
      const c = line.charCodeAt(at + k);
      const n = needle.charCodeAt(k);
      if (c !== n && (c | 32) !== n) break;
    }
    if (k === needle.length) return at;
  }
  return -1;
}

export function wordSet(words: string): Set<string> {
  return new Set(words.split(" ").filter(Boolean));
}

/** First index at or after `at` that is not a space or tab. */
export function skipSpaces(line: string, at: number, end = line.length): number {
  while (at < end && isSpace(line.charCodeAt(at))) at++;
  return at;
}
