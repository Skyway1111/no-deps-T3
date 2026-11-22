import {
  isDigit,
  isLetter,
  isSpace,
  isUpper,
  isWordChar,
  numberEnd,
  push,
  replace,
  skipSpaces,
  wordEnd,
  type Lexer,
  type LexerState,
  type Scanner,
} from "./lexer.ts";
import { T } from "./tokens.ts";

export interface StringRule {
  readonly open: string;
  /** Defaults to `open`. */
  readonly close?: string;
  readonly token?: number;
  readonly multiline?: boolean;
  /** Backslash escapes. Defaults to true. */
  readonly escape?: boolean;
  /** Opens embedded code, such as `${` or `#{`. */
  readonly interp?: string;
  /** Letters that may precede `open`; `interpPrefix` letters among them enable `interp`. */
  readonly prefixes?: string;
  readonly interpPrefix?: string;
  /** `$name` inside the string is a variable. */
  readonly vars?: boolean;
  /** A doubled close (`''`) is an escape. */
  readonly doubled?: boolean;
}

/** A delimiter computed from the opener, such as Rust's `r#"`…`"#`. */
export interface DynamicDelimiter {
  readonly length: number;
  readonly close: string;
}

type WordToken = Exclude<keyof typeof T, "constructor"> | "ctor";

export interface LangSpec {
  readonly name: string;
  readonly lineComment?: ReadonlyArray<string>;
  readonly blockComment?: ReadonlyArray<readonly [open: string, close: string]>;
  readonly nestedComments?: boolean;
  /** Comment openers that mark documentation (`/**`, `///`). */
  readonly docComment?: ReadonlyArray<string>;
  readonly strings?: ReadonlyArray<StringRule>;
  readonly rawString?: (line: string, at: number, end: number) => DynamicDelimiter | null;
  /** Characters that may begin `rawString` or `rawComment`. */
  readonly rawStarts?: string;
  readonly rawComment?: (line: string, at: number, end: number) => DynamicDelimiter | null;
  /** Space-separated words per token. */
  readonly words?: Partial<Record<WordToken, string>>;
  readonly caseInsensitive?: boolean;
  /** Extra identifier characters, such as `$` or `-`; they start a word only before a letter. */
  readonly identChars?: string;
  /** Characters allowed inside but not at the start of identifiers, such as `?` and `!`. */
  readonly identPart?: string;
  /** The first word of a line takes this token (`name:` becomes a label); `.name` is a directive. */
  readonly head?: WordToken;
  /** A word directly after `(` is a call (Lisp, WebAssembly text). */
  readonly lisp?: boolean;
  /** `name = value`: `name` is a property. */
  readonly assignKeys?: boolean;
  /** Token for sigil words. Defaults to variable. */
  readonly sigilToken?: WordToken;
  /** Literal markers colored as preprocessor directives, such as `<?php`. */
  readonly markers?: ReadonlyArray<string>;
  /** Characters that start a variable, such as `$` or `@`. */
  readonly sigils?: string;
  /** `@name` is an attribute (decorators, annotations). */
  readonly annotation?: boolean;
  /** Rust-style `#[derive(..)]` and `#![..]`. */
  readonly hashAttribute?: boolean;
  /** `#directive` at line start. */
  readonly preprocessor?: boolean;
  /** Capitalized identifiers are types. Default true. */
  readonly capitalTypes?: boolean;
  /** ALL_CAPS identifiers are constants. Default true. */
  readonly constantCase?: boolean;
  /** Keywords whose next identifier is a function definition. */
  readonly functionDecl?: string;
  /** Keywords whose next identifier is a type definition. */
  readonly typeDecl?: string;
  /** Keywords whose next (dotted) identifier is a namespace. */
  readonly namespaceDecl?: string;
  /** `->` accesses members (C, C++, PHP, Perl). */
  readonly arrowMember?: boolean;
  /** Parameters are written name-first without a colon (`a, b int`). */
  readonly nameFirstParams?: boolean;
  readonly regex?: boolean;
  readonly jsx?: boolean;
  /** `name!(` is a macro call. */
  readonly macroBang?: boolean;
  /** `'a` is a lifetime label rather than a char literal. */
  readonly lifetimes?: boolean;
  /** `:name` and `name:` are symbols. */
  readonly symbols?: boolean;
  /** A string followed by `:` is a JSON key. */
  readonly jsonKeys?: boolean;
  readonly heredoc?: "ruby" | "php" | "perl";
  /** `a::b` paths: `a` is a namespace. */
  readonly pathSep?: boolean;
}

const OPEN_MARKER = 0;
const OPEN_RAW_COMMENT = 1;
const OPEN_BLOCK = 2;
const OPEN_LINE = 3;
const OPEN_RAW_STRING = 4;
const OPEN_STRING = 5;

interface Opener {
  readonly kind: number;
  readonly open: string;
  readonly close: string;
  readonly rule: number;
}

interface StringFlags {
  readonly escape: boolean;
  readonly vars: boolean;
  readonly doubled: boolean;
}

interface CompiledRule extends StringFlags {
  readonly index: number;
  readonly open: string;
  readonly close: string;
  readonly token: number;
  readonly multiline: boolean;
  readonly interp: string;
  readonly prefixes: string;
  readonly interpPrefix: string;
  readonly jsonKey: boolean;
}

interface KeywordEntry {
  readonly word: string;
  readonly token: number;
  readonly decl: number;
}

const KEYWORD_BUCKETS = 1024;

function lower(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

const KEYWORD_LENGTH_SALT = 0x9e3779b1;

function keywordHash(word: string): number {
  let hash = 0;
  for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) | 0;
  return (hash + Math.imul(word.length, KEYWORD_LENGTH_SALT)) & (KEYWORD_BUCKETS - 1);
}

const HEREDOC_VARS: StringFlags = { escape: true, vars: true, doubled: false };
const HEREDOC_PLAIN: StringFlags = { escape: true, vars: false, doubled: false };

const COMMENT = 1;
const STRING = 2;
const INTERP = 3;
const PARAMS = 4;
const HEREDOC = 5;
const JSX_TAG = 6;
const JSX_CHILD = 7;
const RAW = 8;

const DECL_FUNC = 1;
const DECL_TYPE = 2;
const PREV_DOT = 4;
const AFTER_COLON = 8;
const AFTER_EQ = 16;
const ATTR_NEXT = 32;
const PARAMS_NEXT = 64;
const SLOT_USED = 128;
const DECL_NS = 256;

const VALUE_TOKENS = new Set<number>([
  T.boolean,
  T.constant,
  T.constantBuiltin,
  T.variableSpecial,
  T.number,
  T.string,
]);

function tokenId(name: WordToken): number {
  return name === "ctor" ? T.constructor : T[name];
}

function closeOf(open: string): string {
  return open.endsWith("(") ? ")" : "}";
}

export class ClikeLexer implements Lexer {
  readonly name: string;
  readonly spec: LangSpec;
  private readonly words = new Map<string, number>();
  /** Keywords hashed by char codes so identifiers are looked up without slicing. */
  private readonly keywordTable: Array<KeywordEntry[] | undefined> = new Array(KEYWORD_BUCKETS);
  private readonly functionDecl: ReadonlySet<string>;
  private readonly typeDecl: ReadonlySet<string>;
  private readonly namespaceDecl: ReadonlySet<string>;
  /** Comment, string, and marker openers by first ASCII character, in precedence order. */
  private readonly openers: Array<Opener[] | undefined> = new Array(128);
  private readonly rules: CompiledRule[] = [];
  private readonly docComments: ReadonlyArray<string>;
  private readonly identChars: string;
  private readonly wordChars: string;
  private readonly capitalTypes: boolean;
  private readonly constantCase: boolean;

  constructor(spec: LangSpec) {
    this.name = spec.name;
    this.spec = spec;
    for (const [name, list] of Object.entries(spec.words ?? {})) {
      for (const raw of list!.split(" ")) {
        if (!raw) continue;
        const word = spec.caseInsensitive ? raw.toLowerCase() : raw;
        this.words.set(word, tokenId(name as WordToken));
      }
    }
    const set = (list: string | undefined) => new Set((list ?? "").split(" ").filter(Boolean));
    this.functionDecl = set(spec.functionDecl);
    this.typeDecl = set(spec.typeDecl);
    this.namespaceDecl = set(spec.namespaceDecl);
    const add = (chars: string, op: Opener) => {
      for (const char of chars) {
        const c = char.charCodeAt(0);
        if (c >= 128) continue;
        const list = (this.openers[c] ??= []);
        if (!list.includes(op)) list.push(op);
      }
    };
    for (const marker of spec.markers ?? [])
      add(marker[0]!, { kind: OPEN_MARKER, open: marker, close: "", rule: 0 });
    if (spec.rawComment)
      add(spec.rawStarts ?? "", { kind: OPEN_RAW_COMMENT, open: "", close: "", rule: 0 });
    for (const [open, close] of spec.blockComment ?? [])
      add(open[0]!, { kind: OPEN_BLOCK, open, close, rule: 0 });
    for (const open of spec.lineComment ?? [])
      add(open[0]!, { kind: OPEN_LINE, open, close: "", rule: 0 });
    if (spec.rawString)
      add(spec.rawStarts ?? "", { kind: OPEN_RAW_STRING, open: "", close: "", rule: 0 });
    (spec.strings ?? []).forEach((rule, index) => {
      this.rules.push({
        index,
        open: rule.open,
        close: rule.close ?? rule.open,
        token: rule.token ?? T.string,
        multiline: rule.multiline ?? false,
        escape: rule.escape ?? true,
        interp: rule.interp ?? "",
        prefixes: rule.prefixes ?? "",
        interpPrefix: rule.interpPrefix ?? "",
        vars: rule.vars ?? false,
        doubled: rule.doubled ?? false,
        jsonKey: (spec.jsonKeys ?? false) && !rule.multiline,
      });
      add(rule.open[0]! + (rule.prefixes ?? ""), {
        kind: OPEN_STRING,
        open: rule.open,
        close: "",
        rule: index,
      });
    });
    this.docComments = spec.docComment ?? [];
    for (const [word, token] of this.words) {
      const decl = this.functionDecl.has(word)
        ? DECL_FUNC
        : this.typeDecl.has(word)
          ? DECL_TYPE
          : this.namespaceDecl.has(word)
            ? DECL_NS
            : 0;
      (this.keywordTable[keywordHash(word)] ??= []).push({ word, token, decl });
    }
    this.identChars = spec.identChars ?? "";
    this.wordChars = this.identChars + (spec.identPart ?? "");
    this.capitalTypes = spec.capitalTypes ?? true;
    this.constantCase = spec.constantCase ?? true;
  }

  /** Code embedded by another lexer that ends at an unmatched `}`. */
  interpState(parent: LexerState, depth = 0): LexerState {
    return push(parent, this, INTERP, `}s${depth}`);
  }

  step(s: Scanner, st: LexerState): LexerState {
    switch (st.mode) {
      case COMMENT:
        return this.comment(s, st);
      case STRING:
        return this.string(s, st);
      case RAW:
        return this.raw(s, st);
      case HEREDOC:
        return this.heredocBody(s, st);
      case JSX_TAG:
        return this.jsxTag(s, st);
      case JSX_CHILD:
        return this.jsxChild(s, st);
      default:
        return this.code(s, st);
    }
  }

  eol(s: Scanner, st: LexerState): LexerState {
    if (s.pending !== "") {
      const pending = s.pending;
      s.pending = "";
      return push(st, this, HEREDOC, pending);
    }
    if (st.mode === STRING && !this.rules[st.data.charCodeAt(0) - 48]!.multiline) return st.parent!;
    if (st.mode === INTERP && st.parent?.mode === STRING && st.parent.lexer === this) {
      if (!this.rules[st.parent.data.charCodeAt(0) - 48]!.multiline) return st.parent.parent!;
    }
    return st;
  }

  /** Root code, embedded `${}` code, and parameter lists. */
  private code(s: Scanner, state: LexerState): LexerState {
    const spec = this.spec;
    const line = s.line;
    let st = state;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 39 && spec.lifetimes && isLetter(s.peek(1)) && s.peek(2) !== 39) {
        s.emit(wordEnd(line, at + 1, s.end), T.label);
        continue;
      }
      if (c < 128 && this.openers[c] !== undefined) {
        const next = this.opener(s, st, c);
        if (next !== null) return next;
        if (s.pos !== at) continue;
      }
      if (
        isLetter(c) ||
        (this.identChars !== "" && this.identChars.indexOf(line[at]!) >= 0 && isLetter(s.peek(1)))
      ) {
        this.word(s, st);
        continue;
      }
      if (isDigit(c) || ((c === 46 || c === 45) && isDigit(s.peek(1)) && !s.valueEnd)) {
        s.emit(numberEnd(line, c === 45 ? at + 1 : at, s.end), T.number);
        s.valueEnd = true;
        s.flags &= ~PREV_DOT;
        continue;
      }
      const next = s.peek(1);
      if (
        spec.sigils &&
        spec.sigils.indexOf(line[at]!) >= 0 &&
        (isLetter(next) || next === 123 || spec.sigils.indexOf(line[at + 1] ?? "\0") >= 0)
      ) {
        if (this.sigil(s)) continue;
      }
      switch (c) {
        case 64: // @
          if (spec.annotation && (isLetter(next) || (next === 64 && isLetter(s.peek(2))))) {
            s.emit(wordEnd(line, at + (next === 64 ? 2 : 1), s.end, "."), T.attribute);
            continue;
          }
          break;
        case 35: // #
          if (spec.hashAttribute && (next === 91 || (next === 33 && s.peek(2) === 91))) {
            s.emit(at + (next === 33 ? 2 : 1), T.attribute);
            s.flags |= ATTR_NEXT;
            continue;
          }
          if (spec.preprocessor && skipSpaces(line, 0) === at) {
            this.preprocessor(s);
            continue;
          }
          break;
        case 47: // /
          if (spec.regex && !s.valueEnd && next !== 47 && next !== 42 && this.regex(s)) continue;
          break;
        case 60: // <
          if (spec.jsx && !s.valueEnd) {
            const jsx = this.jsxOpen(s, st);
            if (jsx !== null) return jsx;
          }
          if (spec.heredoc && next === 60 && this.heredocOpen(s)) continue;
          break;
        case 58: // :
          if (next === 58) {
            s.emit(at + 2, T.punctuationDelimiter);
            s.valueEnd = false;
            continue;
          }
          if (spec.symbols && isLetter(next) && !isSymbolBlocker(line.charCodeAt(at - 1))) {
            s.emit(wordEnd(line, at + 1, s.end, "?!"), T.stringSpecialSymbol);
            s.valueEnd = true;
            continue;
          }
          s.emit(at + 1, T.punctuationDelimiter);
          s.flags = (s.flags | AFTER_COLON) & ~PREV_DOT;
          s.valueEnd = false;
          continue;
      }
      if (c === 40 || c === 91 || c === 123) {
        s.emit(at + 1, T.punctuationBracket);
        s.valueEnd = false;
        const flags = s.flags;
        s.flags &= ~(PREV_DOT | AFTER_COLON | SLOT_USED);
        if (c === 123) s.flags &= ~(DECL_FUNC | DECL_TYPE | PARAMS_NEXT);
        const interpClose = st.mode === INTERP ? st.data.charCodeAt(0) : -1;
        if ((c === 123 && interpClose === 125) || (c === 40 && interpClose === 41)) {
          st = replace(st, INTERP, st.data.slice(0, 2) + (Number(st.data.slice(2)) + 1));
        } else if (st.mode === PARAMS && c === 40) {
          st = replace(st, PARAMS, String(Number(st.data) + 1));
        } else if (c === 40 && (flags & (PARAMS_NEXT | DECL_FUNC)) !== 0) {
          s.flags &= ~PARAMS_NEXT;
          return push(st, this, PARAMS, "0");
        }
        continue;
      }
      if (c === 41 || c === 93 || c === 125) {
        if (st.mode === INTERP && c === st.data.charCodeAt(0)) {
          const depth = Number(st.data.slice(2));
          if (depth === 0) {
            s.emit(at + 1, st.data[1] === "j" ? T.punctuationBracket : T.punctuationSpecial);
            s.valueEnd = true;
            return st.parent!;
          }
          st = replace(st, INTERP, st.data.slice(0, 2) + (depth - 1));
        } else if (st.mode === PARAMS && c === 41) {
          const depth = Number(st.data);
          s.emit(at + 1, T.punctuationBracket);
          s.valueEnd = true;
          s.flags &= ~(AFTER_COLON | AFTER_EQ);
          if (depth === 0) return st.parent!;
          st = replace(st, PARAMS, String(depth - 1));
          continue;
        }
        s.emit(at + 1, T.punctuationBracket);
        s.valueEnd = true;
        s.flags &= ~(PREV_DOT | ATTR_NEXT);
        continue;
      }
      if (c === 44 || c === 59) {
        s.emit(at + 1, T.punctuationDelimiter);
        s.valueEnd = false;
        s.flags &= ~(
          PREV_DOT |
          AFTER_COLON |
          AFTER_EQ |
          SLOT_USED |
          (c === 59 ? DECL_FUNC | DECL_TYPE | PARAMS_NEXT : 0)
        );
        continue;
      }
      if (c === 46 && next !== 46) {
        s.emit(at + 1, T.punctuationDelimiter);
        s.flags |= PREV_DOT;
        s.valueEnd = false;
        continue;
      }
      if (isOperator(c)) {
        let end = at + 1;
        while (end < s.end && isOperator(line.charCodeAt(end))) end++;
        // Stop before a comment opener glued to an operator (`=//`).
        for (let k = at + 1; k < end; k++) {
          if (
            line.charCodeAt(k) === 47 &&
            (line.charCodeAt(k + 1) === 47 || line.charCodeAt(k + 1) === 42)
          ) {
            end = k;
            break;
          }
        }
        s.emit(end, T.operator);
        const op = line.slice(at, end);
        s.flags &= ~(PREV_DOT | AFTER_COLON);
        if ((spec.arrowMember && op.endsWith("->")) || op.endsWith("?.")) s.flags |= PREV_DOT;
        if (op === "=" || op === "=>") {
          s.flags = (s.flags | AFTER_EQ) & ~(DECL_FUNC | DECL_TYPE | PARAMS_NEXT);
        }
        s.valueEnd = false;
        continue;
      }
      s.emit(at + 1, T.none);
    }
    return st;
  }

  /** Comments and strings. Returns a new state, or null after consuming text in place. */
  private opener(s: Scanner, st: LexerState, c: number): LexerState | null {
    const spec = this.spec;
    const line = s.line;
    const at = s.pos;
    for (const op of this.openers[c]!) {
      switch (op.kind) {
        case OPEN_MARKER:
          if (!s.startsWith(op.open)) break;
          s.emit(at + op.open.length, T.preproc);
          return null;
        case OPEN_RAW_COMMENT: {
          const raw = spec.rawComment!(line, at, s.end);
          if (!raw) break;
          s.emit(at + raw.length, T.comment);
          return push(st, this, COMMENT, `c${raw.close}`);
        }
        case OPEN_BLOCK: {
          if (!s.startsWith(op.open)) break;
          const close = op.close;
          const doc = this.isDoc(s, close, op.open.length);
          const token = doc ? T.commentDoc : T.comment;
          s.emit(at + op.open.length, token);
          const closeAt = line.indexOf(close, s.pos);
          const nestedAt = spec.nestedComments ? line.indexOf(op.open, s.pos) : -1;
          if (
            closeAt >= 0 &&
            closeAt + close.length <= s.end &&
            (nestedAt < 0 || nestedAt > closeAt)
          ) {
            if (doc) docText(s, closeAt, token);
            s.emit(closeAt + close.length, token);
            return null;
          }
          return push(st, this, COMMENT, (doc ? "d" : "c") + close);
        }
        case OPEN_LINE:
          if (!s.startsWith(op.open)) break;
          if (this.isDoc(s, "", 0)) docText(s, s.end, T.commentDoc);
          else s.rest(T.comment);
          return null;
        case OPEN_RAW_STRING: {
          const raw = spec.rawString!(line, at, s.end);
          if (!raw) break;
          s.emit(at + raw.length, T.string);
          return push(st, this, RAW, raw.close);
        }
        default: {
          const next = this.openString(s, st, this.rules[op.rule]!);
          if (next !== undefined) return next;
        }
      }
    }
    return null;
  }

  /** Whether a comment at `s.pos` opens with a doc prefix (`/**`, but not the empty `/**\/`). */
  private isDoc(s: Scanner, close: string, openLength: number): boolean {
    for (const prefix of this.docComments) {
      if (s.startsWith(prefix) && (close === "" || !s.startsWith(close, s.pos + openLength - 1)))
        return true;
    }
    return false;
  }

  /** A string at `s.pos`: undefined if `rule` does not match, null once consumed in place. */
  private openString(
    s: Scanner,
    st: LexerState,
    rule: CompiledRule,
  ): LexerState | null | undefined {
    const line = s.line;
    const at = s.pos;
    let k = at;
    if (rule.prefixes !== "") {
      while (k < s.end && k - at < 3 && rule.prefixes.indexOf(line[k]!) >= 0) k++;
      // A prefix must stand alone: `buffer"` is an identifier, not a prefixed string.
      if (k > at && isWordChar(line.charCodeAt(k)) && !line.startsWith(rule.open, k))
        return undefined;
      if (k > at && isWordChar(line.charCodeAt(at - 1))) return undefined;
    }
    if (k + rule.open.length > s.end || !line.startsWith(rule.open, k)) return undefined;
    if (rule.jsonKey) {
      const close = closingQuote(line, k + rule.open.length, s.end, rule.close);
      if (close >= 0 && line.charCodeAt(skipSpaces(line, close, s.end)) === 58) {
        s.emit(close, T.propertyJsonKey);
        s.valueEnd = true;
        return null;
      }
    }
    let interp = rule.interp !== "";
    if (rule.interpPrefix !== "") {
      interp = false;
      for (let p = at; p < k; p++) if (rule.interpPrefix.indexOf(line[p]!) >= 0) interp = true;
    }
    s.emit(k + rule.open.length, rule.token);
    s.flags &= ~PREV_DOT;
    // Strings that close on this line need no frame.
    const data = String.fromCharCode(48 + rule.index) + (interp ? "i" : "-");
    const result = this.stringBody(
      s,
      st,
      data,
      rule.token,
      rule.close,
      interp ? rule.interp : "",
      rule,
    );
    if (result === "close") {
      s.valueEnd = true;
      return null;
    }
    return result ?? push(st, this, STRING, data);
  }

  private comment(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    const doc = st.data.charCodeAt(0) === 100;
    const close = st.data.slice(1);
    const token = doc ? T.commentDoc : T.comment;
    let open = "";
    if (this.spec.nestedComments) {
      for (const [o, c] of this.spec.blockComment ?? []) if (c === close) open = o;
    }
    const closeAt = line.indexOf(close, s.pos);
    const openAt = open === "" ? -1 : line.indexOf(open, s.pos);
    if (openAt >= 0 && openAt + open.length <= s.end && (closeAt < 0 || openAt < closeAt)) {
      if (doc) docText(s, openAt + open.length, token);
      else s.emit(openAt + open.length, token);
      return push(st, this, COMMENT, st.data);
    }
    if (closeAt >= 0 && closeAt + close.length <= s.end) {
      if (doc) docText(s, closeAt, token);
      s.emit(closeAt + close.length, token);
      return st.parent!;
    }
    if (doc) docText(s, s.end, token);
    else s.rest(token);
    return st;
  }

  private raw(s: Scanner, st: LexerState): LexerState {
    const closeAt = s.line.indexOf(st.data, s.pos);
    if (closeAt >= 0 && closeAt + st.data.length <= s.end) {
      s.emit(closeAt + st.data.length, T.string);
      s.valueEnd = true;
      return st.parent!;
    }
    s.rest(T.string);
    return st;
  }

  private string(s: Scanner, st: LexerState): LexerState {
    const rule = this.rules[st.data.charCodeAt(0) - 48]!;
    const interp = st.data.charCodeAt(1) === 105 ? rule.interp : "";
    const end = this.stringBody(s, st, null, rule.token, rule.close, interp, rule);
    if (end === null) return st;
    if (end === "close") {
      s.valueEnd = true;
      return st.parent!;
    }
    return end;
  }

  /**
   * Scans string text until `close` (returns "close"), an interpolation
   * (returns the pushed state), or the scan end (returns null). With `data`,
   * `owner` is the parent of a string frame created only if needed.
   */
  private stringBody(
    s: Scanner,
    owner: LexerState,
    data: string | null,
    token: number,
    close: string,
    interp: string,
    rule: StringFlags,
  ): LexerState | "close" | null {
    const line = s.line;
    const end = s.end;
    const escape = rule.escape;
    const closeFirst = close === "" ? -1 : close.charCodeAt(0);
    const interpFirst = interp === "" ? -1 : interp.charCodeAt(0);
    for (let i = s.pos; i < end;) {
      const c = line.charCodeAt(i);
      if (c === interpFirst && line.startsWith(interp, i)) {
        if (interp === "{" && line.charCodeAt(i + 1) === 123) {
          s.emit(i, token);
          s.emit(i + 2, T.stringEscape);
          i += 2;
          continue;
        }
        s.emit(i, token);
        s.emit(i + interp.length, T.punctuationSpecial);
        s.valueEnd = false;
        const frame = data === null ? owner : push(owner, this, STRING, data);
        return push(frame, this, INTERP, `${closeOf(interp)}s0`);
      }
      if (c === 92 && escape) {
        s.emit(i, token);
        s.emit(Math.min(escapeEnd(line, i, end), end), T.stringEscape);
        i = s.pos;
        continue;
      }
      if (c === closeFirst && line.startsWith(close, i) && i + close.length <= end) {
        if (rule.doubled && line.startsWith(close, i + close.length)) {
          i += close.length * 2;
          continue;
        }
        s.emit(i + close.length, token);
        return "close";
      }
      if (c === 36 && rule.vars && isLetter(line.charCodeAt(i + 1))) {
        s.emit(i, token);
        s.emit(wordEnd(line, i + 1, end), T.variable);
        i = s.pos;
        continue;
      }
      i++;
    }
    s.emit(end, token);
    return null;
  }

  private word(s: Scanner, st: LexerState): void {
    const spec = this.spec;
    const line = s.line;
    const start = s.pos;
    // Scan and hash in one pass so keyword lookup needs no substring.
    const fold = this.spec.caseInsensitive ?? false;
    const extra = this.wordChars;
    let end = start;
    let hash = 0;
    while (end < s.end) {
      const c = line.charCodeAt(end);
      if (!isWordChar(c) && (extra === "" || extra.indexOf(line[end]!) < 0)) break;
      hash = (hash * 31 + (fold ? lower(c) : c)) | 0;
      end++;
    }
    const flags = s.flags;
    const next = end < s.end ? line.charCodeAt(end) : -1;
    s.flags &= ~(PREV_DOT | ATTR_NEXT);
    const keyword = this.keyword(line, start, end, hash);
    if (
      keyword !== undefined &&
      ((flags & PREV_DOT) === 0 || keyword.token === T.variableSpecial)
    ) {
      if (keyword.decl === DECL_FUNC) s.flags = (s.flags & ~DECL_TYPE) | DECL_FUNC;
      else if (keyword.decl === DECL_TYPE) s.flags = (s.flags & ~DECL_FUNC) | DECL_TYPE;
      else if (keyword.decl === DECL_NS) s.flags |= DECL_NS;
      s.emit(end, keyword.token);
      s.valueEnd = VALUE_TOKENS.has(keyword.token);
      return;
    }
    let token: number;
    if (spec.head && skipSpaces(line, 0) === start) {
      if (next === 58 && line.charCodeAt(end + 1) !== 58) token = T.label;
      else token = line.charCodeAt(start) === 46 ? T.preproc : tokenId(spec.head);
    } else if (spec.lisp && line.charCodeAt(start - 1) === 40) token = T.function;
    else if ((flags & ATTR_NEXT) !== 0) token = T.attribute;
    else if ((flags & DECL_NS) !== 0) {
      token = T.namespace;
      if (next !== 46) s.flags &= ~DECL_NS;
    } else if ((flags & DECL_FUNC) !== 0 && next !== 46 && st.mode !== PARAMS) {
      token = T.functionDefinition;
      s.flags = (s.flags & ~DECL_FUNC) | PARAMS_NEXT;
    } else if ((flags & DECL_TYPE) !== 0) {
      token = T.typeClass;
      s.flags &= ~DECL_TYPE;
    } else if (spec.macroBang && next === 33 && line.charCodeAt(end + 1) !== 61) token = T.function;
    else if (next === 40) token = (flags & PREV_DOT) !== 0 ? T.functionMethod : T.function;
    else if (spec.jsonKeys && next === 58) token = T.propertyJsonKey;
    else if (
      spec.assignKeys &&
      line.charCodeAt(skipSpaces(line, end, s.end)) === 61 &&
      line.charCodeAt(skipSpaces(line, end, s.end) + 1) !== 61
    ) {
      token = T.property;
    } else if (spec.pathSep && next === 58 && line.charCodeAt(end + 1) === 58) {
      token = this.capitalTypes && isUpper(line.charCodeAt(start)) ? T.type : T.namespace;
    } else if ((flags & PREV_DOT) !== 0) token = T.property;
    else if (
      spec.symbols &&
      next === 58 &&
      line.charCodeAt(end + 1) !== 58 &&
      isSpace(line.charCodeAt(end + 1))
    ) {
      s.emit(end + 1, T.stringSpecialSymbol);
      s.valueEnd = false;
      return;
    } else if (st.mode === PARAMS && (flags & AFTER_EQ) === 0) {
      const typeFirst =
        !spec.nameFirstParams && isLetter(line.charCodeAt(skipSpaces(line, end, s.end)));
      token =
        (flags & AFTER_COLON) !== 0 ||
        typeFirst ||
        (spec.nameFirstParams && (flags & SLOT_USED) !== 0)
          ? T.type
          : T.variableParameter;
      s.flags |= SLOT_USED;
    } else if (this.constantCase && end - start > 1 && isConstantCase(line, start, end))
      token = T.constant;
    else if (this.capitalTypes && isUpper(line.charCodeAt(start))) token = T.type;
    else token = T.variable;
    s.emit(end, token);
    s.valueEnd = true;
  }

  private keyword(
    line: string,
    start: number,
    end: number,
    hash: number,
  ): KeywordEntry | undefined {
    const bucket =
      this.keywordTable[
        (hash + Math.imul(end - start, KEYWORD_LENGTH_SALT)) & (KEYWORD_BUCKETS - 1)
      ];
    if (bucket === undefined) return undefined;
    const length = end - start;
    for (const entry of bucket) {
      if (entry.word.length !== length) continue;
      if (!this.spec.caseInsensitive) {
        if (line.startsWith(entry.word, start)) return entry;
        continue;
      }
      let k = 0;
      while (k < length && lower(line.charCodeAt(start + k)) === entry.word.charCodeAt(k)) k++;
      if (k === length) return entry;
    }
    return undefined;
  }

  private sigil(s: Scanner): boolean {
    const line = s.line;
    const start = s.pos;
    let at = start + 1;
    while (at < s.end && this.spec.sigils!.indexOf(line[at]!) >= 0) at++;
    if (line.charCodeAt(at) === 123) {
      const close = line.indexOf("}", at);
      if (close < 0) return false;
      s.emit(close + 1, T.variable);
      s.valueEnd = true;
      return true;
    }
    const end = wordEnd(line, at, s.end, this.wordChars);
    if (end === at) return false;
    const word = line.slice(start, end);
    const sigilToken = this.spec.sigilToken ? tokenId(this.spec.sigilToken) : T.variable;
    s.emit(
      end,
      this.words.get(this.spec.caseInsensitive ? word.toLowerCase() : word) ?? sigilToken,
    );
    s.flags &= ~PREV_DOT;
    s.valueEnd = true;
    return true;
  }

  private preprocessor(s: Scanner): void {
    const line = s.line;
    const word = wordEnd(line, skipSpaces(line, s.pos + 1, s.end), s.end);
    const directive = line.slice(s.pos, word);
    s.emit(word, T.preproc);
    if (directive.endsWith("include") || directive.endsWith("import")) {
      const at = skipSpaces(line, s.pos, s.end);
      if (line.charCodeAt(at) === 60) {
        const close = line.indexOf(">", at);
        if (close > 0) {
          s.ws();
          s.emit(close + 1, T.string);
        }
      }
    }
  }

  private regex(s: Scanner): boolean {
    const line = s.line;
    let inClass = false;
    for (let i = s.pos + 1; i < s.end; i++) {
      const c = line.charCodeAt(i);
      if (c === 92) {
        i++;
        continue;
      }
      if (c === 91) inClass = true;
      else if (c === 93) inClass = false;
      else if (c === 47 && !inClass) {
        s.emit(wordEnd(line, i + 1, s.end), T.stringRegex);
        s.valueEnd = true;
        return true;
      }
    }
    return false;
  }

  private heredocOpen(s: Scanner): boolean {
    const line = s.line;
    const style = this.spec.heredoc;
    let at = s.pos + 2;
    let indent = false;
    if (style === "php") {
      if (line.charCodeAt(at) !== 60) return false;
      at = skipSpaces(line, at + 1, s.end);
      indent = true;
    } else if (style === "ruby" && (line[at] === "~" || line[at] === "-")) {
      indent = true;
      at++;
    }
    const quote = line[at] === "'" || line[at] === '"' ? line[at]! : "";
    const nameStart = at + quote.length;
    const nameEnd = wordEnd(line, nameStart, s.end);
    if (nameEnd === nameStart) return false;
    if (quote && line[nameEnd] !== quote) return false;
    // `a <<b` is a shift; heredoc names are conventionally upper case.
    if (style !== "php" && !quote && !isUpper(line.charCodeAt(nameStart))) return false;
    s.emit(at, T.operator);
    s.emit(nameEnd + quote.length, T.stringSpecial);
    s.pending = `${indent ? "~" : "="}${quote === "'" ? "r" : "i"}${line.slice(nameStart, nameEnd)}`;
    s.valueEnd = true;
    return true;
  }

  private heredocBody(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    const delimiter = st.data.slice(2);
    if (s.pos === 0) {
      const start = st.data[0] === "~" ? skipSpaces(line, 0) : 0;
      if (
        line.startsWith(delimiter, start) &&
        !isWordChar(line.charCodeAt(start + delimiter.length))
      ) {
        s.emit(start, T.none);
        s.emit(start + delimiter.length, T.stringSpecial);
        s.valueEnd = true;
        return st.parent!;
      }
    }
    const interpolates = st.data[1] === "i";
    const interp = interpolates ? (this.spec.heredoc === "ruby" ? "#{" : "{$") : "";
    const flags = interpolates && this.spec.heredoc !== "ruby" ? HEREDOC_VARS : HEREDOC_PLAIN;
    const result = this.stringBody(s, st, null, T.string, "", interp, flags);
    return result === null || result === "close" ? st : result;
  }

  private jsxOpen(s: Scanner, st: LexerState): LexerState | null {
    const line = s.line;
    const at = s.pos;
    const next = s.peek(1);
    if (next === 62) {
      s.emit(at + 2, T.punctuationBracketJsx);
      return push(st, this, JSX_CHILD);
    }
    if (!isLetter(next)) return null;
    const nameEnd = wordEnd(line, at + 1, s.end, ".-:");
    const after = line.charCodeAt(skipSpaces(line, nameEnd, s.end));
    // `<T,>` and `<T extends U>` are type parameters, not elements.
    if (after === 44 || line.startsWith("extends ", skipSpaces(line, nameEnd, s.end))) return null;
    s.emit(at + 1, T.punctuationBracketJsx);
    s.emit(nameEnd, jsxTagToken(line, at + 1, nameEnd));
    return push(st, this, JSX_TAG, "o");
  }

  private jsxTag(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      if (c === 47 && s.peek(1) === 62) {
        s.emit(at + 2, T.punctuationBracketJsx);
        s.valueEnd = true;
        return st.parent!;
      }
      if (c === 62) {
        s.emit(at + 1, T.punctuationBracketJsx);
        if (st.data === "c") {
          s.valueEnd = true;
          return st.parent!;
        }
        return replace(st, JSX_CHILD);
      }
      if (c === 61) s.emit(at + 1, T.punctuationDelimiterJsx);
      else if (c === 34 || c === 39) {
        const close = line.indexOf(line[at]!, at + 1);
        s.emit(close < 0 || close >= s.end ? s.end : close + 1, T.string);
      } else if (c === 123) {
        s.emit(at + 1, T.punctuationBracket);
        s.valueEnd = false;
        return push(st, this, INTERP, "}j0");
      } else if (isLetter(c)) s.emit(wordEnd(line, at, s.end, "-:."), T.attributeJsx);
      else s.emit(at + 1, T.punctuationBracketJsx);
    }
    return st;
  }

  private jsxChild(s: Scanner, st: LexerState): LexerState {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line.charCodeAt(at);
      if (c === 60) {
        const next = s.peek(1);
        if (next === 47) {
          const nameEnd = wordEnd(line, at + 2, s.end, ".-:");
          s.emit(at + 2, T.punctuationBracketJsx);
          s.emit(nameEnd, jsxTagToken(line, at + 2, nameEnd));
          return replace(st, JSX_TAG, "c");
        }
        if (next === 62) {
          s.emit(at + 2, T.punctuationBracketJsx);
          return push(st, this, JSX_CHILD);
        }
        if (isLetter(next)) {
          const nameEnd = wordEnd(line, at + 1, s.end, ".-:");
          s.emit(at + 1, T.punctuationBracketJsx);
          s.emit(nameEnd, jsxTagToken(line, at + 1, nameEnd));
          return push(st, this, JSX_TAG, "o");
        }
      }
      if (c === 123) {
        s.emit(at + 1, T.punctuationBracket);
        s.valueEnd = false;
        return push(st, this, INTERP, "}j0");
      }
      if (c === 32 || c === 9) {
        s.ws();
        continue;
      }
      let end = at + 1;
      while (end < s.end) {
        const d = line.charCodeAt(end);
        if (d === 60 || d === 123) break;
        end++;
      }
      s.emit(end, T.textJsx);
    }
    return st;
  }
}

function jsxTagToken(line: string, start: number, end: number): number {
  if (isUpper(line.charCodeAt(start))) return T.tagComponentJsx;
  for (let i = start; i < end; i++) if (line.charCodeAt(i) === 46) return T.tagComponentJsx;
  return T.tagJsx;
}

const OPERATORS = new Uint8Array(128);
for (const char of "!%&*+-./<=>?^|~") OPERATORS[char.charCodeAt(0)] = 1;

function isOperator(c: number): boolean {
  return c < 128 && OPERATORS[c] === 1;
}

/** Characters after which `:` is a separator rather than a symbol sigil. */
function isSymbolBlocker(c: number): boolean {
  return isWordChar(c) || c === 58 || c === 41 || c === 93 || c === 34 || c === 39;
}

function isConstantCase(line: string, start: number, end: number): boolean {
  let letters = 0;
  for (let i = start; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c >= 97 && c <= 122) return false;
    if (c >= 65 && c <= 90) letters++;
  }
  return letters > 0;
}

/** End of a backslash escape starting at `at`. */
export function escapeEnd(line: string, at: number, end: number): number {
  const c = line.charCodeAt(at + 1);
  if (c === 117 && line.charCodeAt(at + 2) === 123) {
    const close = line.indexOf("}", at + 3);
    return close < 0 ? end : close + 1;
  }
  const hexDigits = c === 120 ? 2 : c === 117 ? 4 : c === 85 ? 8 : 0;
  if (hexDigits > 0) {
    let i = at + 2;
    while (i < at + 2 + hexDigits && i < end && isHex(line.charCodeAt(i))) i++;
    return i;
  }
  if (c >= 48 && c <= 55) {
    let i = at + 1;
    while (i < at + 4 && i < end && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 55) i++;
    return i;
  }
  return at + 2;
}

function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/** Index after the closing quote of a single-line string, or -1. */
function closingQuote(line: string, from: number, end: number, close: string): number {
  const first = close.charCodeAt(0);
  for (let i = from; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === 92) i++;
    else if (c === first && (close.length === 1 || line.startsWith(close, i)))
      return i + close.length;
  }
  return -1;
}

const DOC_PARAM_TAGS = new Set([
  "param",
  "arg",
  "argument",
  "property",
  "prop",
  "typedef",
  "template",
  "callback",
]);

/** Documentation text with `@tag {Type} name` highlighting, up to `end`. */
function docText(s: Scanner, end: number, token: number): void {
  const line = s.line;
  for (let i = s.pos; i < end; i++) {
    if (
      line.charCodeAt(i) !== 64 ||
      !isLetter(line.charCodeAt(i + 1)) ||
      (i > 0 && isWordChar(line.charCodeAt(i - 1)))
    ) {
      continue;
    }
    s.emit(i, token);
    const tagEnd = wordEnd(line, i + 1, end);
    const tag = line.slice(i + 1, tagEnd);
    s.emit(tagEnd, T.keywordJsdoc);
    let at = skipSpaces(line, tagEnd, end);
    if (line.charCodeAt(at) === 123) {
      const close = line.indexOf("}", at);
      if (close >= 0 && close < end) {
        s.emit(at, token);
        s.emit(close + 1, T.typeJsdoc);
        at = skipSpaces(line, close + 1, end);
      }
    }
    if (DOC_PARAM_TAGS.has(tag) && isLetter(line.charCodeAt(at))) {
      s.emit(at, token);
      s.emit(wordEnd(line, at, end, "$."), T.variableJsdoc);
    }
    i = s.pos - 1;
  }
  s.emit(end, token);
}
