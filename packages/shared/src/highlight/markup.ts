import { ClikeLexer, escapeEnd } from "./clike.ts";
import {
  EMBED,
  indexOfLower,
  isDigit,
  isLetter,
  isWordChar,
  numberEnd,
  push,
  replace,
  initialState,
  ROOT,
  skipSpaces,
  wordEnd,
  type Lexer,
  type LexerState,
  type Scanner,
} from "./lexer.ts";
import { T } from "./tokens.ts";

export type LexerLookup = (name: string) => Lexer | undefined;

const CSS_COMMENT = 1;
const CSS_BLOCK = 2;
const CSS_VALUE = 3;
const CSS_STRING = 4;

/** CSS, SCSS, and Less. Selectors at the root, declarations inside blocks. */
export class CssLexer implements Lexer {
  readonly name: string;
  private readonly lineComments: boolean;

  constructor(name: string) {
    this.name = name;
    this.lineComments = name !== "css";
  }

  step(s: Scanner, state: LexerState): LexerState {
    const line = s.line;
    let st = state;
    if (st.mode === CSS_COMMENT) {
      const close = line.indexOf("*/", s.pos);
      if (close < 0 || close + 2 > s.end) {
        s.rest(T.comment);
        return st;
      }
      s.emit(close + 2, T.comment);
      return st.parent!;
    }
    if (st.mode === CSS_STRING) {
      const close = stringEnd(line, s.pos, s.end, st.data);
      s.emit(close < 0 ? s.end : close, T.string);
      return close < 0 ? st : st.parent!;
    }
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      const next = s.peek(1);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 47 && next === 42) {
        s.emit(at + 2, T.comment);
        return push(st, this, CSS_COMMENT);
      }
      if (c === 47 && next === 47 && this.lineComments) {
        s.rest(T.comment);
        continue;
      }
      if (c === 34 || c === 39) {
        const close = stringEnd(line, at + 1, s.end, line[at]!);
        if (close < 0) {
          s.rest(T.string);
          return push(st, this, CSS_STRING, line[at]!);
        }
        s.emit(close, T.string);
        continue;
      }
      if (c === 123) {
        s.emit(at + 1, T.punctuationBracket);
        if (st.mode === CSS_VALUE) st = st.parent!;
        st = push(st, this, CSS_BLOCK);
        continue;
      }
      if (c === 125) {
        s.emit(at + 1, T.punctuationBracket);
        if (st.mode === CSS_VALUE) st = st.parent!;
        if (st.mode === CSS_BLOCK) st = st.parent!;
        continue;
      }
      if (c === 59) {
        s.emit(at + 1, T.punctuationDelimiter);
        if (st.mode === CSS_VALUE) st = st.parent!;
        continue;
      }
      if (c === 64 && isLetter(next)) {
        const end = wordEnd(line, at + 1, s.end, "-");
        const rule = line.slice(at + 1, end);
        s.emit(
          end,
          rule === "import" || rule === "use" || rule === "forward" ? T.keywordImport : T.keyword,
        );
        // Less variables (`@x: 1`) and at-rule preludes read as values.
        if (st.mode !== CSS_VALUE) st = push(st, this, CSS_VALUE, "@");
        continue;
      }
      if (c === 36 && isLetter(next)) {
        s.emit(wordEnd(line, at + 1, s.end, "-"), T.variable);
        continue;
      }
      if (st.mode === CSS_VALUE) {
        this.value(s);
        continue;
      }
      if (
        st.mode === CSS_BLOCK &&
        (isLetter(c) || c === 45) &&
        this.isDeclaration(line, at, s.end)
      ) {
        s.emit(wordEnd(line, at, s.end, "-"), c === 45 && next === 45 ? T.variable : T.property);
        const colon = skipSpaces(line, s.pos, s.end);
        s.ws();
        if (line.charCodeAt(colon) === 58) s.emit(colon + 1, T.punctuationDelimiter);
        st = push(st, this, CSS_VALUE);
        continue;
      }
      this.selector(s);
    }
    return st;
  }

  /** `name:` starts a declaration unless a `{` follows before `;` (nested selectors). */
  private isDeclaration(line: string, at: number, end: number): boolean {
    const nameEnd = wordEnd(line, at, end, "-");
    if (line.charCodeAt(skipSpaces(line, nameEnd, end)) !== 58) return false;
    for (let i = nameEnd; i < end; i++) {
      const c = line.charCodeAt(i);
      if (c === 59 || c === 125) return true;
      if (c === 123) return line.charCodeAt(i - 1) === 35;
    }
    return true;
  }

  private selector(s: Scanner): void {
    const line = s.line;
    const at = s.pos;
    const c = line.charCodeAt(at);
    const next = s.peek(1);
    if (c === 46 && (isLetter(next) || next === 45))
      s.emit(wordEnd(line, at + 1, s.end, "-"), T.selectorClass);
    else if (c === 35 && (isLetter(next) || next === 45))
      s.emit(wordEnd(line, at + 1, s.end, "-"), T.selectorId);
    else if (c === 58) {
      const start = next === 58 ? at + 2 : at + 1;
      s.emit(wordEnd(line, start, s.end, "-"), T.selectorPseudo);
    } else if (isLetter(c)) s.emit(wordEnd(line, at, s.end, "-"), T.tag);
    else if (c === 38) s.emit(at + 1, T.variableSpecial);
    else if (c === 91) {
      s.emit(at + 1, T.punctuationBracket);
      const nameEnd = wordEnd(line, s.pos, s.end, "-");
      s.emit(nameEnd, T.attribute);
    } else if (c === 93 || c === 40 || c === 41) s.emit(at + 1, T.punctuationBracket);
    else if (c === 44) s.emit(at + 1, T.punctuationDelimiter);
    else if (isDigit(c)) s.emit(numberEnd(line, at, s.end), T.number);
    else
      s.emit(
        at + 1,
        c === 62 || c === 43 || c === 126 || c === 42 || c === 61 ? T.operator : T.none,
      );
  }

  private value(s: Scanner): void {
    const line = s.line;
    const at = s.pos;
    const c = line.charCodeAt(at);
    const next = s.peek(1);
    if (isDigit(c) || ((c === 46 || c === 45) && isDigit(next))) {
      const end = numberEnd(line, c === 45 ? at + 1 : at, s.end);
      s.emit(line.charCodeAt(end) === 37 ? end + 1 : end, T.number);
    } else if (c === 45 && next === 45) s.emit(wordEnd(line, at, s.end, "-"), T.variable);
    else if (c === 35 && isWordChar(next)) s.emit(wordEnd(line, at + 1, s.end), T.stringSpecial);
    else if (c === 33 && isLetter(next)) s.emit(wordEnd(line, at + 1, s.end), T.keyword);
    else if (isLetter(c) || c === 45) {
      const end = wordEnd(line, at, s.end, "-");
      const after = line.charCodeAt(end);
      s.emit(end, after === 40 ? T.function : after === 58 ? T.property : T.constantBuiltin);
    } else if (c === 40 || c === 41 || c === 91 || c === 93) s.emit(at + 1, T.punctuationBracket);
    else if (c === 44 || c === 58) s.emit(at + 1, T.punctuationDelimiter);
    else if (c === 92) s.emit(escapeEnd(line, at, s.end), T.stringEscape);
    else
      s.emit(
        at + 1,
        c === 43 || c === 42 || c === 47 || c === 61 || c === 62 || c === 60 ? T.operator : T.none,
      );
  }
}

function stringEnd(line: string, from: number, end: number, quote: string): number {
  for (let i = from; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === 92) i++;
    else if (line[i] === quote) return i + 1;
  }
  return -1;
}

const TAG = 1;
const COMMENT = 2;
const ATTR_VALUE = 3;
const CDATA = 4;
const START = 5;
const EMBED_BLOCK = EMBED + 1;
const EMBED_ATTR = EMBED + 2;
const EMBED_FRONTMATTER = EMBED + 3;

export type MarkupKind = "html" | "xml" | "vue" | "svelte" | "astro";

/**
 * HTML and XML with HTML-derived component formats. `<script>` and `<style>`
 * bodies, Vue directive values, Svelte/Astro `{}` and Astro frontmatter use
 * their own lexers.
 */
export class MarkupLexer implements Lexer {
  readonly name: string;
  private readonly kind: MarkupKind;
  private readonly lookup: LexerLookup;

  constructor(kind: MarkupKind, lookup: LexerLookup) {
    this.name = kind;
    this.kind = kind;
    this.lookup = lookup;
  }

  initial(parent: LexerState | null = null): LexerState {
    return push(parent, this, this.kind === "astro" ? START : ROOT);
  }

  embedEnd(line: string, pos: number, st: LexerState): number {
    if (st.mode === EMBED_BLOCK)
      return indexOfLower(line, `</${st.data.slice(0, st.data.indexOf("|"))}`, pos);
    if (st.mode === EMBED_ATTR) return line.indexOf(st.data, pos);
    return pos === 0 && line.trimEnd() === "---" ? 0 : -1;
  }

  eol(_s: Scanner, st: LexerState): LexerState {
    return st.mode === START ? replace(st, ROOT) : st;
  }

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    switch (st.mode) {
      case START:
        if (line.trimEnd() === "---") {
          s.rest(T.punctuationDelimiter);
          return this.embed(push(replace(st, ROOT), this, EMBED_FRONTMATTER), "typescript");
        }
        return replace(st, ROOT);
      case EMBED_BLOCK:
      case EMBED_ATTR:
      case EMBED_FRONTMATTER: {
        if (this.embedEnd(line, s.pos, st) !== s.pos) return this.embedInner(st);
        if (st.mode === EMBED_ATTR) {
          s.emit(s.pos + 1, T.string);
          return st.parent!;
        }
        if (st.mode === EMBED_FRONTMATTER) s.rest(T.punctuationDelimiter);
        return st.parent!;
      }
      case COMMENT:
      case CDATA: {
        const close = st.mode === COMMENT ? "-->" : "]]>";
        const at = line.indexOf(close, s.pos);
        if (at < 0 || at + close.length > s.end) {
          s.rest(st.mode === COMMENT ? T.comment : T.string);
          return st;
        }
        s.emit(at + close.length, st.mode === COMMENT ? T.comment : T.string);
        return st.parent!;
      }
      case ATTR_VALUE: {
        const at = line.indexOf(st.data, s.pos);
        if (at < 0 || at >= s.end) {
          s.rest(T.string);
          return st;
        }
        s.emit(at + 1, T.string);
        return st.parent!;
      }
      case TAG:
        return this.tag(s, st);
      default:
        return this.text(s, st);
    }
  }

  private embed(parent: LexerState, language: string): LexerState {
    const lexer = this.lookup(language);
    return lexer ? initialState(lexer, parent) : parent;
  }

  /** Inner code popped past its root; restart it inside the boundary. */
  private embedInner(st: LexerState): LexerState {
    const language =
      st.mode === EMBED_BLOCK
        ? st.data.slice(st.data.indexOf("|") + 1)
        : st.mode === EMBED_FRONTMATTER
          ? "typescript"
          : "javascript";
    return this.embed(st, language);
  }

  private interp(st: LexerState, depth = 0): LexerState {
    const js = this.lookup("javascript");
    return js instanceof ClikeLexer ? js.interpState(st, depth) : st;
  }

  private text(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    const braces = this.kind === "svelte" || this.kind === "astro";
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 60) {
        if (s.startsWith("<!--")) {
          s.emit(at + 4, T.comment);
          return push(st, this, COMMENT);
        }
        if (s.startsWith("<![CDATA[")) {
          s.emit(at + 9, T.string);
          return push(st, this, CDATA);
        }
        if (s.peek(1) === 33 || s.peek(1) === 63) {
          const close = line.indexOf(">", at);
          s.emit(close < 0 || close >= s.end ? s.end : close + 1, T.tagDoctype);
          continue;
        }
        const closing = s.peek(1) === 47;
        const nameStart = at + (closing ? 2 : 1);
        if (isLetter(line.charCodeAt(nameStart))) {
          const nameEnd = wordEnd(line, nameStart, s.end, "-:.");
          s.emit(nameStart, T.punctuationBracketHtml);
          s.emit(nameEnd, T.tag);
          const name = line.slice(nameStart, nameEnd).toLowerCase();
          return push(st, this, TAG, closing ? "c" : `o|${name}|`);
        }
      }
      if (c === 38) {
        let end = at + 1;
        while (
          end < s.end &&
          end - at < 32 &&
          (isWordChar(line.charCodeAt(end)) || line[end] === "#")
        )
          end++;
        if (line.charCodeAt(end) === 59 && end > at + 1) {
          s.emit(end + 1, T.stringSpecial);
          continue;
        }
      }
      if (c === 123 && (braces || (this.kind === "vue" && s.peek(1) === 123))) {
        const vue = this.kind === "vue";
        s.emit(at + (vue ? 2 : 1), T.punctuationSpecial);
        return this.interp(st, vue ? 1 : 0);
      }
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      let end = at + 1;
      while (end < s.end) {
        const d = line.charCodeAt(end);
        if (d === 60 || d === 38 || d === 123) break;
        end++;
      }
      s.emit(end, T.none);
    }
    return st;
  }

  private tag(s: Scanner, state: LexerState): LexerState {
    const line = s.line;
    let st = state;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if ((c === 47 || c === 63) && s.peek(1) === 62) {
        s.emit(at + 2, T.punctuationBracketHtml);
        return st.parent!;
      }
      if (c === 62) {
        s.emit(at + 1, T.punctuationBracketHtml);
        if (st.data === "c") return st.parent!;
        const [, name, lang] = st.data.split("|");
        const language = this.kind === "xml" ? undefined : blockLanguage(name!, lang!);
        if (language === undefined) return st.parent!;
        return this.embed(push(st.parent, this, EMBED_BLOCK, `${name}|${language}`), language);
      }
      if (c === 61) {
        s.emit(at + 1, T.punctuationDelimiterHtml);
        continue;
      }
      if (c === 34 || c === 39) {
        const quote = line[at]!;
        const [kind, name, lang, attr] = st.data.split("|");
        if (attr === "lang" || attr === "type") {
          const close = line.indexOf(quote, at + 1);
          st = replace(
            st,
            TAG,
            `${kind}|${name}|${line.slice(at + 1, close < 0 ? s.end : close)}|`,
          );
        } else if (attr === "js") {
          s.emit(at + 1, T.string);
          st = replace(st, TAG, `${kind}|${name}|${lang}|`);
          return this.embed(push(st, this, EMBED_ATTR, quote), "javascript");
        }
        const close = line.indexOf(quote, at + 1);
        if (close < 0 || close >= s.end) {
          s.rest(T.string);
          return push(st, this, ATTR_VALUE, quote);
        }
        s.emit(close + 1, T.string);
        continue;
      }
      if (c === 123 && this.kind !== "html" && this.kind !== "xml") {
        s.emit(at + 1, T.punctuationSpecial);
        return this.interp(st);
      }
      let end = at + 1;
      while (end < s.end) {
        const d = line.charCodeAt(end);
        if (
          d === 32 ||
          d === 9 ||
          d === 61 ||
          d === 62 ||
          d === 34 ||
          d === 39 ||
          (d === 47 && line.charCodeAt(end + 1) === 62)
        )
          break;
        end++;
      }
      const previous = line.charCodeAt(skipBack(line, at));
      if (previous === 61) {
        s.emit(end, T.string);
        continue;
      }
      const attr = line.slice(at, end).toLowerCase();
      s.emit(end, T.attribute);
      if (st.data !== "c") {
        const [kind, name, lang] = st.data.split("|");
        const marker =
          attr === "lang" || attr === "type"
            ? attr
            : this.kind === "vue" &&
                (attr.startsWith(":") ||
                  attr.startsWith("@") ||
                  attr.startsWith("v-") ||
                  attr.startsWith("#"))
              ? "js"
              : "";
        st = replace(st, TAG, `${kind}|${name}|${lang}|${marker}`);
      }
    }
    return st;
  }
}

function skipBack(line: string, at: number): number {
  let i = at - 1;
  while (i > 0 && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i--;
  return i;
}

function blockLanguage(name: string, lang: string): string | undefined {
  const value = lang.toLowerCase();
  if (name === "style")
    return value === "scss" || value === "sass" ? "scss" : value === "less" ? "less" : "css";
  if (name !== "script") return undefined;
  if (
    value === "" ||
    value.includes("javascript") ||
    value === "module" ||
    value === "js" ||
    value === "jsx"
  )
    return "javascript";
  if (value === "ts" || value === "typescript") return "typescript";
  if (value === "tsx") return "tsx";
  if (value.includes("json") || value === "importmap") return "json";
  return "text";
}
