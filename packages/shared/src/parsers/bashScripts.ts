// A shell scanner for highlighting: words with their quoting, redirects, heredocs and command
// substitutions, with source offsets. It is not an executor; control flow is flattened.

interface Span {
  readonly pos: number;
  readonly end: number;
  readonly text: string;
}
export interface ShellLiteral extends Span {
  readonly type: "Literal";
  readonly value: string;
}
export interface ShellSingleQuoted extends Span {
  readonly type: "SingleQuoted";
  readonly value: string;
}
export interface ShellAnsiCQuoted extends Span {
  readonly type: "AnsiCQuoted";
  readonly value: string;
}
/** `$name`, `${…}`, `$((…))`, backticks, and `$(…)` / `<(…)` (whose commands are listed separately). */
export interface ShellExpansion extends Span {
  readonly type: "Expansion";
}
export type ShellQuotedChild = ShellLiteral | ShellExpansion;
export interface ShellDoubleQuoted extends Span {
  readonly type: "DoubleQuoted";
  readonly parts: ReadonlyArray<ShellQuotedChild>;
}
export type ShellWordPart =
  | ShellLiteral
  | ShellSingleQuoted
  | ShellAnsiCQuoted
  | ShellDoubleQuoted
  | ShellExpansion;
export interface ShellWord extends Span {
  readonly value: string;
  readonly parts: ReadonlyArray<ShellWordPart>;
}
export type ShellRedirect =
  | {
      readonly type: "Redirect";
      readonly fd?: number;
      readonly operator: string;
      readonly target: ShellWord;
    }
  | { readonly type: "HereString"; readonly fd?: number; readonly target: ShellWord }
  | {
      readonly type: "HereDoc";
      readonly fd?: number;
      readonly delimiter: string;
      readonly body: { pos: number; end: number };
    };
export interface ShellCommand {
  name?: ShellWord;
  readonly args: ShellWord[];
  readonly redirects: ShellRedirect[];
}

type HereDoc = Extract<ShellRedirect, { type: "HereDoc" }>;

const SYNTAX = Symbol("shell syntax error");
const PREFIX_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
  "fi",
  "done",
  "esac",
]);
const ANSI_C: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** Per-ASCII-code class bits. */
const END = 1; // ends a word: blanks, newline, `;&|<>()`
const NAME = 2; // [A-Za-z0-9_]
const NAME_START = 4; // [A-Za-z_]
const SPECIAL = 8; // single-char parameters [0-9@*#?$!-]
const DQ_ESCAPE = 16; // escapable inside double quotes: $ ` " \ newline
const DIGIT = 32;
const WORD_STOP = 64; // interrupts an unquoted literal run: word ends, quotes, `$`, backslash
const DQ_STOP = 128; // interrupts a double-quoted literal run: `"`, backtick, `$`, backslash
const CLASS = new Uint8Array(128);
const mark = (chars: string, bits: number) => {
  for (const c of chars) CLASS[c.charCodeAt(0)]! |= bits;
};
const DIGITS = "0123456789";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";
mark(" \t\r\n;&|<>()", END);
mark(DIGITS + LETTERS, NAME);
mark(LETTERS, NAME_START);
mark(DIGITS + "@*#?$!-", SPECIAL);
mark('$`"\\\n', DQ_ESCAPE);
mark(DIGITS, DIGIT);
mark(" \t\r\n;&|<>()'\"`$\\", WORD_STOP);
mark('"`$\\', DQ_STOP);
/** Class bits of a char code; NaN (past the end) is a word end. */
const is = (c: number, bits: number) => (c < 128 ? CLASS[c]! & bits : bits === END && c !== c);

// Scanner state for the one parse in flight.
let src = "";
let i = 0;
let commands: ShellCommand[] = [];
let pendingDocs: HereDoc[] = [];
let pendingStrip: boolean[] = [];
/** Decoded value of the last `doubleQuoted` result. */
let quotedValue = "";

/** `src.charCodeAt(k)`, bounds-checked so V8 never deopts on reading past the end (NaN). */
const at = (k: number) => (k < src.length ? src.charCodeAt(k) : NaN);

function fail(): never {
  throw SYNTAX;
}

function readHeredocs() {
  for (let k = 0; k < pendingDocs.length; k++) {
    const doc = pendingDocs[k]!;
    const delimiter = doc.delimiter;
    doc.body.pos = i;
    for (;;) {
      const lineEnd = src.indexOf("\n", i);
      let end = lineEnd < 0 ? src.length : lineEnd;
      if (end > i && at(end - 1) === 13) end--;
      let start = i;
      if (pendingStrip[k]) while (start < end && at(start) === 9) start++;
      const match = end - start === delimiter.length && src.startsWith(delimiter, start);
      if (match || lineEnd < 0) {
        doc.body.end = match ? i : src.length;
        i = lineEnd < 0 ? src.length : lineEnd + 1;
        break;
      }
      i = lineEnd + 1;
    }
  }
  pendingDocs = [];
  pendingStrip = [];
}

/** Commands until `)` (left unconsumed) when nested, else until the end. */
function list(nested: boolean) {
  while (i < src.length) {
    const c = at(i);
    if (c === 32 || c === 9 || c === 13 || c === 59 || c === 38 || c === 124) i++;
    else if (c === 35) {
      const lineEnd = src.indexOf("\n", i);
      i = lineEnd < 0 ? src.length : lineEnd;
    } else if (c === 10) {
      i++;
      if (pendingDocs.length) readHeredocs();
    } else if (c === 41) {
      if (nested) return;
      i++;
    } else if (c === 40) {
      i++;
      list(true);
      if (at(i++) !== 41) fail();
    } else command();
  }
  if (nested) fail();
}

function command() {
  const cmd: ShellCommand = { args: [], redirects: [] };
  commands.push(cmd);
  for (;;) {
    let c = at(i);
    while (c === 32 || c === 9 || c === 13) c = at(++i);
    if (c !== c || c === 10 || c === 59 || c === 124 || c === 41 || c === 40 || c === 35) return;
    const next = at(i + 1);
    if (c === 38) {
      if (next !== 62) return;
      redirect(cmd, undefined);
    } else if ((c === 60 || c === 62) && next !== 40) redirect(cmd, undefined);
    else {
      // An fd prefix: up to 11 digits directly before `<` or `>` (and not `<(` / `>(`).
      let end = i;
      while (end < i + 11 && is(at(end), DIGIT)) end++;
      const op = at(end);
      if (end > i && (op === 60 || op === 62) && at(end + 1) !== 40) {
        const fd = Number(src.slice(i, end));
        i = end;
        redirect(cmd, fd);
      } else {
        const w = word();
        if (cmd.name) cmd.args.push(w);
        else if (!(w.text.length < 6 && PREFIX_WORDS.has(w.text)) && !isAssignment(w.text))
          cmd.name = w;
      }
    }
  }
}

/** `^[A-Za-z_]\w*=` */
function isAssignment(text: string) {
  if (!text || !is(text.charCodeAt(0), NAME_START)) return false;
  let k = 1;
  while (k < text.length && is(text.charCodeAt(k), NAME)) k++;
  return k < text.length && text.charCodeAt(k) === 61;
}

function redirect({ redirects }: ShellCommand, fd: number | undefined) {
  const c = at(i);
  const c1 = at(i + 1);
  const c2 = at(i + 2);
  const operator =
    c === 60
      ? c1 === 60
        ? c2 === 60
          ? "<<<"
          : c2 === 45
            ? "<<-"
            : "<<"
        : c1 === 62
          ? "<>"
          : c1 === 38
            ? "<&"
            : "<"
      : c === 62
        ? c1 === 62
          ? ">>"
          : c1 === 124
            ? ">|"
            : c1 === 38
              ? ">&"
              : ">"
        : c2 === 62
          ? "&>>"
          : "&>";
  i += operator.length;
  let t = at(i);
  while (t === 32 || t === 9 || t === 13) t = at(++i);
  if (is(t, END)) fail();
  const target = word();
  if (operator === "<<" || operator === "<<-") {
    const body = { pos: 0, end: 0 };
    const doc: HereDoc =
      fd === undefined
        ? { type: "HereDoc", delimiter: target.value, body }
        : { type: "HereDoc", fd, delimiter: target.value, body };
    pendingDocs.push(doc);
    pendingStrip.push(operator === "<<-");
    redirects.push(doc);
  } else if (operator === "<<<")
    redirects.push(
      fd === undefined ? { type: "HereString", target } : { type: "HereString", fd, target },
    );
  else
    redirects.push(
      fd === undefined
        ? { type: "Redirect", operator, target }
        : { type: "Redirect", fd, operator, target },
    );
}

const expansion = (pos: number): ShellExpansion => ({
  type: "Expansion",
  pos,
  end: i,
  text: src.slice(pos, i),
});

function skipBalanced(open: number, close: number) {
  for (let depth = 0; i < src.length; i++) {
    const c = at(i);
    if (c === 92) i++;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return void i++;
  }
  fail();
}

/** Whether `$` followed by `next` starts an expansion (else it is a literal `$`). */
const expands = (next: number) => next === 40 || next === 123 || is(next, SPECIAL | NAME_START);

/** The `$…` expansion (per `expands`) or backtick span at `i`. */
function substitution(): ShellExpansion {
  const pos = i;
  const next = at(i + 1);
  if (at(i) === 96) {
    for (i++; at(i) !== 96; i++) {
      if (i >= src.length) fail();
      if (at(i) === 92) i++;
    }
    i++;
  } else if (next === 40 && at(i + 2) !== 40) {
    i += 2;
    list(true);
    i++;
  } else if (next === 40 || next === 123) {
    i++;
    skipBalanced(next, next === 40 ? 41 : 125);
  } else if (is(next, SPECIAL)) i += 2;
  else for (i += 2; is(at(i), NAME); ) i++;
  return expansion(pos);
}

/** The literal `src[pos, i)`, whose decoded value is `decoded` + `src[seg, i)`. */
function literal(pos: number, decoded: string, seg: number): ShellLiteral {
  const text = src.slice(pos, i);
  const value = seg === pos ? text : decoded + src.slice(seg, i);
  return { type: "Literal", pos, end: i, text, value };
}

/** From just inside the opening quote; sets `quotedValue`. */
function doubleQuoted(pos: number): ShellDoubleQuoted {
  const parts: ShellQuotedChild[] = [];
  let value = "";
  for (;;) {
    const start = i;
    let decoded = "";
    let seg = i;
    let c = at(i);
    for (;; c = at(i)) {
      if (c < 128 ? !(CLASS[c]! & DQ_STOP) : c === c) i++;
      else if (c === 92) {
        if (is(at(i + 1), DQ_ESCAPE)) {
          decoded += src.slice(seg, i);
          if (at(i + 1) !== 10) decoded += src[i + 1];
          seg = i += 2;
        } else i++;
      } else if (c === 36 && !expands(at(i + 1))) i++;
      else if (c !== c) fail();
      else break;
    }
    if (i > start) {
      const part = literal(start, decoded, seg);
      parts.push(part);
      value += part.value;
    }
    if (c === 34) break;
    const part = substitution();
    parts.push(part);
    value += part.text;
  }
  i++;
  quotedValue = value;
  return { type: "DoubleQuoted", pos, end: i, text: src.slice(pos, i), parts };
}

function word(): ShellWord {
  const pos = i;
  const parts: ShellWordPart[] = [];
  let value = "";
  let c = at(i);
  if ((c === 60 || c === 62) && at(i + 1) === 40) {
    i += 2;
    list(true);
    i++;
    const part = expansion(pos);
    parts.push(part);
    value += part.text;
    c = at(i);
  }
  while (!is(c, END)) {
    // A run of unquoted literal characters and backslash escapes.
    const start = i;
    let decoded = "";
    let seg = i;
    for (;; c = at(i)) {
      if (c < 128 ? !(CLASS[c]! & WORD_STOP) : c === c) i++;
      else if (c === 36) {
        const next = at(i + 1);
        if (next === 34 || next === 39 || expands(next)) break;
        i++;
      } else if (c === 92) {
        decoded += src.slice(seg, i);
        if (i + 1 >= src.length) {
          decoded += "\\";
          i++;
        } else {
          if (at(i + 1) !== 10) decoded += src[i + 1];
          i += 2;
        }
        seg = i;
      } else break;
    }
    if (i > start) {
      const part = literal(start, decoded, seg);
      parts.push(part);
      value += part.value;
    }
    if (is(c, END)) break;
    const partStart = i;
    if (c === 39) {
      const close = src.indexOf("'", i + 1);
      if (close < 0) fail();
      i = close + 1;
      const part: ShellSingleQuoted = {
        type: "SingleQuoted",
        pos: partStart,
        end: i,
        text: src.slice(partStart, i),
        value: src.slice(partStart + 1, close),
      };
      parts.push(part);
      value += part.value;
    } else if (c === 34 || (c === 36 && at(i + 1) === 34)) {
      i += c === 36 ? 2 : 1;
      parts.push(doubleQuoted(partStart));
      value += quotedValue;
    } else if (c === 36 && at(i + 1) === 39) {
      let ansi = "";
      let seg = (i += 2);
      for (;;) {
        const q = at(i);
        if (q !== q) fail();
        if (q === 39) break;
        if (q === 92) {
          ansi += src.slice(seg, i);
          const escaped = src[++i]!;
          ansi += ANSI_C[escaped] ?? `\\${escaped}`;
          seg = i + 1;
        }
        i++;
      }
      ansi += src.slice(seg, i);
      i++;
      const part: ShellAnsiCQuoted = {
        type: "AnsiCQuoted",
        pos: partStart,
        end: i,
        text: src.slice(partStart, i),
        value: ansi,
      };
      parts.push(part);
      value += ansi;
    } else {
      const part = substitution();
      parts.push(part);
      value += part.text;
    }
    c = at(i);
  }
  const text = parts.length === 1 ? parts[0]!.text : src.slice(pos, i);
  return { pos, end: i, text, value, parts };
}

/**
 * Every simple command in `source`, outer before inner, including those inside `$(…)`, `<(…)`
 * and subshells. Returns undefined when the quoting or nesting does not parse.
 */
export function parseShellCommands(source: string): ShellCommand[] | undefined {
  src = source;
  i = 0;
  commands = [];
  if (pendingDocs.length) {
    // Left over from a syntax error.
    pendingDocs = [];
    pendingStrip = [];
  }
  try {
    list(false);
    if (pendingDocs.length) readHeredocs();
    return commands;
  } catch (error) {
    if (error === SYNTAX) return undefined;
    throw error;
  } finally {
    src = "";
    commands = [];
  }
}
