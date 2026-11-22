import { ClikeLexer, escapeEnd } from "./clike.ts";
import {
  EMBED,
  initialState,
  isDigit,
  isLetter,
  isSpace,
  isWordChar,
  numberEnd,
  push,
  replace,
  ROOT,
  skipSpaces,
  wordEnd,
  wordSet,
  type Lexer,
  type LexerState,
  type Scanner,
} from "./lexer.ts";
import type { LexerLookup } from "./markup.ts";
import { T } from "./tokens.ts";

/** One plain token per line. */
export const plainLexer: Lexer = {
  name: "text",
  step(s, st) {
    s.rest(T.none);
    return st;
  },
};

/** A boundary that ends at the line end, unless the line continues with `\`. */
const EMBED_LINE = EMBED + 9;

function lineEmbedEnd(line: string, pos: number): number {
  let end = line.length;
  while (end > pos && isSpace(line.charCodeAt(end - 1))) end--;
  return line.charCodeAt(end - 1) === 92 ? -1 : line.length;
}

function embedLine(lexer: Lexer, st: LexerState, inner: Lexer | undefined): LexerState {
  const boundary = push(st, lexer, EMBED_LINE);
  return inner ? initialState(inner, boundary) : boundary;
}

const MD_START = 1;
const MD_COMMENT = 2;
const MD_FENCE = EMBED + 1;
const MD_FRONTMATTER = EMBED + 2;

export class MarkdownLexer implements Lexer {
  readonly name: string;
  private readonly mdx: boolean;
  private readonly lookup: LexerLookup;

  constructor(name: "markdown" | "mdx", lookup: LexerLookup) {
    this.name = name;
    this.mdx = name === "mdx";
    this.lookup = lookup;
  }

  initial(parent: LexerState | null): LexerState {
    return push(parent, this, MD_START);
  }

  eol(_s: Scanner, st: LexerState): LexerState {
    return st.mode === MD_START ? replace(st, ROOT) : st;
  }

  embedEnd(line: string, pos: number, st: LexerState): number {
    if (st.mode === EMBED_LINE) return lineEmbedEnd(line, pos);
    if (pos !== 0) return -1;
    if (st.mode === MD_FRONTMATTER) return line.trimEnd() === "---" ? 0 : -1;
    const marker = st.data.slice(0, st.data.indexOf("|"));
    const at = skipSpaces(line, 0);
    if (at > 3) return -1;
    let end = at;
    while (end < line.length && line[end] === marker[0]) end++;
    return end - at >= marker.length && line.slice(end).trim() === "" ? 0 : -1;
  }

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    switch (st.mode) {
      case EMBED_LINE:
        return st.parent!;
      case MD_FRONTMATTER:
        if (s.pos === 0 && line.trimEnd() === "---") {
          s.rest(T.punctuationDelimiter);
          return st.parent!;
        }
        return this.inner(st, "yaml");
      case MD_FENCE: {
        if (s.pos === 0 && this.embedEnd(line, 0, st) === 0) {
          s.rest(T.punctuationDelimiter);
          return st.parent!;
        }
        const language = st.data.slice(st.data.indexOf("|") + 1);
        const next = this.inner(st, language);
        if (next === st) s.rest(T.textLiteral);
        return next;
      }
      case MD_COMMENT: {
        const close = line.indexOf("-->", s.pos);
        if (close < 0) {
          s.rest(T.comment);
          return st;
        }
        s.emit(close + 3, T.comment);
        return st.parent!;
      }
      case MD_START:
        if (line.trimEnd() === "---") {
          s.rest(T.punctuationDelimiter);
          return this.inner(push(replace(st, ROOT), this, MD_FRONTMATTER), "yaml");
        }
        return replace(st, ROOT);
    }
    if (s.pos === 0) {
      const block = this.block(s, st);
      if (block !== null) return block;
    }
    return this.inline(s, st);
  }

  private inner(st: LexerState, language: string): LexerState {
    const lexer = language === "" ? undefined : this.lookup(language);
    return lexer ? initialState(lexer, st) : st;
  }

  private block(s: Scanner, st: LexerState): LexerState | null {
    const line = s.line;
    const indent = skipSpaces(line, 0);
    const c = line.charCodeAt(indent);
    if (indent <= 3 && (c === 96 || c === 126)) {
      let end = indent;
      while (end < line.length && line.charCodeAt(end) === c) end++;
      if (end - indent >= 3 && (c === 126 || line.indexOf("`", end) < 0)) {
        const info = line.slice(end).trim();
        const language = info.split(/[\s{,]/u)[0]!.toLowerCase();
        s.rest(T.punctuationDelimiter);
        return this.inner(
          push(st, this, MD_FENCE, `${line.slice(indent, end)}|${language}`),
          language,
        );
      }
    }
    if (this.mdx && indent === 0 && (line.startsWith("import ") || line.startsWith("export "))) {
      return embedLine(this, st, this.lookup("tsx"));
    }
    if (c === 35) {
      let end = indent;
      while (line.charCodeAt(end) === 35) end++;
      if (end - indent <= 6 && (end === line.length || isSpace(line.charCodeAt(end)))) {
        s.rest(T.title);
        return st;
      }
    }
    if (s.startsWith("<!--", indent)) {
      const close = line.indexOf("-->", indent + 4);
      s.emit(indent, T.none);
      if (close < 0) {
        s.rest(T.comment);
        return push(st, this, MD_COMMENT);
      }
      s.emit(close + 3, T.comment);
      return null;
    }
    if ((c === 45 || c === 42 || c === 95) && isRule(line, c)) {
      s.rest(T.punctuationMarkup);
      return st;
    }
    s.emit(indent, T.none);
    let at = indent;
    while (line.charCodeAt(at) === 62) {
      at = skipSpaces(line, at + 1);
      s.emit(at, T.punctuationMarkup);
    }
    const m = line.charCodeAt(at);
    let markerEnd = -1;
    if (
      (m === 45 || m === 42 || m === 43) &&
      (at + 1 === line.length || isSpace(line.charCodeAt(at + 1)))
    ) {
      markerEnd = at + 1;
    } else if (isDigit(m)) {
      let end = at;
      while (isDigit(line.charCodeAt(end)) && end - at < 9) end++;
      const d = line.charCodeAt(end);
      if ((d === 46 || d === 41) && (end + 1 === line.length || isSpace(line.charCodeAt(end + 1))))
        markerEnd = end + 1;
    }
    if (markerEnd > 0) {
      let end = skipSpaces(line, markerEnd);
      if (line[end] === "[" && line[end + 2] === "]" && " xX".includes(line[end + 1]!))
        end = skipSpaces(line, end + 3);
      s.emit(end, T.punctuationListMarker);
    }
    if (
      line.charCodeAt(s.pos) === 124 &&
      /^\|?[\s:|-]+\|?$/u.test(line.slice(s.pos).trimEnd()) &&
      line.includes("-")
    ) {
      s.rest(T.punctuationDelimiter);
      return st;
    }
    return null;
  }

  private inline(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      const next = s.peek(1);
      if (c === 96) {
        let run = at;
        while (line.charCodeAt(run) === 96) run++;
        const ticks = line.slice(at, run);
        const close = line.indexOf(ticks, run);
        s.emit(close < 0 ? run : close + ticks.length, close < 0 ? T.none : T.textLiteral);
        continue;
      }
      if ((c === 42 || c === 95) && next !== 32) {
        let run = at;
        while (line.charCodeAt(run) === c && run - at < 3) run++;
        const marker = line.slice(at, run);
        const close = line.indexOf(marker, run + 1);
        const boundary = c !== 95 || at === 0 || !isWordChar(line.charCodeAt(at - 1));
        if (close > run && boundary && line.charCodeAt(close - 1) !== 32) {
          s.emit(close + marker.length, marker.length >= 2 ? T.emphasisStrong : T.emphasis);
          continue;
        }
        s.emit(run, T.none);
        continue;
      }
      if (c === 91 || (c === 33 && next === 91)) {
        const open = c === 33 ? at + 1 : at;
        const textEnd = line.indexOf("]", open + 1);
        if (textEnd > 0 && line.charCodeAt(textEnd + 1) === 40) {
          const urlEnd = line.indexOf(")", textEnd + 2);
          if (urlEnd > 0) {
            s.emit(open + 1, T.punctuationBracket);
            s.emit(textEnd, T.linkText);
            s.emit(textEnd + 2, T.punctuationBracket);
            s.emit(urlEnd, T.linkUri);
            s.emit(urlEnd + 1, T.punctuationBracket);
            continue;
          }
        }
      }
      if (c === 60 && (s.startsWith("<http", at) || s.startsWith("<mailto:", at))) {
        const close = line.indexOf(">", at);
        if (close > 0) {
          s.emit(close + 1, T.linkUri);
          continue;
        }
      }
      if (c === 104 && (s.startsWith("https://", at) || s.startsWith("http://", at))) {
        let end = at;
        while (
          end < s.end &&
          !isSpace(line.charCodeAt(end)) &&
          line[end] !== ")" &&
          line[end] !== ">"
        )
          end++;
        s.emit(end, T.linkUri);
        continue;
      }
      if (c === 92 && next > 32 && next < 127 && !isWordChar(next)) {
        s.emit(at + 2, T.stringEscape);
        continue;
      }
      if (c === 124) {
        s.emit(at + 1, T.punctuationDelimiter);
        continue;
      }
      if (this.mdx && c === 123) {
        s.emit(at + 1, T.punctuationSpecial);
        const js = this.lookup("javascript");
        if (js instanceof ClikeLexer) return js.interpState(st);
        continue;
      }
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      let end = at + 1;
      while (end < s.end) {
        const d = line.charCodeAt(end);
        if (d < 128 && INLINE_SPECIAL[d] === 1) break;
        end++;
      }
      s.emit(end, T.none);
    }
    return st;
  }
}

const INLINE_SPECIAL = new Uint8Array(128);
for (const c of [96, 42, 95, 91, 33, 60, 104, 92, 124, 123, 32, 9]) INLINE_SPECIAL[c] = 1;

function isRule(line: string, marker: number): boolean {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === marker) count++;
    else if (!isSpace(c)) return false;
  }
  return count >= 3;
}

const YAML_BLOCK = 1;

export class YamlLexer implements Lexer {
  readonly name = "yaml";

  eol(s: Scanner, st: LexerState): LexerState {
    if (s.pending === "") return st;
    const indent = s.pending;
    s.pending = "";
    return push(st, this, YAML_BLOCK, indent);
  }

  step(s: Scanner, state: LexerState): LexerState {
    const line = s.line;
    let st = state;
    if (st.mode === YAML_BLOCK) {
      const indent = skipSpaces(line, 0);
      if (indent === line.length || indent > Number(st.data)) {
        s.rest(T.string);
        return st;
      }
      st = st.parent!;
    }
    if (s.pos !== 0) {
      this.values(s, -1);
      return st;
    }
    s.ws();
    if (s.startsWith("---") || s.startsWith("...")) {
      s.emit(3, T.punctuationSpecial);
      this.values(s, -1);
      return st;
    }
    while (
      line.charCodeAt(s.pos) === 45 &&
      (s.pos + 1 === line.length || isSpace(line.charCodeAt(s.pos + 1)))
    ) {
      s.emit(s.pos + 1, T.punctuationDelimiter);
      s.ws();
    }
    const keyStart = s.pos;
    const keyEnd = yamlKeyEnd(line, keyStart, s.end);
    if (keyEnd > keyStart) {
      s.emit(keyEnd, T.property);
      s.emit(keyEnd + 1, T.punctuationDelimiter);
    }
    this.values(s, keyEnd > keyStart ? keyStart : skipSpaces(line, 0));
    return st;
  }

  /** Scalars, anchors, flow collections, and block scalar headers. */
  private values(s: Scanner, indent: number): void {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 35 && (at === 0 || isSpace(line.charCodeAt(at - 1)))) {
        s.rest(T.comment);
        return;
      }
      if (c === 38 || c === 42 || c === 33) {
        let end = at + 1;
        while (end < s.end && !isSpace(line.charCodeAt(end)) && !",[]{}".includes(line[end]!))
          end++;
        s.emit(end, T.type);
        continue;
      }
      if ((c === 124 || c === 62) && indent >= 0) {
        let end = at + 1;
        while (
          end < s.end &&
          (line[end] === "+" || line[end] === "-" || isDigit(line.charCodeAt(end)))
        )
          end++;
        const rest = skipSpaces(line, end, s.end);
        if (rest === s.end || line.charCodeAt(rest) === 35) {
          s.emit(end, T.punctuationDelimiter);
          s.pending = String(indent);
          continue;
        }
      }
      if (c === 34 || c === 39) {
        let end = at + 1;
        while (end < s.end) {
          const d = line.charCodeAt(end);
          if (c === 34 && d === 92) {
            s.emit(end, T.string);
            end = escapeEnd(line, end, s.end);
            s.emit(Math.min(end, s.end), T.stringEscape);
            continue;
          }
          if (d === c) {
            if (c === 39 && line.charCodeAt(end + 1) === 39) {
              end += 2;
              continue;
            }
            end++;
            break;
          }
          end++;
        }
        s.emit(Math.min(end, s.end), T.string);
        if (line.charCodeAt(s.pos) === 58) s.emit(s.pos + 1, T.punctuationDelimiter);
        continue;
      }
      if (c === 91 || c === 93 || c === 123 || c === 125) {
        s.emit(at + 1, T.punctuationBracket);
        continue;
      }
      if (c === 44) {
        s.emit(at + 1, T.punctuationDelimiter);
        continue;
      }
      const keyEnd = yamlKeyEnd(line, at, s.end);
      if (keyEnd > at && line.lastIndexOf("{", at) >= 0) {
        s.emit(keyEnd, T.property);
        s.emit(keyEnd + 1, T.punctuationDelimiter);
        continue;
      }
      let end = at;
      const inFlow = line.lastIndexOf("[", at) >= 0 || line.lastIndexOf("{", at) >= 0;
      while (end < s.end) {
        const d = line.charCodeAt(end);
        if (d === 35 && isSpace(line.charCodeAt(end - 1))) break;
        if (inFlow && (d === 44 || d === 93 || d === 125)) break;
        end++;
      }
      while (end > at && isSpace(line.charCodeAt(end - 1))) end--;
      s.emit(end, scalarToken(line.slice(at, end)));
    }
  }
}

function yamlKeyEnd(line: string, at: number, end: number): number {
  const c = line.charCodeAt(at);
  if (c === 34 || c === 39) {
    const close = line.indexOf(line[at]!, at + 1);
    return close > 0 &&
      line.charCodeAt(close + 1) === 58 &&
      (close + 2 >= end || isSpace(line.charCodeAt(close + 2)))
      ? close + 1
      : at;
  }
  if (at >= end || "[]{}&*!|>%@`#,".includes(line[at]!)) return at;
  for (let i = at; i < end; i++) {
    const d = line.charCodeAt(i);
    if (d === 58 && (i + 1 >= end || isSpace(line.charCodeAt(i + 1)))) return i;
    if (d === 35 && isSpace(line.charCodeAt(i - 1))) return at;
  }
  return at;
}

const YAML_BOOLEANS = wordSet(
  "true false yes no on off True False TRUE FALSE Yes No YES NO On Off ON OFF",
);
const YAML_NULLS = wordSet("null Null NULL ~");

function scalarToken(text: string): number {
  if (YAML_BOOLEANS.has(text)) return T.boolean;
  if (YAML_NULLS.has(text)) return T.constantBuiltin;
  return isNumeric(text) ? T.number : T.string;
}

function isNumeric(text: string): boolean {
  if (text === "") return false;
  let at = text[0] === "-" || text[0] === "+" ? 1 : 0;
  if (text.slice(at) === ".inf" || text === ".nan") return true;
  if (!isDigit(text.charCodeAt(at)) && !(text[at] === "." && isDigit(text.charCodeAt(at + 1))))
    return false;
  at = numberEnd(text, at, text.length);
  return at === text.length;
}

const TOML_BASIC = 1;
const TOML_LITERAL = 2;

export class TomlLexer implements Lexer {
  readonly name = "toml";

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    if (st.mode !== ROOT) {
      const close = st.mode === TOML_BASIC ? '"""' : "'''";
      const end = this.stringRun(s, close, st.mode === TOML_BASIC);
      return end ? st.parent! : st;
    }
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 35) {
        s.rest(T.comment);
        break;
      }
      if (c === 91 && skipSpaces(line, 0) === at) {
        const double = line.charCodeAt(at + 1) === 91;
        s.emit(at + (double ? 2 : 1), T.punctuationBracket);
        const close = line.indexOf("]", s.pos);
        if (close > 0) {
          s.emit(close, T.type);
          s.emit(close + (double ? 2 : 1), T.punctuationBracket);
        }
        continue;
      }
      if (s.startsWith('"""') || s.startsWith("'''")) {
        const basic = c === 34;
        s.emit(at + 3, T.string);
        if (!this.stringRun(s, basic ? '"""' : "'''", basic))
          return push(st, this, basic ? TOML_BASIC : TOML_LITERAL);
        continue;
      }
      if (c === 34 || c === 39) {
        let end = at + 1;
        while (end < s.end && line.charCodeAt(end) !== c)
          end += c === 34 && line.charCodeAt(end) === 92 ? 2 : 1;
        end = Math.min(end + 1, s.end);
        s.emit(end, line.charCodeAt(skipSpaces(line, end, s.end)) === 61 ? T.property : T.string);
        continue;
      }
      if (isWordChar(c) || c === 45 || c === 43) {
        const end = wordEnd(line, at, s.end, "-+.:");
        const after = line.charCodeAt(skipSpaces(line, wordEnd(line, at, s.end, "-"), s.end));
        if (isLetter(c) && (after === 61 || after === 46)) {
          s.emit(wordEnd(line, at, s.end, "-"), T.property);
          continue;
        }
        const word = line.slice(at, end);
        s.emit(
          end,
          word === "true" || word === "false"
            ? T.boolean
            : isLetter(c) && !/^[+-]?(?:inf|nan)$/u.test(word)
              ? T.string
              : T.number,
        );
        continue;
      }
      if (c === 61) s.emit(at + 1, T.operator);
      else if (c === 91 || c === 93 || c === 123 || c === 125) s.emit(at + 1, T.punctuationBracket);
      else if (c === 44 || c === 46) s.emit(at + 1, T.punctuationDelimiter);
      else s.emit(at + 1, T.none);
    }
    return st;
  }

  /** Multi-line string text up to `close`; true once closed. */
  private stringRun(s: Scanner, close: string, escapes: boolean): boolean {
    const line = s.line;
    for (let i = s.pos; i < s.end; i++) {
      if (escapes && line.charCodeAt(i) === 92) {
        s.emit(i, T.string);
        s.emit(Math.min(escapeEnd(line, i, s.end), s.end), T.stringEscape);
        i = s.pos - 1;
      } else if (line.startsWith(close, i)) {
        let end = i + 3;
        while (line.startsWith(close[0]!, end) && end - i < 5) end++;
        s.emit(end, T.string);
        return true;
      }
    }
    s.rest(T.string);
    return false;
  }
}

export class IniLexer implements Lexer {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    s.ws();
    const at = s.pos;
    const c = line.charCodeAt(at);
    if (c === 59 || c === 35 || (c === 33 && this.name === "properties")) {
      s.rest(T.comment);
      return st;
    }
    if (c === 91) {
      const close = line.indexOf("]", at);
      s.emit(at + 1, T.punctuationBracket);
      if (close > 0) {
        s.emit(close, T.type);
        s.emit(close + 1, T.punctuationBracket);
      }
      s.rest(T.none);
      return st;
    }
    if (line.startsWith("export ", at)) s.emit(at + 6, T.keyword);
    s.ws();
    let sep = -1;
    for (let i = s.pos; i < s.end; i++) {
      const d = line.charCodeAt(i);
      if (d === 61 || d === 58) {
        sep = i;
        break;
      }
    }
    if (sep < 0) {
      s.rest(T.none);
      return st;
    }
    let keyEnd = sep;
    while (keyEnd > s.pos && isSpace(line.charCodeAt(keyEnd - 1))) keyEnd--;
    s.emit(keyEnd, T.property);
    s.ws();
    s.emit(sep + 1, T.operator);
    s.ws();
    const value = line.slice(s.pos).trimEnd();
    if (value === "true" || value === "false") s.emit(s.pos + value.length, T.boolean);
    else if (isNumeric(value)) s.emit(s.pos + value.length, T.number);
    while (s.pos < s.end) {
      const i = s.pos;
      const d = line.charCodeAt(i);
      if (d === 36 && (line.charCodeAt(i + 1) === 123 || isLetter(line.charCodeAt(i + 1)))) {
        const close =
          line.charCodeAt(i + 1) === 123 ? line.indexOf("}", i) + 1 : wordEnd(line, i + 1, s.end);
        s.emit(close > 0 ? close : s.end, T.variable);
        continue;
      }
      if ((d === 35 || d === 59) && isSpace(line.charCodeAt(i - 1)) && this.name !== "properties") {
        s.rest(T.comment);
        break;
      }
      let end = i + 1;
      while (
        end < s.end &&
        line.charCodeAt(end) !== 36 &&
        line.charCodeAt(end) !== 35 &&
        line.charCodeAt(end) !== 59
      )
        end++;
      s.emit(end, T.string);
    }
    return st;
  }
}

export const diffLexer: Lexer = {
  name: "diff",
  step(s, st) {
    const line = s.line;
    const c = line.charCodeAt(0);
    if (s.pos !== 0) {
      s.rest(T.none);
      return st;
    }
    if (line.startsWith("diff ")) {
      s.emit(5, T.function);
      const flagEnd = line.startsWith("--", 5) ? wordEnd(line, 7, line.length, "-") : 5;
      s.emit(flagEnd, T.variableParameter);
      s.rest(T.none);
    } else if (line.startsWith("---") || line.startsWith("+++")) {
      s.emit(3, T.punctuationSpecial);
      s.rest(c === 45 ? T.diffMinus : T.diffPlus);
    } else if (line.startsWith("@@")) s.rest(T.attribute);
    else if (c === 45 || c === 43 || c === 60 || c === 62) {
      s.emit(1, T.punctuationSpecial);
      s.rest(c === 45 || c === 60 ? T.diffMinus : T.diffPlus);
    } else if (
      c === 92 ||
      /^(?:index|new file|deleted file|similarity|rename|old mode|new mode|copy) /u.test(line)
    ) {
      s.rest(T.comment);
    } else s.rest(T.none);
    return st;
  },
};

const SH_DQ = 1;
const SH_SQ = 2;
const SH_HEREDOC = 3;
const SH_SUBST = 4;
const SH_BACKTICK = 5;

const CMD = 1;
const LOOP_VAR = 2;
const ASSIGN = 4;
const DEFINE = 8;
const STARTED = 16;

const SHELL_CONTROL = wordSet(
  "if then else elif fi for while until do done case esac in select return exit break continue time coproc function end switch",
);
const SHELL_BEFORE_COMMAND = wordSet("if then else elif while until do time coproc");
const SHELL_DECLARATION = wordSet("local export declare readonly typeset unset alias set");

export class ShellLexer implements Lexer {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  eol(s: Scanner, st: LexerState): LexerState {
    if (s.pending === "") return st;
    const pending = s.pending;
    s.pending = "";
    return push(st, this, SH_HEREDOC, pending);
  }

  step(s: Scanner, st: LexerState): LexerState {
    switch (st.mode) {
      case SH_DQ:
        return this.doubleQuoted(s, st);
      case SH_SQ:
      case SH_BACKTICK: {
        const close = s.line.indexOf(st.mode === SH_SQ ? "'" : "`", s.pos);
        if (close < 0 || close >= s.end) {
          s.rest(T.string);
          return st;
        }
        s.emit(close + 1, T.string);
        return st.parent!;
      }
      case SH_HEREDOC:
        return this.heredoc(s, st);
      default:
        if ((s.flags & STARTED) === 0) s.flags |= STARTED | CMD;
        return this.code(s, st);
    }
  }

  private code(s: Scanner, state: LexerState): LexerState {
    const line = s.line;
    let st = state;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      const next = s.peek(1);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 35 && (at === 0 || isSpace(line.charCodeAt(at - 1)))) {
        s.rest(T.comment);
        break;
      }
      if (c === 34) {
        s.emit(at + 1, T.string);
        s.flags &= ~CMD;
        return push(st, this, SH_DQ);
      }
      if (c === 39 || c === 96 || (c === 36 && next === 39)) {
        const quote = c === 96 ? "`" : "'";
        const start = c === 36 ? at + 2 : at + 1;
        const close = line.indexOf(quote, start);
        s.flags &= ~CMD;
        if (close < 0 || close >= s.end) {
          s.rest(T.string);
          return push(st, this, c === 96 ? SH_BACKTICK : SH_SQ);
        }
        s.emit(close + 1, T.string);
        continue;
      }
      if (c === 36) {
        const pushed = this.dollar(s, st);
        if (pushed !== null) return pushed;
        s.flags &= ~CMD;
        continue;
      }
      if (c === 92) {
        s.emit(Math.min(at + 2, s.end), T.stringEscape);
        continue;
      }
      if (c === 60 && next === 60 && line.charCodeAt(at + 2) !== 60 && this.heredocOpen(s))
        continue;
      if (c === 41 && st.mode === SH_SUBST) {
        if (st.data === "0") {
          s.emit(at + 1, T.punctuationSpecial);
          return st.parent!;
        }
        st = replace(st, SH_SUBST, String(Number(st.data) - 1));
        s.emit(at + 1, T.punctuationBracket);
        continue;
      }
      if (
        c === 40 ||
        c === 41 ||
        c === 123 ||
        c === 125 ||
        ((c === 91 || c === 93) &&
          (isSpace(next) || next < 0 || next === 91 || next === 93 || next === 59))
      ) {
        if (c === 40 && st.mode === SH_SUBST)
          st = replace(st, SH_SUBST, String(Number(st.data) + 1));
        let end = at + 1;
        if ((c === 91 || c === 93) && next === c) end++;
        s.emit(end, T.punctuationBracket);
        if (c === 40 || c === 123) s.flags |= CMD;
        else s.flags &= ~CMD;
        continue;
      }
      if (c === 124 || c === 38 || c === 59 || c === 60 || c === 62 || c === 33) {
        let end = at + 1;
        while (end < s.end && "|&;<>!".includes(line[end]!)) end++;
        s.emit(end, T.operator);
        const op = line.slice(at, end);
        s.flags &= ~(ASSIGN | LOOP_VAR | DEFINE);
        if (op.includes("|") || op.includes(";") || op === "&&" || op === "&" || op === "!")
          s.flags |= CMD;
        else s.flags &= ~CMD;
        continue;
      }
      this.word(s);
    }
    return st;
  }

  private word(s: Scanner): void {
    const line = s.line;
    const at = s.pos;
    let end = at;
    let eq = -1;
    while (end < s.end) {
      const d = line.charCodeAt(end);
      if (d === 32 || d === 9 || "|&;()<>\"'`$\\".includes(line[end]!)) break;
      if (d === 61 && eq < 0) eq = end;
      end++;
    }
    if (end === at) {
      s.emit(at + 1, T.none);
      return;
    }
    const word = line.slice(at, end);
    const flags = s.flags;
    if (
      (flags & (CMD | ASSIGN)) !== 0 &&
      eq > at &&
      /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?$/u.test(line.slice(at, eq))
    ) {
      s.emit(eq, T.variable);
      s.emit(eq + 1, T.operator);
      if (end > s.pos) s.emit(end, isNumeric(line.slice(s.pos, end)) ? T.number : T.string);
      return;
    }
    if (
      SHELL_CONTROL.has(word) &&
      ((flags & CMD) !== 0 || word === "in" || word === "do" || word === "then")
    ) {
      s.emit(end, word === "function" ? T.keywordDeclaration : T.keywordControl);
      if (word === "for" || word === "select" || word === "case")
        s.flags = (flags & ~CMD) | LOOP_VAR;
      else if (word === "function") s.flags = (flags & ~CMD) | DEFINE;
      else if (SHELL_BEFORE_COMMAND.has(word)) s.flags |= CMD;
      else s.flags &= ~CMD;
      return;
    }
    s.flags &= ~(CMD | LOOP_VAR | DEFINE);
    if ((flags & DEFINE) !== 0) s.emit(end, T.functionDefinition);
    else if ((flags & (LOOP_VAR | ASSIGN)) !== 0 && word.charCodeAt(0) !== 45)
      s.emit(end, T.variable);
    else if ((flags & CMD) !== 0) {
      if (SHELL_DECLARATION.has(word)) {
        s.emit(end, T.keywordDeclaration);
        s.flags |= ASSIGN;
        return;
      }
      const after = skipSpaces(line, end, s.end);
      s.emit(end, line.startsWith("()", after) ? T.functionDefinition : T.function);
    } else if (word.charCodeAt(0) === 45) s.emit(end, T.variableParameter);
    else s.emit(end, isNumeric(word) ? T.number : T.none);
  }

  /** `$name`, `${...}`, `$(...)`, `$((...))`, and special parameters. */
  private dollar(s: Scanner, st: LexerState): LexerState | null {
    const line = s.line;
    const at = s.pos;
    const next = s.peek(1);
    if (next === 40) {
      const arithmetic = s.peek(2) === 40;
      s.emit(at + (arithmetic ? 3 : 2), T.punctuationSpecial);
      s.flags = arithmetic ? s.flags & ~CMD : s.flags | CMD;
      return push(st, this, SH_SUBST, arithmetic ? "1" : "0");
    }
    if (next === 123) {
      const close = line.indexOf("}", at);
      s.emit(at + 2, T.punctuationSpecial);
      if (close < 0 || close >= s.end) {
        s.rest(T.variable);
        return null;
      }
      s.emit(close, T.variable);
      s.emit(close + 1, T.punctuationSpecial);
      return null;
    }
    if (isLetter(next)) s.emit(wordEnd(line, at + 1, s.end), T.variable);
    else if (next >= 0 && (isDigit(next) || "@*#?$!-_".includes(line[at + 1]!)))
      s.emit(at + 2, T.variable);
    else s.emit(at + 1, T.none);
    return null;
  }

  private doubleQuoted(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    for (let i = s.pos; i < s.end;) {
      const c = line.charCodeAt(i);
      if (c === 92) {
        s.emit(i, T.string);
        s.emit(Math.min(i + 2, s.end), T.stringEscape);
        i = s.pos;
        continue;
      }
      if (c === 34) {
        s.emit(i + 1, T.string);
        return st.parent!;
      }
      if (c === 36 && i + 1 < s.end) {
        s.emit(i, T.string);
        const pushed = this.dollar(s, st);
        if (pushed !== null) return pushed;
        i = s.pos;
        continue;
      }
      i++;
    }
    s.rest(T.string);
    return st;
  }

  private heredocOpen(s: Scanner): boolean {
    const line = s.line;
    let at = s.pos + 2;
    const dash = line[at] === "-" || line[at] === "~";
    if (dash) at++;
    const opEnd = at;
    at = skipSpaces(line, at, s.end);
    const quote = line[at] === "'" || line[at] === '"' ? line[at]! : "";
    const nameStart = at + quote.length;
    let nameEnd = nameStart;
    while (
      nameEnd < s.end &&
      !isSpace(line.charCodeAt(nameEnd)) &&
      !"'\";|&<>()".includes(line[nameEnd]!)
    )
      nameEnd++;
    if (nameEnd === nameStart) return false;
    s.emit(opEnd, T.operator);
    s.ws();
    s.emit(nameEnd + (line[nameEnd] === quote && quote ? 1 : 0), T.string);
    s.pending = `${dash ? "~" : "="}${quote ? "r" : "i"}${line.slice(nameStart, nameEnd)}`;
    return true;
  }

  private heredoc(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    const delimiter = st.data.slice(2);
    if (s.pos === 0) {
      let start = 0;
      if (st.data[0] === "~")
        while (line.charCodeAt(start) === 9 || line.charCodeAt(start) === 32) start++;
      if (line.slice(start).trimEnd() === delimiter) {
        s.emit(start, T.none);
        s.rest(T.string);
        return st.parent!;
      }
    }
    if (st.data[1] === "r") {
      s.rest(T.string);
      return st;
    }
    for (let i = s.pos; i < s.end;) {
      if (line.charCodeAt(i) === 36 && i + 1 < s.end) {
        s.emit(i, T.string);
        const pushed = this.dollar(s, st);
        if (pushed !== null) return pushed;
        i = s.pos;
        continue;
      }
      i++;
    }
    s.rest(T.string);
    return st;
  }
}

const DOCKER_INSTRUCTIONS = wordSet(
  "from run cmd copy add env arg expose workdir entrypoint label user volume healthcheck shell onbuild stopsignal maintainer",
);
const DOCKER_SHELL = wordSet("run cmd entrypoint shell healthcheck");

export class DockerfileLexer implements Lexer {
  readonly name = "dockerfile";
  private readonly lookup: LexerLookup;

  constructor(lookup: LexerLookup) {
    this.lookup = lookup;
  }

  embedEnd(line: string, pos: number): number {
    return lineEmbedEnd(line, pos);
  }

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    if (st.mode === EMBED_LINE) return st.parent!;
    s.ws();
    if (s.pos === skipSpaces(line, 0) && line.charCodeAt(s.pos) === 35) {
      s.rest(T.comment);
      return st;
    }
    const end = wordEnd(line, s.pos, s.end);
    const word = line.slice(s.pos, end).toLowerCase();
    if (s.pos === skipSpaces(line, 0) && DOCKER_INSTRUCTIONS.has(word)) {
      s.emit(end, T.keyword);
      s.ws();
      if (DOCKER_SHELL.has(word) && line.charCodeAt(s.pos) !== 91)
        return embedLine(this, st, this.lookup("bash"));
    }
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 34 || c === 39) {
        const close = line.indexOf(line[at]!, at + 1);
        s.emit(close < 0 ? s.end : close + 1, T.string);
      } else if (c === 36) {
        const close =
          line.charCodeAt(at + 1) === 123
            ? line.indexOf("}", at) + 1
            : wordEnd(line, at + 1, s.end);
        s.emit(close > at + 1 ? close : at + 1, T.variable);
      } else if (c === 91 || c === 93) s.emit(at + 1, T.punctuationBracket);
      else if (c === 44) s.emit(at + 1, T.punctuationDelimiter);
      else if (c === 61) s.emit(at + 1, T.operator);
      else if (c === 92 && at === s.end - 1) s.emit(at + 1, T.punctuationSpecial);
      else {
        let wordStop = at + 1;
        while (wordStop < s.end && !" \t=\"'$,[]".includes(line[wordStop]!)) wordStop++;
        const text = line.slice(at, wordStop);
        const isKey = line.charCodeAt(wordStop) === 61;
        s.emit(
          wordStop,
          isKey
            ? T.variable
            : text.toUpperCase() === "AS"
              ? T.keyword
              : text.startsWith("--")
                ? T.variableParameter
                : isNumeric(text)
                  ? T.number
                  : T.string,
        );
      }
    }
    return st;
  }
}

const MAKE_DIRECTIVES = wordSet(
  "include -include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override vpath private",
);

export class MakefileLexer implements Lexer {
  readonly name: string;
  private readonly lookup: LexerLookup;

  constructor(name: "makefile" | "just", lookup: LexerLookup) {
    this.name = name;
    this.lookup = lookup;
  }

  embedEnd(line: string, pos: number): number {
    return lineEmbedEnd(line, pos);
  }

  step(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    if (st.mode === EMBED_LINE) return st.parent!;
    const recipe = this.name === "just" ? isSpace(line.charCodeAt(0)) : line.charCodeAt(0) === 9;
    if (s.pos === 0 && recipe) {
      s.ws();
      return embedLine(this, st, this.lookup("bash"));
    }
    s.ws();
    if (line.charCodeAt(s.pos) === 35) {
      s.rest(T.comment);
      return st;
    }
    const first = wordEnd(line, s.pos, s.end, "-.%/");
    const word = line.slice(s.pos, first);
    if (MAKE_DIRECTIVES.has(word)) s.emit(first, T.keyword);
    else {
      let i = s.pos;
      while (i < s.end && !":=?+!#".includes(line[i]!)) i++;
      const op = line.slice(i, i + 2);
      if (/^(?::=|\?=|\+=|!=|=)/u.test(op) || line.startsWith("::=", i)) {
        s.emit(i, T.variable);
        s.ws();
        const opEnd = line.startsWith("::=", i) ? i + 3 : op[1] === "=" ? i + 2 : i + 1;
        s.emit(opEnd, T.operator);
      } else if (line[i] === ":") {
        s.emit(i, word.startsWith(".") ? T.keyword : T.function);
        s.emit(line[i + 1] === ":" ? i + 2 : i + 1, T.punctuationDelimiter);
      }
    }
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 36) {
        const open = line[at + 1];
        if (open === "(" || open === "{") {
          const close = line.indexOf(open === "(" ? ")" : "}", at);
          s.emit(close < 0 ? s.end : close + 1, T.variable);
        } else s.emit(Math.min(at + 2, s.end), T.variable);
        continue;
      }
      if (c === 35) {
        s.rest(T.comment);
        break;
      }
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      let end = at + 1;
      while (
        end < s.end &&
        line.charCodeAt(end) !== 36 &&
        line.charCodeAt(end) !== 35 &&
        !isSpace(line.charCodeAt(end))
      )
        end++;
      s.emit(end, T.none);
    }
    return st;
  }
}

export const csvLexer: Lexer = {
  name: "csv",
  step(s, st) {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 44 || c === 59 || c === 9) {
        s.emit(at + 1, T.punctuationDelimiter);
        continue;
      }
      if (c === 34) {
        let end = at + 1;
        while (end < s.end && !(line.charCodeAt(end) === 34 && line.charCodeAt(end + 1) !== 34))
          end += line.charCodeAt(end) === 34 ? 2 : 1;
        s.emit(Math.min(end + 1, s.end), T.string);
        continue;
      }
      let end = at;
      while (end < s.end && !",;\t".includes(line[end]!)) end++;
      s.emit(end, isNumeric(line.slice(at, end).trim()) ? T.number : T.none);
    }
    return st;
  },
};
