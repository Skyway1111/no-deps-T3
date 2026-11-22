// YAML 1.2 (core schema), first document only: block and flow collections, plain, quoted and
// block scalars, anchors and aliases. Errors carry a position, never source text.

export class YamlError extends Error {}

const isBlank = (c: string | undefined) => c === undefined || c === " " || c === "\t" || c === "\n";
const FLOW_END = new Set([",", "[", "]", "{", "}"]);
const DOUBLE_QUOTED_SPECIAL = /["\\\n]/g;
const SINGLE_QUOTED_SPECIAL = /['\n]/g;
const trimSpacesEnd = (text: string) => {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end--;
  return end === text.length ? text : text.slice(0, end);
};

// First characters of every non-string plain scalar: null, booleans, numbers, .inf and .nan.
const RESOLVABLE_START = /^(?:$|[~nNtTfF\d+\-.])/;

function resolvePlain(raw: string): unknown {
  if (!RESOLVABLE_START.test(raw)) return raw;
  if (/^(?:~|null|Null|NULL|)$/.test(raw)) return null;
  if (/^(?:true|True|TRUE)$/.test(raw)) return true;
  if (/^(?:false|False|FALSE)$/.test(raw)) return false;
  if (/^[-+]?\d+$/.test(raw)) return Number(raw);
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  if (/^0x[\da-fA-F]+$/.test(raw)) return parseInt(raw.slice(2), 16);
  if (/^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?$/.test(raw)) return Number(raw);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(raw)) return raw.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(raw)) return NaN;
  return raw;
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 };

class Parser {
  private pos = 0;
  private readonly anchors = new Map<string, unknown>();
  private readonly src: string;

  constructor(source: string) {
    this.src = source.replace(/\r\n?/g, "\n");
  }

  document(): unknown {
    for (;;) {
      this.skipBlank();
      if (this.src[this.pos] !== "%" || this.column() !== 0) break;
      this.pos = this.lineEnd();
    }
    if (this.marker("---")) this.pos += 3;
    const value = this.node(-1, true, false);
    this.skipBlank();
    if (this.marker("...")) {
      this.pos += 3;
      this.skipBlank();
    }
    if (this.pos < this.src.length)
      this.fail(this.marker("---") ? "multiple documents" : "unexpected content");
    return value;
  }

  private fail(reason: string): never {
    const before = this.src.slice(0, this.pos);
    const line = before.split("\n").length;
    throw new YamlError(`Invalid YAML at line ${line}, column ${this.column() + 1}: ${reason}.`);
  }

  private column(at = this.pos) {
    return at - this.src.lastIndexOf("\n", at - 1) - 1;
  }

  private lineEnd(at = this.pos) {
    const end = this.src.indexOf("\n", at);
    return end < 0 ? this.src.length : end;
  }

  private marker(text: "---" | "...") {
    return (
      this.column() === 0 && this.src.startsWith(text, this.pos) && isBlank(this.src[this.pos + 3])
    );
  }

  private skipSpaces() {
    while (this.src[this.pos] === " " || this.src[this.pos] === "\t") this.pos++;
  }

  /** Skips whitespace, line breaks and comments; `pos` lands on content or the end. */
  private skipBlank() {
    for (;;) {
      this.skipSpaces();
      const c = this.src[this.pos];
      if (c === "#") this.pos = this.lineEnd();
      else if (c === "\n") this.pos++;
      else return;
    }
  }

  /** Indentation of the next content line, or -1 at the end of the document. */
  private nextIndent() {
    this.skipBlank();
    return this.pos >= this.src.length || this.marker("---") || this.marker("...")
      ? -1
      : this.column();
  }

  private atLineEnd() {
    this.skipSpaces();
    const c = this.src[this.pos];
    return c === undefined || c === "\n" || c === "#";
  }

  private expectLineEnd() {
    if (!this.atLineEnd()) this.fail("unexpected content after a value");
  }

  private sequenceIndicator() {
    return this.src[this.pos] === "-" && isBlank(this.src[this.pos + 1]);
  }

  private node(parent: number, compact: boolean, mappingValue: boolean): unknown {
    this.skipSpaces();
    let anchor: string | undefined;
    let tag: string | undefined;
    while (this.src[this.pos] === "&" || this.src[this.pos] === "!") {
      const start = this.pos;
      while (!isBlank(this.src[this.pos])) this.pos++;
      if (this.src[start] === "&") anchor = this.src.slice(start + 1, this.pos);
      else tag = this.src.slice(start, this.pos);
      this.skipSpaces();
    }
    let value: unknown = null;
    if (this.atLineEnd()) {
      const indent = this.nextIndent();
      if (
        indent > parent ||
        (mappingValue && indent === parent && indent >= 0 && this.sequenceIndicator())
      )
        value = this.content(parent, true, tag);
    } else {
      value = this.content(parent, compact, tag);
    }
    if (anchor !== undefined) this.anchors.set(anchor, value);
    return value;
  }

  private content(parent: number, compact: boolean, tag: string | undefined): unknown {
    const c = this.src[this.pos];
    const column = this.column();
    if (this.sequenceIndicator()) {
      if (!compact) this.fail("a sequence cannot start on a mapping key's line");
      return this.blockSequence(column);
    }
    if (compact && this.mappingKeyAhead()) return this.blockMapping(column);
    let value: unknown;
    if (c === "|" || c === ">") return this.blockScalar(parent);
    if (c === "[" || c === "{") value = this.flowCollection();
    else if (c === "*") value = this.alias();
    else if (c === '"' || c === "'") value = this.quoted();
    else return this.plain(parent, tag);
    if (this.src[this.pos] === ":" || this.src.startsWith(" :", this.pos))
      this.fail("nested mapping");
    this.expectLineEnd();
    return value;
  }

  private mappingKeyAhead() {
    const end = this.lineEnd();
    let i = this.pos;
    const c = this.src[i];
    if (c === '"' || c === "'") {
      for (i++; i < end; i++) {
        if (c === '"' && this.src[i] === "\\") i++;
        else if (this.src[i] === c && c === "'" && this.src[i + 1] === "'") i++;
        else if (this.src[i] === c) break;
      }
      if (i >= end) return false;
      for (i++; this.src[i] === " "; i++);
      return this.src[i] === ":";
    }
    if (c === "?" && isBlank(this.src[i + 1])) return true;
    if (c === undefined || "[]{}|>*&!%@`#".includes(c)) return false;
    for (; i < end; i++) {
      const ch = this.src[i];
      if (ch === ":" && isBlank(this.src[i + 1])) return true;
      if (ch === "#" && (this.src[i - 1] === " " || this.src[i - 1] === "\t")) return false;
    }
    return false;
  }

  private blockSequence(indent: number): unknown[] {
    const items: unknown[] = [];
    while (this.nextIndent() === indent && this.sequenceIndicator()) {
      this.pos++;
      items.push(this.node(indent, true, false));
    }
    if (this.nextIndent() > indent) this.fail("bad indentation of a sequence entry");
    return items;
  }

  private blockMapping(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (this.nextIndent() === indent) {
      if (this.sequenceIndicator()) this.fail("a sequence entry inside a mapping");
      const c = this.src[this.pos];
      let key: string;
      let value: unknown = null;
      if (c === "?" && isBlank(this.src[this.pos + 1])) {
        this.pos++;
        key = String(this.node(indent, true, false));
        if (
          this.nextIndent() === indent &&
          this.src[this.pos] === ":" &&
          isBlank(this.src[this.pos + 1])
        ) {
          this.pos++;
          value = this.node(indent, true, false);
        }
      } else {
        if (c === '"' || c === "'") {
          key = this.quoted();
          this.skipSpaces();
        } else {
          const start = this.pos;
          const end = this.lineEnd();
          while (!(this.src[this.pos] === ":" && isBlank(this.src[this.pos + 1]))) {
            if (++this.pos >= end) this.fail("expected a mapping key");
          }
          key = this.src.slice(start, this.pos).trimEnd();
        }
        if (this.src[this.pos++] !== ":") this.fail("expected ':' after a mapping key");
        value = this.node(indent, false, true);
      }
      if (Object.hasOwn(map, key)) this.fail("duplicate mapping key");
      Object.defineProperty(map, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (this.nextIndent() > indent) this.fail("bad indentation of a mapping entry");
    return map;
  }

  private alias() {
    const start = ++this.pos;
    while (!isBlank(this.src[this.pos]) && !FLOW_END.has(this.src[this.pos]!)) this.pos++;
    const name = this.src.slice(start, this.pos);
    if (!this.anchors.has(name)) this.fail("unknown alias");
    return this.anchors.get(name);
  }

  /** Folds a line break inside a quoted or plain scalar; `pos` is on the `\n`. */
  private fold(): string {
    let breaks = 0;
    while (this.src[this.pos] === "\n") {
      breaks++;
      this.pos++;
      this.skipSpaces();
    }
    return breaks < 2 ? " " : "\n".repeat(breaks - 1);
  }

  private quoted(): string {
    const quote = this.src[this.pos++];
    const special = quote === '"' ? DOUBLE_QUOTED_SPECIAL : SINGLE_QUOTED_SPECIAL;
    let out = "";
    for (;;) {
      // Literal runs are copied whole; only quotes, escapes and line breaks are looked at.
      special.lastIndex = this.pos;
      const runEnd = special.exec(this.src)?.index ?? this.src.length;
      const run = this.src.slice(this.pos, runEnd);
      this.pos = runEnd;
      const c = this.src[this.pos];
      if (c === "\n") {
        // Trailing spaces before a break are dropped, reaching back past the run only if it is all spaces.
        const kept = trimSpacesEnd(run);
        out = (kept ? out + kept : trimSpacesEnd(out)) + this.fold();
        continue;
      }
      out += run;
      if (c === undefined) this.fail("unterminated quoted scalar");
      if (c === quote) {
        if (quote === "'" && this.src[this.pos + 1] === "'") {
          out += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        return out;
      }
      if (c === "\\") {
        const e = this.src[this.pos + 1]!;
        if (e === "\n") {
          this.pos++;
          this.fold();
          continue;
        }
        const width = HEX_ESCAPES[e];
        if (width) {
          const hex = this.src.slice(this.pos + 2, this.pos + 2 + width);
          if (!/^[\da-fA-F]+$/.test(hex) || hex.length !== width) this.fail("invalid escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          this.pos += 2 + width;
        } else {
          if (!Object.hasOwn(ESCAPES, e)) this.fail("invalid escape");
          out += ESCAPES[e];
          this.pos += 2;
        }
      }
    }
  }

  private plain(parent: number, tag: string | undefined): unknown {
    let out = "";
    for (;;) {
      const start = this.pos;
      const end = this.lineEnd();
      for (; this.pos < end; this.pos++) {
        const c = this.src[this.pos];
        if (c === ":" && isBlank(this.src[this.pos + 1]))
          this.fail("nested mapping in a plain scalar");
        if (c === "#" && (this.src[this.pos - 1] === " " || this.src[this.pos - 1] === "\t")) break;
      }
      out += this.src.slice(start, this.pos).trim();
      if (this.pos < end) {
        this.pos = end;
        break;
      }
      const lineEnd = this.pos;
      const separator = this.fold();
      if (
        this.pos >= this.src.length ||
        this.column() <= parent ||
        this.src[this.pos] === "#" ||
        this.marker("---") ||
        this.marker("...")
      ) {
        this.pos = lineEnd;
        break;
      }
      out += separator;
    }
    return tag === "!!str" ? out : resolvePlain(out);
  }

  private blockScalar(parent: number): string {
    const literal = this.src[this.pos++] === "|";
    let chomp = "";
    let explicit = 0;
    while (!this.atLineEnd()) {
      const c = this.src[this.pos++]!;
      if (c === "-" || c === "+") chomp = c;
      else if (c >= "1" && c <= "9") explicit = Number(c);
      else this.fail("invalid block scalar header");
    }
    this.pos = this.lineEnd();
    const base = Math.max(parent, 0);
    let indent = explicit ? base + explicit : -1;
    const lines: string[] = [];
    while (this.pos < this.src.length) {
      const start = this.pos + 1;
      const end = this.lineEnd(start);
      const line = this.src.slice(start, end);
      const spaces = line.length - line.trimStart().length;
      if (line.trim() === "") {
        lines.push(line.slice(indent < 0 ? line.length : indent));
      } else {
        if (indent < 0) {
          if (spaces <= parent) break;
          indent = spaces;
        }
        if (spaces < indent) break;
        lines.push(line.slice(indent));
      }
      this.pos = end;
    }
    let trailing = 0;
    while (lines.length && lines.at(-1)!.trim() === "") {
      lines.pop();
      trailing++;
    }
    let out = "";
    if (literal) out = lines.join("\n");
    else {
      let breaks = 0;
      let previousMore = false;
      lines.forEach((line, index) => {
        if (line === "") return void breaks++;
        const more = line[0] === " " || line[0] === "\t";
        out +=
          index === breaks
            ? "\n".repeat(breaks)
            : more || previousMore
              ? "\n".repeat(breaks + 1)
              : breaks
                ? "\n".repeat(breaks)
                : " ";
        out += line;
        previousMore = more;
        breaks = 0;
      });
    }
    if (chomp === "-" || (!lines.length && chomp !== "+")) return out;
    return out + (chomp === "+" ? "\n".repeat(trailing + (lines.length ? 1 : 0)) : "\n");
  }

  private skipFlowBlank() {
    this.skipBlank();
    if (this.pos >= this.src.length) this.fail("unterminated flow collection");
  }

  private flowCollection(): unknown {
    const isMap = this.src[this.pos++] === "{";
    const close = isMap ? "}" : "]";
    const seq: unknown[] = [];
    const map: Record<string, unknown> = {};
    for (;;) {
      this.skipFlowBlank();
      if (this.src[this.pos] === close) break;
      const key = this.flowNode();
      this.skipFlowBlank();
      let value: unknown = null;
      const paired = this.src[this.pos] === ":";
      if (paired) {
        this.pos++;
        this.skipFlowBlank();
        if (this.src[this.pos] !== "," && this.src[this.pos] !== close) value = this.flowNode();
        this.skipFlowBlank();
      }
      if (isMap) map[String(key)] = value;
      else seq.push(paired ? { [String(key)]: value } : key);
      if (this.src[this.pos] === ",") this.pos++;
      else if (this.src[this.pos] !== close) this.fail("expected ',' in a flow collection");
    }
    this.pos++;
    return isMap ? map : seq;
  }

  private flowNode(): unknown {
    let anchor: string | undefined;
    let tag: string | undefined;
    while (this.src[this.pos] === "&" || this.src[this.pos] === "!") {
      const start = this.pos;
      while (!isBlank(this.src[this.pos]) && !FLOW_END.has(this.src[this.pos]!)) this.pos++;
      if (this.src[start] === "&") anchor = this.src.slice(start + 1, this.pos);
      else tag = this.src.slice(start, this.pos);
      this.skipFlowBlank();
    }
    const c = this.src[this.pos];
    let value: unknown;
    if (c === "[" || c === "{") value = this.flowCollection();
    else if (c === "*") value = this.alias();
    else if (c === '"' || c === "'") value = this.quoted();
    else {
      let out = "";
      for (let runStart = this.pos; ;) {
        const ch = this.src[this.pos];
        const end =
          ch === undefined ||
          FLOW_END.has(ch) ||
          (ch === ":" &&
            (isBlank(this.src[this.pos + 1]) || FLOW_END.has(this.src[this.pos + 1]!))) ||
          (ch === "#" && isBlank(this.src[this.pos - 1]));
        if (end || ch === "\n") {
          const run = this.src.slice(runStart, this.pos);
          if (end) {
            out += run;
            break;
          }
          const kept = run.trimEnd();
          out = (kept ? out + kept : out.trimEnd()) + this.fold();
          runStart = this.pos;
        } else this.pos++;
      }
      out = out.trim();
      value = tag === "!!str" ? out : resolvePlain(out);
    }
    if (anchor !== undefined) this.anchors.set(anchor, value);
    return value;
  }
}

/** Parses the first YAML document; throws `YamlError` on malformed or multi-document input. */
export function parseYaml(source: string): unknown {
  return new Parser(source).document();
}

const scalarText = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number")
    return Number.isNaN(value)
      ? ".nan"
      : Number.isFinite(value)
        ? String(value)
        : value > 0
          ? ".inf"
          : "-.inf";
  if (typeof value !== "string") return String(value);
  const plain =
    value !== "" &&
    value === value.trim() &&
    resolvePlain(value) === value &&
    !/^[-?:,[\]{}#&*!|>'"%@`]|[\n\t]|: |:$| #/.test(value);
  return plain ? value : JSON.stringify(value);
};

function stringifyNode(value: unknown, indent: string): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  )
    value = value.toJSON();
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((item) => `${indent}- ${stringifyNode(item, `${indent}  `).trimStart()}`)
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return "{}";
    return entries
      .map(([key, item]) => {
        const nested = stringifyNode(item, `${indent}  `);
        const block = nested.startsWith(`${indent}  `) || (Array.isArray(item) && item.length > 0);
        return `${indent}${scalarText(key)}:${block ? `\n${nested}` : ` ${nested}`}`;
      })
      .join("\n");
  }
  return scalarText(value);
}

/** Block-style YAML that `parseYaml` (and any YAML 1.2 reader) reads back to the same value. */
export function stringifyYaml(value: unknown): string {
  return `${stringifyNode(value, "")}\n`;
}
