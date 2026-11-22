import { decodeHtmlEntities } from "../markdown/entities.ts";

export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
  readonly prefix: string;
  readonly local: string;
  readonly uri: string;
}

export interface XmlTag {
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  /** Unbound prefixes resolve to "" instead of failing. */
  readonly uri: string;
  readonly attributes: Readonly<Record<string, XmlAttribute>>;
  /** Namespace declarations made on this tag, keyed by prefix ("" for the default). */
  readonly ns: Readonly<Record<string, string>>;
  readonly isSelfClosing: boolean;
}

export interface XmlEvents {
  opentag: (tag: XmlTag) => void;
  closetag: (tag: XmlTag) => void;
  text: (text: string) => void;
  cdata: (text: string) => void;
  doctype: (doctype: string) => void;
}

export class XmlError extends Error {}

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const ROOT_SCOPE: Record<string, string> = Object.assign(Object.create(null), {
  xml: "http://www.w3.org/XML/1998/namespace",
  xmlns: XMLNS_NS,
});
const NO_DECLARATIONS: Record<string, string> = Object.freeze(Object.create(null));
const PREDEFINED: Record<string, string> = Object.assign(Object.create(null), {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
});
const NAME = /^[^\s\d.\-<>/!?="'][^\s<>/!?="']*$/u;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const normalizeNewlines = (text: string) =>
  text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;

interface Open {
  readonly tag: XmlTag;
  readonly scope: Record<string, string>;
}

/**
 * Streaming, namespace-aware SAX parser with saxes-compatible events. `position` is the input
 * index just past the token being reported, or past everything consumed between writes.
 */
export class XmlStreamParser {
  private readonly handlers: { [K in keyof XmlEvents]?: XmlEvents[K] } = {};
  private readonly htmlEntities: boolean;
  private readonly stack: Open[] = [];
  private readonly names = new Set<string>();
  private buffer = "";
  private base = 0;
  private start = 0;
  private cursor = 0;
  // The token at `start` was searched up to `scanned` for `scanFor` without finding it, so chunked
  // text and long comments are scanned once rather than again on every write.
  private scanned = 0;
  private scanFor = "";
  // Chunks that cannot complete the pending token, joined only once one can.
  private deferred: string[] = [];
  private deferredTail = "";
  private final = false;
  private sawRoot = false;
  private closedRoot = false;

  /** `htmlEntities` also decodes HTML named references such as `&nbsp;` (XHTML/EPUB). */
  constructor(options: { readonly htmlEntities?: boolean } = {}) {
    this.htmlEntities = options.htmlEntities ?? false;
  }

  get position() {
    return this.base + this.cursor;
  }

  on<K extends keyof XmlEvents>(event: K, handler: XmlEvents[K]): this {
    this.handlers[event] = handler;
    return this;
  }

  write(chunk: string): this {
    if (this.scanFor) {
      const window = this.deferredTail + chunk;
      if (!window.includes(this.scanFor)) {
        this.deferred.push(chunk);
        this.deferredTail = window.slice(1 - this.scanFor.length || window.length);
        return this;
      }
    }
    this.join(chunk);
    this.run();
    return this;
  }

  private join(chunk: string) {
    this.buffer = this.buffer.slice(this.start) + this.deferred.join("") + chunk;
    this.base += this.start;
    this.scanned += this.deferredLength() - this.start;
    this.start = this.cursor = 0;
    this.deferred = [];
    this.deferredTail = "";
  }

  private deferredLength() {
    let length = 0;
    for (const chunk of this.deferred) length += chunk.length;
    return length;
  }

  close(): this {
    this.final = true;
    if (this.deferred.length) this.join("");
    this.run();
    if (this.start < this.buffer.length) this.fail("unterminated markup");
    if (this.stack.length) this.fail(`unclosed tag <${this.stack.at(-1)!.tag.name}>`);
    if (!this.sawRoot) this.fail("document has no root element");
    return this;
  }

  private fail(reason: string): never {
    throw new XmlError(`Invalid XML at offset ${this.base + this.start}: ${reason}.`);
  }

  /** Decodes references; unknown or malformed ones stay literal. */
  private decode(text: string) {
    let amp = text.indexOf("&");
    if (amp < 0) return text;
    let out = "";
    let last = 0;
    while (amp >= 0) {
      const semi = text.indexOf(";", amp + 2);
      if (semi < 0) break;
      const decoded = semi - amp <= 32 ? this.reference(text.slice(amp + 1, semi)) : undefined;
      if (decoded === undefined) {
        amp = text.indexOf("&", amp + 1);
        continue;
      }
      out += text.slice(last, amp) + decoded;
      last = semi + 1;
      amp = text.indexOf("&", last);
    }
    return last === 0 ? text : out + text.slice(last);
  }

  private reference(body: string): string | undefined {
    const predefined = PREDEFINED[body];
    if (predefined !== undefined) return predefined;
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const hex = body.charCodeAt(1) === 0x78; /* x */
      const digits = body.slice(hex ? 2 : 1);
      if (!(hex ? /^[\da-fA-F]+$/ : /^\d+$/).test(digits)) return undefined;
      const code = parseInt(digits, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : undefined;
    }
    if (!this.htmlEntities || !/^[A-Za-z][A-Za-z\d]*$/.test(body)) return undefined;
    const decoded = decodeHtmlEntities(`&${body};`, { strict: true });
    return decoded === `&${body};` ? undefined : decoded;
  }

  private validName(name: string) {
    if (this.names.has(name)) return true;
    if (!NAME.test(name)) return false;
    this.names.add(name);
    return true;
  }

  private run() {
    const buffer = this.buffer;
    while (this.start < buffer.length) {
      const start = this.start;
      let end: number;
      if (buffer.charCodeAt(start) === 0x3c /* < */) {
        end = this.markup(start);
      } else {
        end = this.find("<", start);
        if (end < 0 && this.final) end = buffer.length;
        if (end >= 0) this.text(start, end);
      }
      if (end < 0) break;
      this.start = end;
    }
    this.cursor = this.start;
  }

  private text(start: number, end: number) {
    const text = normalizeNewlines(this.buffer.slice(start, end));
    if (!this.stack.length && !/^[\s﻿]*$/.test(text)) this.fail("text outside the root element");
    if (this.base + start === 0) return; // saxes drops whitespace before the first markup.
    this.cursor = end;
    this.handlers.text?.(this.decode(text));
  }

  /** `indexOf`, resuming where an earlier write's search for the same token stopped. */
  private find(terminator: string, from: number) {
    const resume = this.scanFor === terminator ? this.scanned - terminator.length + 1 : 0;
    const index = this.buffer.indexOf(terminator, Math.max(from, resume));
    if (index < 0) {
      this.scanFor = terminator;
      this.scanned = this.buffer.length;
      this.deferredTail = this.buffer.slice(1 - terminator.length || this.buffer.length);
    } else this.scanFor = "";
    return index;
  }

  /** Index just past `terminator`, or -1 while the input may still complete it. */
  private until(terminator: string, from: number) {
    const index = this.find(terminator, from);
    if (index >= 0) return index + terminator.length;
    return this.final ? this.fail("unterminated markup") : -1;
  }

  /** Handles the markup at `start`; returns its end, or -1 when it is not complete yet. */
  private markup(start: number): number {
    const buffer = this.buffer;
    const next = buffer.charCodeAt(start + 1);
    if (next === 0x2f /* / */) return this.closeTag(start);
    if (next === 0x3f /* ? */) return this.until("?>", start + 2);
    if (next !== 0x21 /* ! */)
      return Number.isNaN(next) ? this.until(">", start) : this.openTag(start);
    const head = buffer.slice(start, start + 9);
    if (head.startsWith("<!--")) return this.until("-->", start + 4);
    if (head === "<![CDATA[") {
      const end = this.until("]]>", start + 9);
      if (end > 0) {
        if (!this.stack.length) this.fail("CDATA outside the root element");
        this.cursor = end;
        this.handlers.cdata?.(normalizeNewlines(buffer.slice(start + 9, end - 3)));
      }
      return end;
    }
    if (head.toUpperCase() === "<!DOCTYPE") {
      let depth = 0;
      for (let i = start + 9; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c === 0x22 || c === 0x27) {
          i = buffer.indexOf(buffer[i]!, i + 1);
          if (i < 0) break;
        } else if (c === 0x5b /* [ */) depth++;
        else if (c === 0x5d /* ] */) depth--;
        else if (c === 0x3e /* > */ && depth <= 0) {
          if (this.sawRoot) this.fail("DOCTYPE after the root element");
          this.cursor = i + 1;
          this.handlers.doctype?.(buffer.slice(start + 9, i).trim());
          return i + 1;
        }
      }
      return this.final ? this.fail("unterminated DOCTYPE") : -1;
    }
    const partial =
      head.length < 9 &&
      ["<!--", "<![CDATA[", "<!DOCTYPE"].some((marker) => marker.startsWith(head.toUpperCase()));
    return partial && !this.final ? -1 : this.fail("unknown declaration");
  }

  private closeTag(start: number) {
    const end = this.until(">", start + 2);
    if (end < 0) return end;
    const name = this.buffer.slice(start + 2, end - 1).trimEnd();
    const open = this.stack.pop();
    if (open?.tag.name !== name) this.fail(`mismatched closing tag </${name}>`);
    if (!this.stack.length) this.closedRoot = true;
    this.cursor = end;
    this.handlers.closetag?.(open!.tag);
    return end;
  }

  private openTag(start: number) {
    const source = this.buffer;
    let end = -1;
    for (let i = start + 1; i < source.length; i++) {
      const c = source.charCodeAt(i);
      if (c === 0x3e /* > */) {
        end = i + 1;
        break;
      }
      if (c === 0x22 || c === 0x27) {
        i = source.indexOf(source[i]!, i + 1);
        if (i < 0) break;
      }
    }
    if (end < 0) return this.final ? this.fail("unterminated tag") : -1;

    const selfClosing = source.charCodeAt(end - 2) === 0x2f; /* / */
    const stop = selfClosing ? end - 2 : end - 1;
    let i = start + 1;
    while (i < stop && !isSpace(source.charCodeAt(i))) i++;
    const name = source.slice(start + 1, i);
    if (!this.validName(name)) this.fail("invalid tag name");
    if (this.closedRoot) this.fail("content after the root element");

    const parent = this.stack.length ? this.stack[this.stack.length - 1]!.scope : ROOT_SCOPE;
    let scope = parent;
    let declared = NO_DECLARATIONS;
    const names: string[] = [];
    const values: string[] = [];
    let seen: Set<string> | undefined;
    while (i < stop) {
      if (isSpace(source.charCodeAt(i))) {
        i++;
        continue;
      }
      const nameStart = i;
      while (i < stop && !isSpace(source.charCodeAt(i)) && source.charCodeAt(i) !== 0x3d /* = */)
        i++;
      const attribute = source.slice(nameStart, i);
      while (isSpace(source.charCodeAt(i))) i++;
      if (source.charCodeAt(i) !== 0x3d || !this.validName(attribute))
        this.fail("malformed attribute");
      i++;
      while (isSpace(source.charCodeAt(i))) i++;
      const quote = source.charCodeAt(i);
      if (quote !== 0x22 && quote !== 0x27) this.fail("unquoted attribute value");
      const close = source.indexOf(source[i]!, i + 1);
      if (close < 0 || close >= stop) this.fail("unterminated attribute value");
      let value = source.slice(i + 1, close);
      if (value.includes("<")) this.fail("'<' in an attribute value");
      if (value.includes("\n") || value.includes("\r") || value.includes("\t"))
        value = value.replace(/\r\n|[\t\n\r]/g, " ");
      if (seen ? seen.has(attribute) : names.includes(attribute)) this.fail("duplicate attribute");
      names.push(attribute);
      if (seen) seen.add(attribute);
      else if (names.length > 16) seen = new Set(names);
      values.push(this.decode(value));
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) {
        if (declared === NO_DECLARATIONS) {
          declared = Object.create(null) as Record<string, string>;
          scope = Object.create(parent) as Record<string, string>;
        }
        declared[attribute.length === 5 ? "" : attribute.slice(6)] = scope[
          attribute.length === 5 ? "" : attribute.slice(6)
        ] = values[values.length - 1]!;
      }
      i = close + 1;
      if (i < stop && !isSpace(source.charCodeAt(i)))
        this.fail("attributes must be separated by whitespace");
    }

    const attributes: Record<string, XmlAttribute> = Object.create(null);
    for (let index = 0; index < names.length; index++) {
      const attribute = names[index]!;
      const colon = attribute.indexOf(":");
      const prefix = colon < 0 ? "" : attribute.slice(0, colon);
      attributes[attribute] = {
        name: attribute,
        value: values[index]!,
        prefix,
        local: colon < 0 ? attribute : attribute.slice(colon + 1),
        uri: prefix ? (scope[prefix] ?? "") : attribute === "xmlns" ? XMLNS_NS : "",
      };
    }
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const tag: XmlTag = {
      name,
      prefix,
      local: colon < 0 ? name : name.slice(colon + 1),
      uri: scope[prefix] ?? "",
      attributes,
      ns: declared,
      isSelfClosing: selfClosing,
    };
    this.sawRoot = true;
    this.cursor = end;
    if (selfClosing) {
      if (!this.stack.length) this.closedRoot = true;
      this.handlers.opentag?.(tag);
      this.handlers.closetag?.(tag);
    } else {
      this.stack.push({ tag, scope });
      this.handlers.opentag?.(tag);
    }
    return end;
  }
}
