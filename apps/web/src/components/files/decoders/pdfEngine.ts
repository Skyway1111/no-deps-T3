// Zero-dependency PDF reader: objects, xref tables and streams, page tree, fonts, text extraction and a canvas painter.

export class Name {
  private static readonly cache = new Map<string, Name>();
  readonly value: string;
  private constructor(value: string) {
    this.value = value;
  }
  static of(value: string) {
    let name = Name.cache.get(value);
    if (!name) Name.cache.set(value, (name = new Name(value)));
    return name;
  }
}
export class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}
class Op {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}
export type PdfDict = Map<string, PdfValue>;
export type PdfStream = { dict: PdfDict; data: Uint8Array };
export type PdfValue =
  | number
  | boolean
  | null
  | Uint8Array
  | Name
  | Ref
  | PdfValue[]
  | PdfDict
  | PdfStream
  | Op;

const isStream = (value: PdfValue | undefined): value is PdfStream =>
  typeof value === "object" && value !== null && "data" in value && "dict" in value;
const isDict = (value: PdfValue | undefined): value is PdfDict => value instanceof Map;
const isBytes = (value: PdfValue | undefined): value is Uint8Array => value instanceof Uint8Array;

const WHITE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const latin1 = new TextDecoder("latin1");

class Lexer {
  pos: number;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }
  skip() {
    const b = this.bytes;
    for (;;) {
      while (this.pos < b.length && WHITE[b[this.pos]!]) this.pos++;
      if (b[this.pos] !== 0x25) return;
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
  }
  word() {
    const start = this.pos;
    while (
      this.pos < this.bytes.length &&
      !WHITE[this.bytes[this.pos]!] &&
      !DELIM[this.bytes[this.pos]!]
    )
      this.pos++;
    return latin1.decode(this.bytes.subarray(start, this.pos));
  }
  /** One object; refs only when `resolveRefs` lets `n g R` read ahead. */
  read(refs = true): PdfValue | undefined {
    this.skip();
    const b = this.bytes;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos]!;
    if (c === 0x2f) {
      this.pos++;
      return Name.of(
        this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      );
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const dict: PdfDict = new Map();
        for (;;) {
          this.skip();
          if (this.pos >= b.length) return dict;
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
            this.pos += 2;
            return dict;
          }
          const key = this.read(false);
          if (!(key instanceof Name)) {
            this.pos++;
            continue;
          }
          dict.set(key.value, this.read(refs) ?? null);
        }
      }
      this.pos++;
      const start = this.pos;
      while (this.pos < b.length && b[this.pos] !== 0x3e) this.pos++;
      return hexBytes(latin1.decode(b.subarray(start, this.pos++)));
    }
    if (c === 0x5b) {
      this.pos++;
      const array: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.pos >= b.length) return array;
        if (b[this.pos] === 0x5d) {
          this.pos++;
          return array;
        }
        const value = this.read(refs);
        if (value === undefined) return array;
        array.push(value);
      }
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos++;
      return new Op(String.fromCharCode(c));
    }
    const word = this.word();
    if (!word) {
      this.pos++;
      return new Op("");
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const value = Number(word);
      if (refs && /^\d+$/.test(word)) {
        const save = this.pos;
        this.skip();
        const gen = this.word();
        this.skip();
        if (
          /^\d+$/.test(gen) &&
          this.bytes[this.pos] === 0x52 &&
          (this.pos + 1 >= b.length || WHITE[b[this.pos + 1]!] || DELIM[b[this.pos + 1]!])
        ) {
          this.pos++;
          return new Ref(value, Number(gen));
        }
        this.pos = save;
      }
      return value;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return new Op(word);
  }
  literal() {
    const b = this.bytes;
    const out: number[] = [];
    let depth = 1;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const e = b[this.pos++]!;
        const escape = ESCAPES[e];
        if (escape !== undefined) out.push(escape);
        else if (e >= 0x30 && e <= 0x37) {
          let n = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++)
            n = n * 8 + b[this.pos++]! - 0x30;
          out.push(n & 255);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return Uint8Array.from(out);
  }
}
const ESCAPES: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
function hexBytes(text: string) {
  const hex = text.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt((hex.slice(i * 2, i * 2 + 2) + "0").slice(0, 2), 16);
  return out;
}

async function inflate(data: Uint8Array, raw = false): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream(raw ? "deflate-raw" : "deflate"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > 512 * 1024 * 1024) throw new Error("PDF stream is too large");
    }
  } catch (cause) {
    // Truncated or checksum-damaged streams keep what decoded; headerless ones retry as raw deflate.
    if (!total && !raw && data.length > 2)
      return inflate(data.subarray(2), true).catch(() => new Uint8Array());
    if (!total) throw cause;
  }
  return concat(chunks, total);
}
function concat(chunks: Uint8Array[], total = chunks.reduce((s, c) => s + c.length, 0)) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** PNG (10-15) and TIFF (2) predictors. */
function unpredict(data: Uint8Array, parms: PdfDict | undefined) {
  const predictor = num(parms?.get("Predictor"), 1);
  if (predictor < 2) return data;
  const colors = num(parms?.get("Colors"), 1);
  const bpc = num(parms?.get("BitsPerComponent"), 8);
  const columns = num(parms?.get("Columns"), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    const out = data.slice();
    for (let row = 0; row < out.length; row += rowBytes) {
      const end = Math.min(out.length, row + rowBytes);
      if (bpc === 16)
        for (let i = row + 2 * colors; i + 1 < end; i += 2) {
          const v =
            ((out[i]! << 8) | out[i + 1]!) +
            ((out[i - 2 * colors]! << 8) | out[i - 2 * colors + 1]!);
          out[i] = (v >> 8) & 255;
          out[i + 1] = v & 255;
        }
      else for (let i = row + bpp; i < end; i++) out[i] = (out[i]! + out[i - bpp]!) & 255;
    }
    return out;
  }
  const rows = Math.ceil(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]!;
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? out[dst + i - bpp]! : 0;
      const up = r ? out[dst + i - rowBytes]! : 0;
      let p = 0;
      if (type === 1) p = left;
      else if (type === 2) p = up;
      else if (type === 3) p = (left + up) >> 1;
      else if (type === 4) {
        const corner = r && i >= bpp ? out[dst + i - rowBytes - bpp]! : 0;
        const pa = Math.abs(up - corner),
          pb = Math.abs(left - corner),
          pc = Math.abs(left + up - 2 * corner);
        p = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      out[dst + i] = ((data[src + i] ?? 0) + p) & 255;
    }
  }
  return out;
}

function asciiHex(data: Uint8Array) {
  return hexBytes(latin1.decode(data).replace(/>.*$/s, ""));
}
function ascii85(data: Uint8Array) {
  const text = latin1
    .decode(data)
    .replace(/^\s*<~/, "")
    .replace(/~>.*$/s, "")
    .replace(/\s/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "z") {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const group = text.slice(i, i + 5);
    i += 5;
    let value = 0;
    for (const ch of group.padEnd(5, "u")) value = value * 85 + (ch.charCodeAt(0) - 33);
    for (let k = 0; k < group.length - 1; k++) out.push(Math.floor(value / 256 ** (3 - k)) & 255);
  }
  return Uint8Array.from(out);
}
function runLength(data: Uint8Array) {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (const b of data.subarray(i, i + n + 1)) out.push(b);
      i += n + 1;
    } else {
      const b = data[i++]!;
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}
function lzw(data: Uint8Array, early = 1) {
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: 258 }, (_, i) => [i]);
  };
  reset();
  let bits = 9;
  let prev: number[] | null = null;
  for (let pos = 0; pos + bits <= data.length * 8;) {
    let code = 0;
    for (let i = 0; i < bits; i++, pos++)
      code = (code << 1) | ((data[pos >> 3]! >> (7 - (pos & 7))) & 1);
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    const entry: number[] | undefined =
      table[code] ?? (prev && code === table.length ? [...prev, prev[0]!] : undefined);
    if (!entry) break;
    for (const b of entry) out.push(b);
    if (prev) table.push([...prev, entry[0]!]);
    prev = entry;
    if (table.length + early >= 1 << bits && bits < 12) bits++;
  }
  return Uint8Array.from(out);
}

const num = (value: PdfValue | undefined, fallback = 0) =>
  typeof value === "number" ? value : fallback;
const nameOf = (value: PdfValue | undefined) => (value instanceof Name ? value.value : undefined);

/** PDF text strings: UTF-16 with a byte order mark, UTF-8 with one, else PDFDocEncoding (close to Latin-1). */
export function pdfText(value: PdfValue | undefined) {
  if (!isBytes(value)) return "";
  if (value[0] === 0xfe && value[1] === 0xff)
    return new TextDecoder("utf-16be").decode(value.subarray(2));
  if (value[0] === 0xff && value[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(value.subarray(2));
  if (value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf)
    return new TextDecoder().decode(value.subarray(3));
  return latin1.decode(value);
}

export type PdfTextItem = {
  str: string;
  hasEOL: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  font: string;
};
export type PdfLink = { rect: [number, number, number, number] } & (
  | { url: string }
  | { page: number }
);
export type PdfPage = {
  dict: PdfDict;
  resources: PdfDict;
  box: [number, number, number, number];
  rotate: number;
  width: number;
  height: number;
};
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let faces = 0;

export class PdfDocument {
  readonly bytes: Uint8Array;
  private readonly offsets = new Map<number, number>();
  private readonly compressed = new Map<number, { stream: number; index: number }>();
  private readonly objectStreams = new Map<number, Map<number, PdfValue>>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly fonts = new Map<PdfDict, Promise<Font>>();
  private readonly spaces = new Map<object, Promise<ColorSpace>>();
  private readonly functions = new Map<object, Promise<Fn | null>>();
  /** Embedded fonts this document added to the page's font set. */
  readonly faces: FontFace[] = [];
  /** Optional content groups that start hidden. */
  hidden = new Set<PdfDict>();
  trailer: PdfDict = new Map();
  pages: PdfPage[] = [];
  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static async open(input: ArrayBuffer | Uint8Array) {
    const doc = new PdfDocument(input instanceof Uint8Array ? input : new Uint8Array(input));
    if (latin1.decode(doc.bytes.subarray(0, 1024)).indexOf("%PDF-") < 0)
      throw new Error("Not a PDF file");
    try {
      await doc.readXref();
    } catch {
      doc.offsets.clear();
      doc.compressed.clear();
    }
    if (!doc.trailer.get("Root")) doc.reconstruct();
    if (doc.trailer.get("Encrypt")) throw new Error("This PDF is encrypted.");
    for (const { stream } of doc.compressed.values()) await doc.loadObjectStream(stream);
    if (!isDict(doc.get(doc.trailer.get("Root")))) {
      doc.reconstruct();
      for (const { stream } of doc.compressed.values()) await doc.loadObjectStream(stream);
    }
    doc.pages = doc.collectPages();
    if (!doc.pages.length) throw new Error("This PDF has no pages.");
    const config = doc.dict(
      doc.dict(doc.dict(doc.trailer.get("Root"))?.get("OCProperties"))?.get("D"),
    );
    const groups = (key: string) => doc.array(config?.get(key)).filter(isDict);
    if (nameOf(config?.get("BaseState")) === "OFF") {
      const on = new Set(groups("ON"));
      for (const group of doc
        .array(doc.dict(doc.dict(doc.trailer.get("Root"))?.get("OCProperties"))?.get("OCGs"))
        .filter(isDict))
        if (!on.has(group)) doc.hidden.add(group);
    } else for (const group of groups("OFF")) doc.hidden.add(group);
    return doc;
  }

  get numPages() {
    return this.pages.length;
  }

  /** Removes the document's embedded fonts from the page. */
  destroy() {
    for (const face of this.faces) fontSet()?.delete(face);
    this.faces.length = 0;
    this.fonts.clear();
  }

  /** Document information, for titles and search. */
  get info() {
    const info = this.get(this.trailer.get("Info"));
    const out: Record<string, string> = {};
    if (isDict(info))
      for (const key of [
        "Title",
        "Author",
        "Subject",
        "Keywords",
        "Creator",
        "Producer",
        "CreationDate",
        "ModDate",
      ])
        if (info.has(key)) out[key] = pdfText(this.get(info.get(key)));
    return out;
  }

  private async readXref() {
    const tail = latin1.decode(this.bytes.subarray(Math.max(0, this.bytes.length - 2048)));
    const match = /startxref\s+(\d+)/g;
    let found: RegExpExecArray | null = null;
    for (let m = match.exec(tail); m; m = match.exec(tail)) found = m;
    if (!found) throw new Error("No startxref");
    const seen = new Set<number>();
    let offset: number | undefined = Number(found[1]);
    while (offset !== undefined && !seen.has(offset) && offset < this.bytes.length) {
      seen.add(offset);
      const lexer = new Lexer(this.bytes, offset);
      lexer.skip();
      let trailer: PdfDict;
      if (latin1.decode(this.bytes.subarray(lexer.pos, lexer.pos + 4)) === "xref") {
        lexer.pos += 4;
        for (;;) {
          lexer.skip();
          const start = lexer.read(false);
          if (start instanceof Op && start.value === "trailer") break;
          const count = lexer.read(false);
          if (typeof start !== "number" || typeof count !== "number") throw new Error("Bad xref");
          for (let i = 0; i < count; i++) {
            lexer.skip();
            const line = latin1.decode(this.bytes.subarray(lexer.pos, lexer.pos + 20));
            const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
            if (!entry) throw new Error("Bad xref entry");
            lexer.pos += 18;
            const id = start + i;
            if (entry[3] === "n" && !this.offsets.has(id) && !this.compressed.has(id))
              this.offsets.set(id, Number(entry[1]));
          }
        }
        const value = lexer.read();
        if (!isDict(value)) throw new Error("Bad trailer");
        trailer = value;
        const stream = trailer.get("XRefStm");
        if (typeof stream === "number") await this.readXrefStream(stream);
      } else trailer = await this.readXrefStream(offset);
      for (const [key, value] of trailer) if (!this.trailer.has(key)) this.trailer.set(key, value);
      const prev = trailer.get("Prev");
      offset = typeof prev === "number" ? prev : undefined;
    }
  }

  private async readXrefStream(offset: number) {
    const object = this.parseAt(offset);
    if (!isStream(object) || nameOf(object.dict.get("Type")) !== "XRef")
      throw new Error("Bad xref stream");
    const data = await this.decode(object);
    const widths = (object.dict.get("W") as number[]).map(Number);
    const size = num(object.dict.get("Size"));
    const index = (object.dict.get("Index") as number[] | undefined) ?? [0, size];
    const rowWidth = widths.reduce((s, w) => s + w, 0);
    let row = 0;
    const field = (at: number, width: number, fallback: number) => {
      if (!width) return fallback;
      let value = 0;
      for (let i = 0; i < width; i++) value = value * 256 + data[at + i]!;
      return value;
    };
    for (let s = 0; s + 1 < index.length; s += 2)
      for (let i = 0; i < index[s + 1]!; i++, row++) {
        const at = row * rowWidth;
        if (at + rowWidth > data.length) break;
        const type = field(at, widths[0]!, 1);
        const a = field(at + widths[0]!, widths[1]!, 0);
        const b = field(at + widths[0]! + widths[1]!, widths[2]!, 0);
        const id = index[s]! + i;
        if (this.offsets.has(id) || this.compressed.has(id)) continue;
        if (type === 1) this.offsets.set(id, a);
        else if (type === 2) this.compressed.set(id, { stream: a, index: b });
      }
    return object.dict;
  }

  /** Rebuilds the object table by scanning for `n g obj`, for files whose xref is missing or damaged. */
  private reconstruct() {
    const text = latin1.decode(this.bytes);
    const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = pattern.exec(text); m; m = pattern.exec(text))
      this.offsets.set(Number(m[1]), m.index);
    this.cache.clear();
    const trailerAt = text.lastIndexOf("trailer");
    if (trailerAt >= 0) {
      const value = new Lexer(this.bytes, trailerAt + 7).read();
      if (isDict(value)) for (const [key, entry] of value) this.trailer.set(key, entry);
    }
    if (!this.trailer.get("Root"))
      for (const [id] of this.offsets) {
        const object = this.object(id);
        if (isDict(object) && nameOf(object.get("Type")) === "Catalog")
          this.trailer.set("Root", new Ref(id, 0));
      }
  }

  private parseAt(offset: number): PdfValue | undefined {
    const lexer = new Lexer(this.bytes, offset);
    lexer.read(false);
    lexer.read(false);
    const keyword = lexer.read(false);
    if (!(keyword instanceof Op) || keyword.value !== "obj") return undefined;
    const value = lexer.read();
    lexer.skip();
    if (
      isDict(value) &&
      latin1.decode(this.bytes.subarray(lexer.pos, lexer.pos + 6)) === "stream"
    ) {
      let start = lexer.pos + 6;
      if (this.bytes[start] === 13) start++;
      if (this.bytes[start] === 10) start++;
      let length = this.get(value.get("Length"));
      const declared = typeof length === "number" ? start + length : -1;
      if (
        declared < 0 ||
        declared > this.bytes.length ||
        !/^\s*endstream/.test(latin1.decode(this.bytes.subarray(declared, declared + 20)))
      ) {
        const end = latin1
          .decode(this.bytes.subarray(start, Math.min(this.bytes.length, start + 64 * 1024 * 1024)))
          .indexOf("endstream");
        length = end < 0 ? this.bytes.length - start : end;
      }
      return { dict: value, data: this.bytes.subarray(start, start + (length as number)) };
    }
    return value;
  }

  private object(id: number): PdfValue | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    let value: PdfValue | undefined;
    const offset = this.offsets.get(id);
    if (offset !== undefined) {
      this.cache.set(id, null);
      value = this.parseAt(offset);
    } else {
      const entry = this.compressed.get(id);
      if (entry) value = this.objectStreams.get(entry.stream)?.get(id);
    }
    this.cache.set(id, value ?? null);
    return value;
  }

  private async loadObjectStream(id: number) {
    if (this.objectStreams.has(id)) return;
    this.objectStreams.set(id, new Map());
    const stream = this.object(id);
    if (!isStream(stream)) return;
    const data = await this.decode(stream);
    const first = num(stream.dict.get("First"));
    const count = num(stream.dict.get("N"));
    const header = new Lexer(data);
    const entries: [number, number][] = [];
    for (let i = 0; i < count; i++)
      entries.push([num(header.read(false)), num(header.read(false))]);
    const map = this.objectStreams.get(id)!;
    for (const [objectId, offset] of entries)
      map.set(objectId, new Lexer(data, first + offset).read() ?? null);
    for (const [objectId] of entries) this.cache.delete(objectId);
  }

  /** Resolves references, up to a bounded chain. */
  get(value: PdfValue | undefined): PdfValue | undefined {
    for (let depth = 0; value instanceof Ref && depth < 32; depth++) value = this.object(value.num);
    return value;
  }
  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.get(value);
    return isDict(resolved) ? resolved : isStream(resolved) ? resolved.dict : undefined;
  }
  array(value: PdfValue | undefined): PdfValue[] {
    const resolved = this.get(value);
    return Array.isArray(resolved) ? resolved.map((v) => this.get(v) ?? null) : [];
  }
  numbers(value: PdfValue | undefined) {
    return this.array(value).map((v) => num(v));
  }

  async decode(stream: PdfStream, stopAtImage = false): Promise<Uint8Array> {
    const filters = this.get(stream.dict.get("Filter") ?? stream.dict.get("F"));
    const parms = this.get(stream.dict.get("DecodeParms") ?? stream.dict.get("DP"));
    const list = (Array.isArray(filters) ? filters : filters ? [filters] : []).map((f) =>
      nameOf(this.get(f)),
    );
    const parmList = Array.isArray(parms) ? parms.map((p) => this.dict(p)) : [this.dict(parms)];
    let data = stream.data;
    for (const [i, filter] of list.entries()) {
      const p = parmList[i];
      if (filter === "FlateDecode" || filter === "Fl") data = unpredict(await inflate(data), p);
      else if (filter === "LZWDecode" || filter === "LZW")
        data = unpredict(lzw(data, num(p?.get("EarlyChange"), 1)), p);
      else if (filter === "ASCIIHexDecode" || filter === "AHx") data = asciiHex(data);
      else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
      else if (filter === "RunLengthDecode" || filter === "RL") data = runLength(data);
      else if (filter === "Crypt") continue;
      else if (stopAtImage) return data;
      else throw new Error(`Unsupported PDF filter ${filter}`);
    }
    return data;
  }

  /** A font resource, parsed once per document. */
  font(dict: PdfDict | undefined): Promise<Font> {
    if (!dict) return Promise.resolve(FALLBACK_FONT);
    let font = this.fonts.get(dict);
    if (!font) this.fonts.set(dict, (font = loadFont(this, dict).catch(() => FALLBACK_FONT)));
    return font;
  }

  /** A color space value, resolving resource names. */
  colorSpace(
    value: PdfValue | undefined,
    resources: PdfDict | undefined,
    depth = 0,
  ): Promise<ColorSpace> {
    const resolved = this.get(value);
    if (resolved instanceof Name) {
      const named = DEVICE_SPACES[resolved.value];
      if (named) return Promise.resolve(named);
      const entry = this.dict(resources?.get("ColorSpace"))?.get(resolved.value);
      return entry === undefined || depth > 8
        ? Promise.resolve(GRAY)
        : this.colorSpace(entry, resources, depth + 1);
    }
    if (!Array.isArray(resolved) && !isStream(resolved)) return Promise.resolve(GRAY);
    let space = this.spaces.get(resolved);
    if (!space)
      this.spaces.set(
        resolved,
        (space = makeColorSpace(this, resolved, resources, depth).catch(() => GRAY)),
      );
    return space;
  }

  function(value: PdfValue | undefined): Promise<Fn | null> {
    const resolved = this.get(value);
    if (typeof resolved !== "object" || resolved === null) return Promise.resolve(null);
    let fn = this.functions.get(resolved);
    if (!fn) this.functions.set(resolved, (fn = makeFunction(this, resolved).catch(() => null)));
    return fn;
  }

  private collectPages() {
    const pages: PdfPage[] = [];
    const root = this.dict(this.trailer.get("Root"));
    const seen = new Set<PdfDict>();
    const walk = (
      node: PdfDict | undefined,
      inherited: {
        resources?: PdfDict | undefined;
        media?: PdfValue[] | undefined;
        crop?: PdfValue[] | undefined;
        rotate?: number | undefined;
      },
    ) => {
      if (!node || seen.has(node) || pages.length > 10000) return;
      seen.add(node);
      const state = {
        resources: this.dict(node.get("Resources")) ?? inherited.resources,
        media: node.has("MediaBox") ? this.array(node.get("MediaBox")) : inherited.media,
        crop: node.has("CropBox") ? this.array(node.get("CropBox")) : inherited.crop,
        rotate: node.has("Rotate") ? num(this.get(node.get("Rotate"))) : inherited.rotate,
      };
      const kids = node.get("Kids");
      if (nameOf(node.get("Type")) === "Pages" || (kids && nameOf(node.get("Type")) !== "Page")) {
        for (const kid of this.array(kids)) walk(this.dict(kid), state);
        return;
      }
      const media = (state.media ?? [0, 0, 612, 792]).map((v) => num(v));
      const crop = state.crop?.map((v) => num(v));
      const box = (crop?.length === 4 ? intersect(media, crop) : media) as [
        number,
        number,
        number,
        number,
      ];
      const [x0, y0, x1, y1] = [
        Math.min(box[0], box[2]),
        Math.min(box[1], box[3]),
        Math.max(box[0], box[2]),
        Math.max(box[1], box[3]),
      ];
      const rotate = ((((state.rotate ?? 0) % 360) + 360) % 360) as number;
      const [w, h] = [x1 - x0 || 612, y1 - y0 || 792];
      pages.push({
        dict: node,
        resources: state.resources ?? new Map(),
        box: [x0, y0, x1, y1],
        rotate,
        width: rotate % 180 ? h : w,
        height: rotate % 180 ? w : h,
      });
    };
    walk(this.dict(root?.get("Pages")), {});
    return pages;
  }

  async contents(page: PdfPage) {
    const contents = this.get(page.dict.get("Contents"));
    const streams = (
      Array.isArray(contents) ? contents.map((c) => this.get(c)) : [contents]
    ).filter(isStream);
    const parts = await Promise.all(
      streams.map((s) => this.decode(s).catch(() => new Uint8Array())),
    );
    return concat(parts.flatMap((part) => [part, NEWLINE]));
  }

  /** Page user space to unrotated top-left viewport units (PDF points). */
  viewport(page: PdfPage): Matrix {
    const [x0, y0, x1, y1] = page.box;
    const h = y1 - y0;
    switch (page.rotate) {
      case 90:
        return [0, 1, 1, 0, -y0, -x0];
      case 180:
        return [-1, 0, 0, 1, x1, -y0];
      case 270:
        return [0, -1, -1, 0, y1, x1];
      default:
        return [1, 0, 0, -1, -x0, y0 + h];
    }
  }

  links(index: number): PdfLink[] {
    const page = this.pages[index]!;
    const out: PdfLink[] = [];
    const vp = this.viewport(page);
    for (const annotation of this.array(page.dict.get("Annots"))) {
      if (!isDict(annotation) || nameOf(annotation.get("Subtype")) !== "Link") continue;
      const rect = this.numbers(annotation.get("Rect"));
      if (rect.length !== 4) continue;
      const [ax, ay] = apply(vp, rect[0]!, rect[1]!);
      const [bx, by] = apply(vp, rect[2]!, rect[3]!);
      const box: [number, number, number, number] = [
        Math.min(ax, bx) / page.width,
        Math.min(ay, by) / page.height,
        Math.abs(bx - ax) / page.width,
        Math.abs(by - ay) / page.height,
      ];
      const action = this.dict(annotation.get("A"));
      const uri =
        action && nameOf(action.get("S")) === "URI" ? pdfText(this.get(action.get("URI"))) : "";
      if (/^https?:\/\//i.test(uri)) {
        out.push({ rect: box, url: uri });
        continue;
      }
      const target = this.destinationPage(
        action && nameOf(action.get("S")) === "GoTo" ? action.get("D") : annotation.get("Dest"),
      );
      if (target !== null) out.push({ rect: box, page: target });
    }
    return out;
  }

  private destinationPage(dest: PdfValue | undefined, depth = 0): number | null {
    let value = this.get(dest);
    if ((isBytes(value) || value instanceof Name) && depth < 4)
      value = this.namedDestination(isBytes(value) ? pdfText(value) : value.value);
    if (isDict(value)) value = this.get(value.get("D"));
    if (!Array.isArray(value)) return null;
    const first = value[0];
    if (typeof first === "number") return first;
    const target = this.get(first);
    const index = this.pages.findIndex((p) => p.dict === target);
    return index < 0 ? null : index;
  }

  private namedDestination(name: string): PdfValue | undefined {
    const root = this.dict(this.trailer.get("Root"));
    const legacy = this.dict(root?.get("Dests"));
    if (legacy?.has(name)) return this.get(legacy.get(name));
    const search = (node: PdfDict | undefined, depth: number): PdfValue | undefined => {
      if (!node || depth > 32) return undefined;
      const names = this.array(node.get("Names"));
      for (let i = 0; i + 1 < names.length; i += 2)
        if (pdfText(names[i]!) === name) return this.get(names[i + 1]!);
      for (const kid of this.array(node.get("Kids"))) {
        const kidDict = this.dict(kid);
        const limits = this.array(kidDict?.get("Limits")).map((v) => pdfText(v));
        if (limits.length === 2 && (name < limits[0]! || name > limits[1]!)) continue;
        const found = search(kidDict, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return search(this.dict(this.dict(root?.get("Names"))?.get("Dests")), 0);
  }

  /** Text runs in viewport points with hasEOL breaks, for search, copy and the text layer. */
  text(index: number) {
    return this.render(index);
  }

  /** Paints a page into a 2D context already scaled so one unit is one PDF point, returning its text runs. */
  paint(index: number, context: Ctx, signal?: AbortSignal) {
    return this.render(index, context, signal);
  }

  private async render(index: number, context?: Ctx, signal?: AbortSignal): Promise<PdfTextItem[]> {
    const page = this.pages[index]!;
    const items: PdfTextItem[] = [];
    const text = (item: PdfTextItem) => {
      // Pieces of one line merge into a run, with a space where the gap is a word break.
      const last = items.at(-1);
      const gap = last
        ? (item.x - (last.x + Math.cos(last.angle) * last.width)) / (last.height || 1)
        : 0;
      if (
        last &&
        last.angle === item.angle &&
        Math.abs(last.height - item.height) < 0.5 &&
        Math.abs(item.y - last.y) < last.height * 0.2 &&
        gap > -0.3 &&
        gap < 1.2
      ) {
        last.str +=
          (gap > 0.15 && !last.str.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") +
          item.str;
        last.width = item.x + Math.cos(item.angle) * item.width - last.x;
        return;
      }
      items.push(item);
    };
    if (context) {
      context.save();
      context.fillStyle = "#fff";
      context.fillRect(0, 0, page.width, page.height);
    }
    const base = context?.getTransform();
    const viewport = this.viewport(page);
    const device = base ? toMatrix(base.multiply(new DOMMatrix(viewport))) : viewport;
    const painter = new Painter(this, page, { text, signal }, context, device);
    try {
      await painter.run(await this.contents(page), page.resources, painter.initial(IDENTITY), 0);
      await painter.annotations(page);
    } finally {
      painter.close();
      context?.restore();
    }
    for (let i = 0; i < items.length; i++) {
      const next = items[i + 1];
      items[i]!.hasEOL = !next || Math.abs(next.y - items[i]!.y) > items[i]!.height * 0.5;
    }
    return items;
  }
}
const NEWLINE = Uint8Array.of(10);
const fontSet = () => (typeof document === "undefined" ? undefined : document.fonts);

function intersect(a: number[], b: number[]) {
  const [ax0, ay0, ax1, ay1] = [
    Math.min(a[0]!, a[2]!),
    Math.min(a[1]!, a[3]!),
    Math.max(a[0]!, a[2]!),
    Math.max(a[1]!, a[3]!),
  ];
  const [bx0, by0, bx1, by1] = [
    Math.min(b[0]!, b[2]!),
    Math.min(b[1]!, b[3]!),
    Math.max(b[0]!, b[2]!),
    Math.max(b[1]!, b[3]!),
  ];
  const box = [Math.max(ax0, bx0), Math.max(ay0, by0), Math.min(ax1, bx1), Math.min(ay1, by1)];
  return box[2]! > box[0]! && box[3]! > box[1]! ? box : a;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
const invert = (m: Matrix): Matrix => {
  const d = m[0] * m[3] - m[1] * m[2] || 1;
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
};
/** Geometric mean scale factor. */
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
const toMatrix = (value: number[] | DOMMatrix): Matrix =>
  value instanceof DOMMatrix
    ? [value.a, value.b, value.c, value.d, value.e, value.f]
    : value.length === 6
      ? (value as Matrix)
      : IDENTITY;

type Fn = (input: number[]) => number[];
type PsToken = number | string | PsToken[];
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

async function makeFunction(doc: PdfDocument, value: PdfValue): Promise<Fn | null> {
  if (Array.isArray(value)) {
    const fns = await Promise.all(value.map((f) => doc.function(f)));
    return fns.every(Boolean) ? (x) => fns.map((f) => f!(x)[0] ?? 0) : null;
  }
  if (value instanceof Name) return value.value === "Identity" ? (x) => x : null;
  const dict = doc.dict(value);
  if (!dict) return null;
  const domain = doc.numbers(dict.get("Domain"));
  const range = doc.numbers(dict.get("Range"));
  const limit = (values: number[], bounds: number[]) =>
    bounds.length
      ? values.map((v, i) =>
          bounds.length > 2 * i + 1 ? clamp(v, bounds[2 * i]!, bounds[2 * i + 1]!) : v,
        )
      : values;
  let fn: Fn | null = null;
  const type = num(doc.get(dict.get("FunctionType")));
  if (type === 2) {
    const c0 = dict.has("C0") ? doc.numbers(dict.get("C0")) : [0];
    const c1 = dict.has("C1") ? doc.numbers(dict.get("C1")) : [1];
    const n = num(doc.get(dict.get("N")), 1);
    fn = ([x = 0]) => c0.map((a, i) => a + Math.pow(x, n) * ((c1[i] ?? 1) - a));
  } else if (type === 3) {
    const fns = await Promise.all(doc.array(dict.get("Functions")).map((f) => doc.function(f)));
    const bounds = doc.numbers(dict.get("Bounds"));
    const encode = doc.numbers(dict.get("Encode"));
    const [d0 = 0, d1 = 1] = domain;
    fn = ([x = 0]) => {
      let k = 0;
      while (k < bounds.length && x >= bounds[k]!) k++;
      const lo = k ? bounds[k - 1]! : d0;
      const hi = k < bounds.length ? bounds[k]! : d1;
      const [e0 = 0, e1 = 1] = [encode[2 * k], encode[2 * k + 1]];
      return fns[k]?.([hi === lo ? e0 : e0 + ((x - lo) * (e1 - e0)) / (hi - lo)]) ?? [0];
    };
  } else if (type === 0 && isStream(value)) {
    const data = await doc.decode(value);
    const size = doc.numbers(dict.get("Size"));
    const bps = num(doc.get(dict.get("BitsPerSample")), 8);
    const m = size.length;
    const n = range.length >> 1;
    const encode = dict.has("Encode")
      ? doc.numbers(dict.get("Encode"))
      : size.flatMap((s) => [0, s - 1]);
    const decode = dict.has("Decode") ? doc.numbers(dict.get("Decode")) : range;
    const max = 2 ** bps - 1;
    const sample = (index: number) => {
      if (bps === 8) return data[index] ?? 0;
      if (bps === 16) return u16(data, index * 2);
      let v = 0;
      for (let bit = index * bps, end = bit + bps; bit < end; bit++)
        v = v * 2 + (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
      return v;
    };
    if (!m || m > 8 || !n) return null;
    fn = (x) => {
      const e = size.map((s, i) => {
        const [d0 = 0, d1 = 1] = [domain[2 * i], domain[2 * i + 1]];
        const [e0 = 0, e1 = s - 1] = [encode[2 * i], encode[2 * i + 1]];
        return clamp(e0 + (((x[i] ?? 0) - d0) * (e1 - e0)) / (d1 - d0 || 1), 0, s - 1);
      });
      const out = new Array<number>(n).fill(0);
      for (let corner = 0; corner < 1 << m; corner++) {
        let weight = 1;
        let offset = 0;
        let stride = 1;
        for (let i = 0; i < m; i++) {
          const lo = Math.floor(e[i]!);
          const frac = e[i]! - lo;
          const high = (corner >> i) & 1;
          weight *= high ? frac : 1 - frac;
          offset += Math.min(lo + high, size[i]! - 1) * stride;
          stride *= size[i]!;
        }
        if (weight) for (let j = 0; j < n; j++) out[j]! += weight * sample(offset * n + j);
      }
      return out.map((s, j) => decode[2 * j]! + (s * (decode[2 * j + 1]! - decode[2 * j]!)) / max);
    };
  } else if (type === 4 && isStream(value)) {
    const tokens: string[] = latin1.decode(await doc.decode(value)).match(/[{}]|[^\s{}]+/g) ?? [];
    let at = tokens.indexOf("{") + 1;
    const parse = (): PsToken[] => {
      const out: PsToken[] = [];
      while (at < tokens.length) {
        const token = tokens[at++]!;
        if (token === "{") out.push(parse());
        else if (token === "}") return out;
        else out.push(Number.isNaN(Number(token)) ? token : Number(token));
      }
      return out;
    };
    const program = parse();
    fn = (x) => {
      const stack: (number | boolean | PsToken[])[] = [...x];
      postscript(program, stack, 0);
      return stack.map((v) => (typeof v === "boolean" ? Number(v) : typeof v === "number" ? v : 0));
    };
  }
  if (!fn) return null;
  const inner = fn;
  return (x) => limit(inner(limit(x, domain)), range);
}

function postscript(program: PsToken[], s: (number | boolean | PsToken[])[], depth: number) {
  if (depth > 32) return;
  const pop = () => s.pop() as number;
  const bool = () => s.pop() as number | boolean;
  for (const token of program) {
    if (typeof token === "number" || Array.isArray(token)) {
      s.push(token);
      continue;
    }
    switch (token) {
      case "abs":
        s.push(Math.abs(pop()));
        break;
      case "add":
        s.push(pop() + pop());
        break;
      case "atan": {
        const den = pop();
        const deg = (Math.atan2(pop(), den) * 180) / Math.PI;
        s.push(deg < 0 ? deg + 360 : deg);
        break;
      }
      case "ceiling":
        s.push(Math.ceil(pop()));
        break;
      case "cos":
        s.push(Math.cos((pop() * Math.PI) / 180));
        break;
      case "cvi":
        s.push(Math.trunc(pop()));
        break;
      case "cvr":
        break;
      case "div": {
        const b = pop();
        s.push(pop() / (b || 1));
        break;
      }
      case "exp": {
        const e = pop();
        s.push(Math.pow(pop(), e));
        break;
      }
      case "floor":
        s.push(Math.floor(pop()));
        break;
      case "idiv": {
        const b = pop();
        s.push(Math.trunc(pop() / (b || 1)));
        break;
      }
      case "ln":
        s.push(Math.log(pop()));
        break;
      case "log":
        s.push(Math.log10(pop()));
        break;
      case "mod": {
        const b = pop();
        s.push(pop() % (b || 1));
        break;
      }
      case "mul":
        s.push(pop() * pop());
        break;
      case "neg":
        s.push(-pop());
        break;
      case "round":
        s.push(Math.round(pop()));
        break;
      case "sin":
        s.push(Math.sin((pop() * Math.PI) / 180));
        break;
      case "sqrt":
        s.push(Math.sqrt(pop()));
        break;
      case "sub": {
        const b = pop();
        s.push(pop() - b);
        break;
      }
      case "truncate":
        s.push(Math.trunc(pop()));
        break;
      case "and":
      case "or":
      case "xor": {
        const b = bool();
        const a = bool();
        if (typeof a === "boolean" && typeof b === "boolean")
          s.push(token === "and" ? a && b : token === "or" ? a || b : a !== b);
        else
          s.push(
            token === "and"
              ? Number(a) & Number(b)
              : token === "or"
                ? Number(a) | Number(b)
                : Number(a) ^ Number(b),
          );
        break;
      }
      case "not": {
        const a = bool();
        s.push(typeof a === "boolean" ? !a : ~a);
        break;
      }
      case "bitshift": {
        const shift = pop();
        const v = pop();
        s.push(shift >= 0 ? v << shift : v >> -shift);
        break;
      }
      case "true":
        s.push(true);
        break;
      case "false":
        s.push(false);
        break;
      case "eq":
        s.push(bool() === bool());
        break;
      case "ne":
        s.push(bool() !== bool());
        break;
      case "ge": {
        const b = pop();
        s.push(pop() >= b);
        break;
      }
      case "gt": {
        const b = pop();
        s.push(pop() > b);
        break;
      }
      case "le": {
        const b = pop();
        s.push(pop() <= b);
        break;
      }
      case "lt": {
        const b = pop();
        s.push(pop() < b);
        break;
      }
      case "if": {
        const proc = s.pop() as PsToken[];
        if (s.pop()) postscript(proc, s, depth + 1);
        break;
      }
      case "ifelse": {
        const no = s.pop() as PsToken[];
        const yes = s.pop() as PsToken[];
        postscript(s.pop() ? yes : no, s, depth + 1);
        break;
      }
      case "copy": {
        const n = pop();
        s.push(...s.slice(s.length - n));
        break;
      }
      case "dup":
        s.push(s.at(-1) ?? 0);
        break;
      case "exch": {
        const b = s.pop()!;
        const a = s.pop()!;
        s.push(b, a);
        break;
      }
      case "index": {
        const n = pop();
        s.push(s[s.length - 1 - n] ?? 0);
        break;
      }
      case "pop":
        s.pop();
        break;
      case "roll": {
        const j = pop();
        const n = pop();
        if (n > 0 && n <= s.length) {
          const items = s.splice(s.length - n, n);
          const k = ((j % n) + n) % n;
          s.push(...items.slice(n - k), ...items.slice(0, n - k));
        }
        break;
      }
    }
  }
}

type ColorSpace = {
  n: number;
  /** Components in the space's own units to 0-255 RGB. */
  rgb: (c: ArrayLike<number>) => number[];
  init: number[];
  /** Image Decode defaults, two per component. */
  range?: number[] | undefined;
  pattern?: { under: ColorSpace | null } | undefined;
  indexed?: true | undefined;
  device?: "gray" | "rgb" | "cmyk" | undefined;
};
const GRAY: ColorSpace = {
  n: 1,
  rgb: (c) => [(c[0] ?? 0) * 255, (c[0] ?? 0) * 255, (c[0] ?? 0) * 255],
  init: [0],
  device: "gray",
};
const RGB: ColorSpace = {
  n: 3,
  rgb: (c) => [(c[0] ?? 0) * 255, (c[1] ?? 0) * 255, (c[2] ?? 0) * 255],
  init: [0, 0, 0],
  device: "rgb",
};
/** CMYK to sRGB through PDF.js's polynomial fit of a SWOP press profile (Apache-2.0), far closer than 1-c·1-k. */
function cmyk(
  c: number,
  m: number,
  y: number,
  k: number,
  out: { [i: number]: number } = [0, 0, 0],
  at = 0,
) {
  out[at] =
    255 +
    c *
      (-4.387332384609988 * c +
        54.48615194189176 * m +
        18.82290502165302 * y +
        212.25662451639585 * k -
        285.2331026137004) +
    m *
      (1.7149763477362134 * m -
        5.6096736904047315 * y -
        17.873870861415444 * k -
        5.497006427196366) +
    y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
    k * (-21.86122147463605 * k - 189.48180835922747);
  out[at + 1] =
    255 +
    c *
      (8.841041422036149 * c +
        60.118027045597366 * m +
        6.871425592049007 * y +
        31.159100130055922 * k -
        79.2970844816548) +
    m *
      (-15.310361306967817 * m +
        17.575251261109482 * y +
        131.35250912493976 * k -
        190.9453302588951) +
    y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
    k * (-20.737325471181034 * k - 187.80453709719578);
  out[at + 2] =
    255 +
    c *
      (0.8842522430003296 * c +
        8.078677503112928 * m +
        30.89978309703729 * y -
        0.23883238689178934 * k -
        14.183576799673286) +
    m *
      (10.49593273432072 * m +
        63.02378494754052 * y +
        50.606957656360734 * k -
        112.23884253719248) +
    y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
    k * (-22.33816807309886 * k - 180.12613974708367);
  return out as number[];
}
const CMYK: ColorSpace = {
  n: 4,
  rgb: (c) => cmyk(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1).map((v) => clamp(v, 0, 255)),
  init: [0, 0, 0, 1],
  device: "cmyk",
};
const PATTERN: ColorSpace = {
  n: 0,
  rgb: () => [128, 128, 128],
  init: [],
  pattern: { under: null },
};
const DEVICE_SPACES: Record<string, ColorSpace> = {
  DeviceGray: GRAY,
  G: GRAY,
  CalGray: GRAY,
  DeviceRGB: RGB,
  RGB,
  CalRGB: RGB,
  DeviceCMYK: CMYK,
  CMYK,
  Pattern: PATTERN,
};

function lab(white: number[], range: number[]): ColorSpace {
  const [xw = 0.9505, , zw = 1.089] = white;
  const g = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const gamma = (v: number) =>
    255 * clamp(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055, 0, 1);
  return {
    n: 3,
    init: [0, 0, 0],
    range: [0, 100, range[0] ?? -100, range[1] ?? 100, range[2] ?? -100, range[3] ?? 100],
    rgb: (c) => {
      const fy = ((c[0] ?? 0) + 16) / 116;
      const x = xw * g(fy + (c[1] ?? 0) / 500);
      const y = g(fy);
      const z = zw * g(fy - (c[2] ?? 0) / 200);
      return [
        gamma(3.2406 * x - 1.5372 * y - 0.4986 * z),
        gamma(-0.9689 * x + 1.8758 * y + 0.0415 * z),
        gamma(0.0557 * x - 0.204 * y + 1.057 * z),
      ];
    },
  };
}

async function makeColorSpace(
  doc: PdfDocument,
  value: PdfValue[] | PdfStream,
  resources: PdfDict | undefined,
  depth: number,
): Promise<ColorSpace> {
  if (!Array.isArray(value)) return GRAY;
  const family = nameOf(doc.get(value[0]));
  const sub = (v: PdfValue | undefined) => doc.colorSpace(v, resources, depth + 1);
  switch (family) {
    case "ICCBased": {
      const dict = doc.dict(value[1]);
      const n = num(doc.get(dict?.get("N")), 3);
      return dict?.has("Alternate")
        ? sub(dict.get("Alternate"))
        : n === 1
          ? GRAY
          : n === 4
            ? CMYK
            : RGB;
    }
    case "Indexed":
    case "I": {
      const base = await sub(value[1]);
      const hival = clamp(Math.floor(num(doc.get(value[2]))), 0, 255);
      const source = doc.get(value[3]);
      const lookup = isStream(source)
        ? await doc.decode(source)
        : isBytes(source)
          ? source
          : new Uint8Array();
      const range = base.range ?? [];
      const palette = new Float32Array((hival + 1) * 3);
      for (let i = 0; i <= hival; i++) {
        const comps = Array.from({ length: base.n }, (_, k) => {
          const [lo = 0, hi = 1] = [range[2 * k], range[2 * k + 1]];
          return lo + ((lookup[i * base.n + k] ?? 0) / 255) * (hi - lo);
        });
        palette.set(base.rgb(comps).slice(0, 3), i * 3);
      }
      return {
        n: 1,
        init: [0],
        indexed: true,
        rgb: (c) => {
          const i = clamp(Math.round(c[0] ?? 0), 0, hival) * 3;
          return [palette[i]!, palette[i + 1]!, palette[i + 2]!];
        },
      };
    }
    case "Separation":
    case "DeviceN": {
      const n = family === "Separation" ? 1 : doc.array(value[1]).length;
      const alt = await sub(value[2]);
      const fn = await doc.function(value[3]);
      if (family === "Separation" && nameOf(doc.get(value[1])) === "None")
        return { n, init: [1], rgb: () => [255, 255, 255] };
      return {
        n,
        init: new Array<number>(n).fill(1),
        rgb: (c) =>
          fn
            ? alt.rgb(fn(Array.from(c)))
            : [255 * (1 - (c[0] ?? 0)), 255 * (1 - (c[0] ?? 0)), 255 * (1 - (c[0] ?? 0))],
      };
    }
    case "Lab":
      return lab(
        doc.numbers(doc.dict(value[1])?.get("WhitePoint")),
        doc.numbers(doc.dict(value[1])?.get("Range")),
      );
    case "Pattern": {
      const under = value[1] === undefined ? null : await sub(value[1]);
      return { n: under?.n ?? 0, rgb: under?.rgb ?? PATTERN.rgb, init: [], pattern: { under } };
    }
    default:
      return DEVICE_SPACES[family ?? ""] ?? GRAY;
  }
}

/** CFF standard strings 0-228: the Latin glyph names, which StandardEncoding and most fonts use. */
const CFF_NAMES =
  ".notdef space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft guilsinglleft guilsinglright fi fl endash dagger daggerdbl periodcentered paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand questiondown grave acute circumflex tilde macron breve dotaccent dieresis ring cedilla hungarumlaut ogonek caron emdash AE ordfeminine Lslash Oslash OE ordmasculine ae dotlessi lslash oslash oe germandbls onesuperior logicalnot mu trademark Eth onehalf plusminus Thorn onequarter divide brokenbar degree thorn threequarters twosuperior registered minus eth multiply threesuperior copyright Aacute Acircumflex Adieresis Agrave Aring Atilde Ccedilla Eacute Ecircumflex Edieresis Egrave Iacute Icircumflex Idieresis Igrave Ntilde Oacute Ocircumflex Odieresis Ograve Otilde Scaron Uacute Ucircumflex Udieresis Ugrave Yacute Ydieresis Zcaron aacute acircumflex adieresis agrave aring atilde ccedilla eacute ecircumflex edieresis egrave iacute icircumflex idieresis igrave ntilde oacute ocircumflex odieresis ograve otilde scaron uacute ucircumflex udieresis ugrave yacute ydieresis zcaron".split(
    " ",
  );
/** Unicode for CFF_NAMES[1..]. */
const CFF_CHARS =
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Glyph data: the em dash code point, not copy.
  " !\"#$%&’()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_‘abcdefghijklmnopqrstuvwxyz{|}~¡¢£⁄¥ƒ§¤'“«‹›ﬁﬂ–†‡·¶•‚„”»…‰¿`´ˆ˜¯˘˙¨˚¸˝˛ˇ\u2014ÆªŁØŒºæıłøœß¹¬µ™Ð½±Þ¼÷¦°þ¾²®−ð×³©ÁÂÄÀÅÃÇÉÊËÈÍÎÏÌÑÓÔÖÒÕŠÚÛÜÙÝŸŽáâäàåãçéêëèíîïìñóôöòõšúûüùýÿž";
const GLYPHS = new Map<string, string>([
  ...CFF_NAMES.slice(1).map((name, i): [string, string] => [name, CFF_CHARS[i]!]),
  ["ff", "ﬀ"],
  ["ffi", "ﬃ"],
  ["ffl", "ﬄ"],
  ["nbspace", " "],
  ["nonbreakingspace", " "],
  ["Euro", "€"],
  ["sfthyphen", "-"],
  ["middot", "·"],
  ["mu1", "µ"],
  ["Omega", "Ω"],
  ["Delta", "∆"],
  ["arrowleft", "←"],
  ["arrowup", "↑"],
  ["arrowright", "→"],
  ["arrowdown", "↓"],
  ["arrowboth", "↔"],
  ["infinity", "∞"],
  ["lessequal", "≤"],
  ["greaterequal", "≥"],
  ["notequal", "≠"],
  ["approxequal", "≈"],
  ["summation", "∑"],
  ["product", "∏"],
  ["integral", "∫"],
  ["radical", "√"],
  ["partialdiff", "∂"],
  ["lozenge", "◊"],
  ["dotlessj", "ȷ"],
  ["checkmark", "✓"],
  ["bulletmath", "∙"],
  ["circlecopyrt", "©"],
  ["periodcentered", "·"],
  ["asteriskmath", "∗"],
  ["element", "∈"],
  ["union", "∪"],
  ["intersection", "∩"],
  ["universal", "∀"],
  ["existential", "∃"],
  ["emptyset", "∅"],
  ["similar", "∼"],
  ["prime", "′"],
  ["alpha", "α"],
  ["beta", "β"],
  ["gamma", "γ"],
  ["delta", "δ"],
  ["epsilon", "ε"],
  ["zeta", "ζ"],
  ["eta", "η"],
  ["theta", "θ"],
  ["iota", "ι"],
  ["kappa", "κ"],
  ["lambda", "λ"],
  ["nu", "ν"],
  ["xi", "ξ"],
  ["pi", "π"],
  ["rho", "ρ"],
  ["sigma", "σ"],
  ["tau", "τ"],
  ["upsilon", "υ"],
  ["phi", "φ"],
  ["chi", "χ"],
  ["psi", "ψ"],
  ["omega", "ω"],
  ["Gamma", "Γ"],
  ["Theta", "Θ"],
  ["Lambda", "Λ"],
  ["Xi", "Ξ"],
  ["Pi", "Π"],
  ["Sigma", "Σ"],
  ["Upsilon", "Υ"],
  ["Phi", "Φ"],
  ["Psi", "Ψ"],
]);
const MARKS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circumflex: "̂",
  dieresis: "̈",
  tilde: "̃",
  ring: "̊",
  cedilla: "̧",
  caron: "̌",
  macron: "̄",
  breve: "̆",
  dotaccent: "̇",
  ogonek: "̨",
  hungarumlaut: "̋",
  commaaccent: "̦",
};

/** Unicode for an Adobe glyph name: the standard Latin set, uniXXXX/uXXXX, accents, ligature and suffix forms. */
function glyphText(name: string, depth = 0): string {
  const known = GLYPHS.get(name);
  if (known) return known;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (uni)
    return String.fromCharCode(...(uni[1]!.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  const u = /^u([0-9A-F]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(Math.min(0x10ffff, parseInt(u[1]!, 16)));
  if (depth > 2) return "";
  const dot = name.indexOf(".");
  if (dot > 0) return glyphText(name.slice(0, dot), depth + 1);
  if (name.includes("_"))
    return name
      .split("_")
      .map((part) => glyphText(part, depth + 1))
      .join("");
  const accented =
    /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|dotaccent|ogonek|hungarumlaut|commaaccent)$/.exec(
      name,
    );
  if (accented) return (accented[1]! + MARKS[accented[2]!]).normalize("NFC");
  return "";
}

// oxlint-disable-next-line t3code/no-em-dash-copy -- Glyph data: the em dash code point, not copy.
const WIN_ANSI_HIGH = "€•‚ƒ„…†‡ˆ‰Š‹Œ•Ž••‘’“”•–\u2014˜™š›œ•žŸ";
const STANDARD_HIGH =
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Glyph data: the em dash code point, not copy.
  "\0¡¢£⁄¥ƒ§¤'“«‹›ﬁﬂ\0–†‡·\0¶•‚„”»…‰\0¿\0`´ˆ˜¯˘˙¨\0˚¸\0˝˛ˇ\u2014\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0Æ\0ª\0\0\0\0ŁØŒº\0\0\0\0\0æ\0\0\0ı\0\0łøœß\0\0\0\0";
const macRoman = (() => {
  try {
    return new TextDecoder("macintosh");
  } catch {
    return latin1;
  }
})();
/** A base encoding as Unicode per code; empty strings for unmapped codes. */
function encodingTable(name: string | undefined) {
  return Array.from({ length: 256 }, (_, code) => {
    if (code < 32) return "";
    if (name === "StandardEncoding")
      return code < 127
        ? code === 0x27
          ? "’"
          : code === 0x60
            ? "‘"
            : String.fromCharCode(code)
        : code < 160
          ? ""
          : STANDARD_HIGH[code - 160]!.replace("\0", "");
    if (name === "MacRomanEncoding" && code >= 128) return macRoman.decode(Uint8Array.of(code));
    if (code >= 0x80 && code < 0xa0) return WIN_ANSI_HIGH[code - 0x80]!;
    return code === 0xa0
      ? " "
      : code === 0xad
        ? "-"
        : code === 127
          ? ""
          : String.fromCharCode(code);
  });
}

type CMap = {
  space: { lo: number[]; hi: number[] }[];
  uni: Map<number, string>;
  cid: Map<number, number>;
  ranges: [number, number, number][];
};
const IDENTITY_SPACE = [{ lo: [0, 0], hi: [255, 255] }];

const utf16 = (b: Uint8Array) => {
  if (b.length % 2) return latin1.decode(b);
  let out = "";
  for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return out;
};

/** ToUnicode (bfchar/bfrange) and encoding (cidchar/cidrange) CMaps with their code space. */
function parseCMap(data: Uint8Array): CMap {
  const cmap: CMap = { space: [], uni: new Map(), cid: new Map(), ranges: [] };
  const lexer = new Lexer(data);
  const int = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);
  const stack: PdfValue[] = [];
  for (let token = lexer.read(false); token !== undefined; token = lexer.read(false)) {
    if (!(token instanceof Op)) {
      stack.push(token);
      continue;
    }
    switch (token.value) {
      case "endcodespacerange":
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const [lo, hi] = [stack[i], stack[i + 1]];
          if (isBytes(lo) && isBytes(hi) && lo.length === hi.length)
            cmap.space.push({ lo: [...lo], hi: [...hi] });
        }
        break;
      case "endbfchar":
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const [src, dst] = [stack[i], stack[i + 1]];
          if (isBytes(src))
            cmap.uni.set(
              int(src),
              isBytes(dst) ? utf16(dst) : dst instanceof Name ? glyphText(dst.value) : "",
            );
        }
        break;
      case "endbfrange":
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const [lo, hi, dst] = [stack[i], stack[i + 1], stack[i + 2]];
          if (!isBytes(lo) || !isBytes(hi)) continue;
          const start = int(lo);
          const end = Math.min(int(hi), start + 65535);
          const base = isBytes(dst) ? utf16(dst) : "";
          for (let code = start; code <= end; code++) {
            if (Array.isArray(dst)) {
              const item = dst[code - start];
              if (isBytes(item)) cmap.uni.set(code, utf16(item));
            } else if (base)
              cmap.uni.set(
                code,
                base.slice(0, -1) +
                  String.fromCharCode(base.charCodeAt(base.length - 1) + code - start),
              );
          }
        }
        break;
      case "endcidchar":
        for (let i = 0; i + 1 < stack.length; i += 2)
          if (isBytes(stack[i])) cmap.cid.set(int(stack[i] as Uint8Array), num(stack[i + 1]));
        break;
      case "endcidrange":
        for (let i = 0; i + 2 < stack.length; i += 3)
          if (isBytes(stack[i]) && isBytes(stack[i + 1]))
            cmap.ranges.push([
              int(stack[i] as Uint8Array),
              int(stack[i + 1] as Uint8Array),
              num(stack[i + 2]),
            ]);
        break;
    }
    if (/^(begin|end)/.test(token.value)) stack.length = 0;
  }
  return cmap;
}

/** The next character code under a code space: the shortest byte sequence inside one of its ranges. */
function readCode(bytes: Uint8Array, at: number, space: CMap["space"]): [number, number] {
  for (let len = 1; len <= 4 && at + len <= bytes.length; len++)
    for (const range of space) {
      if (range.lo.length !== len) continue;
      let inside = true;
      for (let k = 0; k < len && inside; k++)
        inside = bytes[at + k]! >= range.lo[k]! && bytes[at + k]! <= range.hi[k]!;
      if (inside) {
        let code = 0;
        for (let k = 0; k < len; k++) code = code * 256 + bytes[at + k]!;
        return [code, len];
      }
    }
  const len = Math.min(bytes.length - at, Math.min(...space.map((r) => r.lo.length)) || 1);
  let code = 0;
  for (let k = 0; k < len; k++) code = code * 256 + bytes[at + k]!;
  return [code, Math.max(1, len)];
}

const u16 = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => u16(b, o) * 65536 + u16(b, o + 2);
const SIZES = { B: 1, H: 2, h: 2, L: 4 } as const;
/** Big-endian struct packing: B u8, H/h 16-bit, L 32-bit; negative values wrap. */
function pack(format: string, ...values: number[]) {
  const out = new Uint8Array([...format].reduce((s, c) => s + SIZES[c as keyof typeof SIZES], 0));
  let at = 0;
  [...format].forEach((c, i) => {
    const size = SIZES[c as keyof typeof SIZES];
    let v = Math.round(values[i] ?? 0);
    for (let k = size - 1; k >= 0; k--, v = Math.floor(v / 256)) out[at + k] = v & 255;
    at += size;
  });
  return out;
}

function sfntTables(data: Uint8Array) {
  const base = latin1.decode(data.subarray(0, 4)) === "ttcf" ? u32(data, 12) : 0;
  const tables = new Map<string, Uint8Array>();
  for (let i = 0, n = u16(data, base + 4); i < n; i++) {
    const at = base + 12 + i * 16;
    if (at + 16 > data.length) break;
    const offset = u32(data, at + 8);
    tables.set(
      latin1.decode(data.subarray(at, at + 4)),
      data.subarray(offset, Math.min(data.length, offset + u32(data, at + 12))),
    );
  }
  return tables;
}

/** cmap subtables keyed "platform,encoding", each code to glyph. */
function sfntCmaps(cmap: Uint8Array | undefined) {
  const out = new Map<string, Map<number, number>>();
  if (!cmap) return out;
  let budget = 200_000;
  for (let i = 0, n = u16(cmap, 2); i < n; i++) {
    const key = `${u16(cmap, 4 + i * 8)},${u16(cmap, 6 + i * 8)}`;
    const t = cmap.subarray(u32(cmap, 8 + i * 8));
    const map = new Map<number, number>();
    const format = u16(t, 0);
    if (format === 0) for (let c = 0; c < 256; c++) map.set(c, t[6 + c] ?? 0);
    else if (format === 4) {
      const segs = u16(t, 6) >> 1;
      for (let s = 0; s < segs && budget > 0; s++) {
        const end = u16(t, 14 + s * 2);
        const start = u16(t, 16 + segs * 2 + s * 2);
        const delta = u16(t, 16 + segs * 4 + s * 2);
        const roAt = 16 + segs * 6 + s * 2;
        const ro = u16(t, roAt);
        for (let c = start; c <= end && c !== 0xffff && budget-- > 0; c++) {
          const g = ro ? u16(t, roAt + ro + (c - start) * 2) : c;
          map.set(c, ro && !g ? 0 : (g + delta) & 0xffff);
        }
      }
    } else if (format === 6)
      for (let k = 0, first = u16(t, 6), count = u16(t, 8); k < count; k++)
        map.set(first + k, u16(t, 10 + k * 2));
    else if (format === 12)
      for (let g = 0, groups = u32(t, 12); g < groups && budget > 0; g++) {
        const start = u32(t, 16 + g * 12);
        const end = Math.min(u32(t, 20 + g * 12), start + 65535);
        for (let c = start, gid = u32(t, 24 + g * 12); c <= end && budget-- > 0; c++, gid++)
          map.set(c, gid);
      }
    if (!out.has(key)) out.set(key, map);
  }
  return out;
}

function cffIndex(b: Uint8Array, pos: number) {
  const count = u16(b, pos);
  if (!count) return { items: [] as Uint8Array[], end: pos + 2 };
  const size = b[pos + 2] ?? 1;
  const offset = (i: number) => {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + (b[pos + 3 + i * size + k] ?? 0);
    return v;
  };
  const base = pos + 2 + (count + 1) * size;
  return {
    items: Array.from({ length: count }, (_, i) =>
      b.subarray(base + offset(i), base + offset(i + 1)),
    ),
    end: base + offset(count),
  };
}
function cffDict(d: Uint8Array) {
  const out = new Map<number, number[]>();
  let operands: number[] = [];
  for (let i = 0; i < d.length;) {
    const b0 = d[i++]!;
    if (b0 <= 21) {
      out.set(b0 === 12 ? 1200 + d[i++]! : b0, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(i16(d, i));
      i += 2;
    } else if (b0 === 29) {
      operands.push(u32(d, i) | 0);
      i += 4;
    } else if (b0 === 30) {
      let text = "";
      for (let done = false; !done && i < d.length; i++)
        for (const nibble of [d[i]! >> 4, d[i]! & 15]) {
          if (nibble === 15) {
            done = true;
            break;
          }
          text += "0123456789.EE?-"[nibble]! + (nibble === 12 ? "-" : "");
        }
      operands.push(parseFloat(text) || 0);
    } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + d[i++]! + 108);
    else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - d[i++]! - 108);
  }
  return out;
}

type CffInfo = {
  glyphs: number;
  cid: boolean;
  charset: number[];
  names: string[];
  encoding: Map<number, number>;
  matrix: number[];
  bbox: number[];
};

function parseCff(data: Uint8Array): CffInfo {
  const names = cffIndex(data, data[2] ?? 4);
  const top = cffIndex(data, names.end);
  const strings = cffIndex(data, top.end);
  const dict = cffDict(top.items[0] ?? new Uint8Array());
  const glyphs = cffIndex(data, dict.get(17)?.[0] ?? 0).items.length;
  const cid = dict.has(1230);
  const charset = [0];
  const at = dict.get(15)?.[0] ?? 0;
  if (at > 2) {
    const format = data[at];
    let p = at + 1;
    if (format === 0) for (; charset.length < glyphs; p += 2) charset.push(u16(data, p));
    else
      while (charset.length < glyphs && p < data.length) {
        const first = u16(data, p);
        const left = format === 1 ? data[p + 2]! : u16(data, p + 2);
        p += format === 1 ? 3 : 4;
        for (let k = 0; k <= left && charset.length < glyphs; k++) charset.push(first + k);
      }
  } else while (charset.length < glyphs) charset.push(charset.length);
  const name = (sid: number) =>
    sid < CFF_NAMES.length
      ? CFF_NAMES[sid]!
      : sid >= 391 && strings.items[sid - 391]
        ? latin1.decode(strings.items[sid - 391])
        : "";
  const sidToGid = new Map(charset.map((sid, gid) => [sid, gid]));
  const encoding = new Map<number, number>();
  const enc = dict.get(16)?.[0] ?? 0;
  if (!cid && enc > 1) {
    const format = data[enc]! & 0x7f;
    let p = enc + 1;
    if (format === 0)
      for (let gid = 1, count = data[p++]!; gid <= count; gid++) encoding.set(data[p++]!, gid);
    else if (format === 1)
      for (let r = 0, ranges = data[p++]!, gid = 1; r < ranges; r++, p += 2)
        for (let k = 0; k <= data[p + 1]!; k++) encoding.set(data[p]! + k, gid++);
    if (data[enc]! & 0x80)
      for (let s = 0, sups = data[p++]!; s < sups; s++, p += 3) {
        const gid = sidToGid.get(u16(data, p + 1));
        if (gid !== undefined) encoding.set(data[p]!, gid);
      }
  } else if (!cid && enc === 0) {
    const standard = encodingTable("StandardEncoding");
    for (let code = 0; code < 256; code++) {
      const sid = CFF_CHARS.indexOf(standard[code]!) + 1;
      const gid = sid > 0 ? sidToGid.get(sid) : undefined;
      if (gid !== undefined && standard[code]) encoding.set(code, gid);
    }
  }
  return {
    glyphs,
    cid,
    charset,
    names: cid ? [] : charset.map(name),
    encoding,
    matrix: dict.get(1207) ?? [0.001, 0, 0, 0.001, 0, 0],
    bbox: dict.get(5) ?? [0, -200, 1000, 800],
  };
}

/** Private Use Area character drawing glyph `gid` in a rebuilt font. */
const pua = (gid: number) =>
  gid < 0x1900 ? String.fromCharCode(0xe000 + gid) : String.fromCodePoint(0xf0000 + gid);

function utf16be(text: string) {
  return Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]));
}

/**
 * A browser-loadable OpenType font from a PDF's TrueType or CFF program: glyph data and metrics are kept, and fresh
 * cmap/OS/2/name/post tables map Private Use Area characters straight to glyph ids, so PDF codes never meet the
 * subset's own (often missing or symbolic) cmap. Hinting programs are dropped: unhinted outlines match other PDF
 * renderers and are what browser sanitizers most often reject.
 */
function buildFont(source: Map<string, Uint8Array>, glyphCount: number): Uint8Array | null {
  const head = source.get("head");
  const cff = source.get("CFF ");
  const glyf = source.get("glyf");
  const loca = source.get("loca");
  if (!head || head.length < 54 || (!cff && (!glyf || !loca))) return null;
  const tables = new Map<string, Uint8Array>();
  const newHead = head.slice(0, 54);
  newHead.set(pack("LL", 0, 0x5f0f3cf5), 8);
  let n = glyphCount;
  if (cff) tables.set("CFF ", cff);
  else {
    const long = u16(head, 50) === 1;
    const entries = Math.floor(loca!.length / (long ? 4 : 2));
    n = Math.min(n || entries - 1, entries - 1);
    if (n < 1) return null;
    const offsets = new Uint8Array((n + 1) * 4);
    for (let i = 0, prev = 0; i <= n; i++) {
      const raw = long ? u32(loca!, i * 4) : u16(loca!, i * 2) * 2;
      prev = Math.max(prev, Math.min(raw, glyf!.length));
      offsets.set(pack("L", prev), i * 4);
    }
    newHead.set(pack("H", 1), 50);
    tables.set("glyf", glyf!).set("loca", offsets);
  }
  if (n < 1) return null;
  tables.set("head", newHead);
  const maxp = source.get("maxp");
  if (cff) tables.set("maxp", pack("LH", 0x5000, n));
  else if (maxp && maxp.length >= 32) {
    const copy = maxp.slice(0, 32);
    copy.set(pack("LH", 0x10000, n), 0);
    tables.set("maxp", copy);
  } else
    tables.set("maxp", pack("LHHHHHHHHHHHHHH", 0x10000, n, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0));
  const upem = u16(newHead, 18) || 1000;
  const sourceHhea = source.get("hhea");
  const ascent =
    sourceHhea && sourceHhea.length >= 36 ? i16(sourceHhea, 4) : Math.round(upem * 0.8);
  const descent =
    sourceHhea && sourceHhea.length >= 36 ? i16(sourceHhea, 6) : -Math.round(upem * 0.2);
  const metrics = sourceHhea && sourceHhea.length >= 36 ? clamp(u16(sourceHhea, 34), 1, n) : 1;
  const hhea =
    sourceHhea && sourceHhea.length >= 36
      ? sourceHhea.slice(0, 36)
      : pack(
          "LhhhHhhhhhhhhhhhH",
          0x10000,
          ascent,
          descent,
          0,
          upem,
          0,
          0,
          upem,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          1,
        );
  hhea.set(pack("H", metrics), 34);
  tables.set("hhea", hhea);
  const hmtx = new Uint8Array(metrics * 4 + (n - metrics) * 2);
  const sourceHmtx = source.get("hmtx");
  if (sourceHmtx) hmtx.set(sourceHmtx.subarray(0, hmtx.length));
  else hmtx.set(pack("H", upem));
  tables.set("hmtx", hmtx);
  tables.set(
    "OS/2",
    pack(
      "HhHHHhhhhhhhhhhhBBBBBBBBBBLLLLBBBBHHHhhhHHLLhhHHH",
      3,
      Math.round(upem / 2),
      400,
      5,
      0,
      upem * 0.65,
      upem * 0.6,
      0,
      upem * 0.075,
      upem * 0.65,
      upem * 0.6,
      0,
      upem * 0.35,
      upem * 0.05,
      upem * 0.3,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0x10000000,
      0,
      0,
      0x50,
      0x44,
      0x46,
      0x20,
      0x40,
      0xe000,
      0xffff,
      ascent,
      descent,
      0,
      Math.max(0, ascent),
      Math.max(0, -descent),
      1,
      0,
      0,
      0,
      0,
      32,
      1,
    ),
  );
  const strings = ["PdfFont", "Regular", "PdfFont", "PdfFont", "Version 1.0", "PdfFont"].map(
    utf16be,
  );
  const records = strings.map((s, i) =>
    pack(
      "HHHHHH",
      3,
      1,
      0x409,
      i + 1,
      s.length,
      strings.slice(0, i).reduce((t, x) => t + x.length, 0),
    ),
  );
  tables.set(
    "name",
    concat([pack("HHH", 0, strings.length, 6 + 12 * strings.length), ...records, ...strings]),
  );
  tables.set("post", pack("LLhhLLLLL", 0x30000, 0, -upem / 10, upem / 20, 0, 0, 0, 0, 0));
  const bmp = Math.min(n, 0x1900);
  const format4 = pack(
    "HHHHHHHHHHHHHHHH",
    4,
    32,
    0,
    4,
    4,
    1,
    0,
    0xe000 + bmp - 1,
    0xffff,
    0,
    0xe000,
    0xffff,
    0x2000,
    1,
    0,
    0,
  );
  const format12 =
    n > bmp ? pack("HHLLLLLL", 12, 0, 28, 0, 1, 0xf0000 + bmp, 0xf0000 + n - 1, bmp) : null;
  tables.set(
    "cmap",
    format12
      ? concat([pack("HHHHLHHL", 0, 2, 3, 1, 20, 3, 10, 52), format4, format12])
      : concat([pack("HHHHL", 0, 1, 3, 1, 12), format4]),
  );
  // Table directory, 4-byte aligned tables with checksums.
  const tags = [...tables.keys()].sort();
  const selector = Math.floor(Math.log2(tags.length));
  const parts: Uint8Array[] = [
    pack(
      "LHHHH",
      cff ? 0x4f54544f : 0x10000,
      tags.length,
      16 * 2 ** selector,
      selector,
      tags.length * 16 - 16 * 2 ** selector,
    ),
  ];
  let offset = 12 + tags.length * 16;
  const body: Uint8Array[] = [];
  for (const tag of tags) {
    const table = tables.get(tag)!;
    let sum = 0;
    for (let i = 0; i < table.length; i += 4)
      sum =
        (sum +
          ((table[i]! << 24) |
            ((table[i + 1] ?? 0) << 16) |
            ((table[i + 2] ?? 0) << 8) |
            (table[i + 3] ?? 0))) >>>
        0;
    parts.push(
      Uint8Array.from(tag, (c) => c.charCodeAt(0)),
      pack("LLL", sum, offset, table.length),
    );
    const padded = (table.length + 3) & ~3;
    body.push(table, new Uint8Array(padded - table.length));
    offset += padded;
  }
  return concat([...parts, ...body]);
}

/** CFF operand bytes: small integers compactly, others as int16 or 16.16 fixed. */
function cffNumber(v: number, out: number[]) {
  if (Number.isInteger(v) && v >= -107 && v <= 107) out.push(v + 139);
  else if (Number.isInteger(v) && v >= 108 && v <= 1131)
    out.push(((v - 108) >> 8) + 247, (v - 108) & 255);
  else if (Number.isInteger(v) && v >= -1131 && v <= -108)
    out.push(((-v - 108) >> 8) + 251, (-v - 108) & 255);
  else if (Number.isInteger(v) && v >= -32768 && v <= 32767) out.push(28, (v >> 8) & 255, v & 255);
  else {
    const f = Math.round(v * 65536) | 0;
    out.push(255, (f >>> 24) & 255, (f >> 16) & 255, (f >> 8) & 255, f & 255);
  }
}
const cffIndexBytes = (items: Uint8Array[]) => {
  if (!items.length) return Uint8Array.of(0, 0);
  const offsets: number[] = [1];
  for (const item of items) offsets.push(offsets.at(-1)! + item.length);
  return concat([
    pack("HB", items.length, 4),
    pack("L".repeat(offsets.length), ...offsets),
    ...items,
  ]);
};

/** eexec and charstring decryption. */
function decrypt(data: Uint8Array, key: number, skip: number) {
  const out = new Uint8Array(Math.max(0, data.length - skip));
  for (let i = 0, r = key; i < data.length; i++) {
    const c = data[i]!;
    if (i >= skip) out[i - skip] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

/**
 * A Type 1 program (FontFile) recompiled as a bare CFF: eexec-decrypted charstrings become Type 2 outlines with
 * subroutines, flex and seac accents inlined and hints dropped, so Type 1 fonts load through the same path as CFF.
 */
function type1ToCff(data: Uint8Array): { cff: Uint8Array; info: CffInfo } | null {
  const text = latin1.decode(data);
  const eexec = text.indexOf("eexec");
  if (eexec < 0) return null;
  let start = eexec + 5;
  while (
    start < data.length &&
    (data[start] === 13 || data[start] === 10 || data[start] === 32 || data[start] === 9)
  )
    start++;
  let encrypted = data.subarray(start);
  if (/^[0-9a-fA-F]{4}/.test(text.slice(start, start + 4)))
    encrypted = hexBytes(text.slice(start).replace(/[^0-9a-fA-F\s][\s\S]*$/, ""));
  const clear = text.slice(0, eexec);
  const priv = decrypt(encrypted, 55665, 4);
  const body = latin1.decode(priv);
  const lenIV = Number(/\/lenIV\s+(-?\d+)/.exec(body)?.[1] ?? 4);
  const charstring = (at: number, length: number) =>
    lenIV < 0
      ? priv.subarray(at, at + length)
      : decrypt(priv.subarray(at, at + length), 4330, lenIV);
  const subrs: Uint8Array[] = [];
  const charsAt = body.indexOf("/CharStrings");
  if (charsAt < 0) return null;
  const subrsAt = body.indexOf("/Subrs");
  if (subrsAt >= 0 && subrsAt < charsAt) {
    const pattern = /dup\s+(\d+)\s+(\d+)\s+\S+\s/g;
    pattern.lastIndex = subrsAt;
    for (let m = pattern.exec(body); m && m.index < charsAt; m = pattern.exec(body)) {
      const at = m.index + m[0].length;
      subrs[Number(m[1])] = charstring(at, Number(m[2]));
      pattern.lastIndex = at + Number(m[2]);
    }
  }
  const glyphs = new Map<string, Uint8Array>();
  const pattern = /\/([^\s/[\]{}()<>]+)\s+(\d+)\s+\S+\s/g;
  pattern.lastIndex = charsAt + 12;
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const at = m.index + m[0].length;
    glyphs.set(m[1]!, charstring(at, Number(m[2])));
    pattern.lastIndex = at + Number(m[2]);
  }
  if (!glyphs.size) return null;
  const standard = encodingTable("StandardEncoding");
  const standardName = (code: number) =>
    standard[code] ? CFF_NAMES[CFF_CHARS.indexOf(standard[code]!) + 1] : undefined;

  const convert = (name: string): Uint8Array => {
    const out: number[] = [];
    let width: number | undefined;
    let emitted = false;
    let [x, y, ox, oy] = [0, 0, 0, 0];
    let flex: [number, number][] | null = null;
    let results: number[] = [];
    const op = (code: number, ...args: number[]) => {
      if (!emitted) {
        cffNumber(width ?? 0, out);
        emitted = true;
        if (code !== 21 && code !== 14) {
          out.push(139, 139, 21);
        }
      }
      for (const arg of args) cffNumber(Math.round(arg * 64) / 64, out);
      out.push(code);
    };
    const to = (code: number, ...points: [number, number][]) => {
      const args: number[] = [];
      for (const [px, py] of points) {
        args.push(px - ox, py - oy);
        [ox, oy] = [px, py];
      }
      op(code, ...args);
    };
    const run = (
      cs: Uint8Array,
      dx: number,
      dy: number,
      depth: number,
      stack: number[],
    ): boolean => {
      if (depth > 16) return false;
      for (let i = 0; i < cs.length;) {
        const v = cs[i++]!;
        if (v >= 32) {
          if (v <= 246) stack.push(v - 139);
          else if (v <= 250) stack.push((v - 247) * 256 + cs[i++]! + 108);
          else if (v <= 254) stack.push(-(v - 251) * 256 - cs[i++]! - 108);
          else {
            stack.push((cs[i]! << 24) | (cs[i + 1]! << 16) | (cs[i + 2]! << 8) | cs[i + 3]! | 0);
            i += 4;
          }
          continue;
        }
        const s = stack;
        const code = v === 12 ? 1200 + cs[i++]! : v;
        switch (code) {
          case 13: // hsbw
            [x, y] = [dx + (s[0] ?? 0), dy];
            if (width === undefined) width = s[1] ?? 0;
            break;
          case 1207: // sbw
            [x, y] = [dx + (s[0] ?? 0), dy + (s[1] ?? 0)];
            if (width === undefined) width = s[2] ?? 0;
            break;
          case 21:
          case 22:
          case 4: {
            const [mx, my] =
              code === 21 ? [s[0] ?? 0, s[1] ?? 0] : code === 22 ? [s[0] ?? 0, 0] : [0, s[0] ?? 0];
            [x, y] = [x + mx, y + my];
            if (flex) flex.push([x, y]);
            else to(21, [x, y]);
            break;
          }
          case 5:
            to(5, [(x += s[0] ?? 0), (y += s[1] ?? 0)]);
            break;
          case 6:
            to(5, [(x += s[0] ?? 0), y]);
            break;
          case 7:
            to(5, [x, (y += s[0] ?? 0)]);
            break;
          case 8:
          case 30:
          case 31: {
            const d =
              code === 8
                ? s
                : code === 30
                  ? [0, s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0, 0]
                  : [s[0] ?? 0, 0, s[1] ?? 0, s[2] ?? 0, 0, s[3] ?? 0];
            const p1: [number, number] = [(x += d[0] ?? 0), (y += d[1] ?? 0)];
            const p2: [number, number] = [(x += d[2] ?? 0), (y += d[3] ?? 0)];
            to(8, p1, p2, [(x += d[4] ?? 0), (y += d[5] ?? 0)]);
            break;
          }
          case 10: {
            // callsubr
            const subr = subrs[s.pop() ?? -1];
            if (subr && run(subr, dx, dy, depth + 1, s)) return true;
            continue;
          }
          case 11: // return
            return false;
          case 14: // endchar
            return true;
          case 1206: {
            // seac: base glyph then accent, both inlined
            const [asb = 0, adx = 0, ady = 0, base = 0, accent = 0] = s;
            const sbx = x - dx;
            const baseCs = glyphs.get(standardName(base) ?? "");
            const accentCs = glyphs.get(standardName(accent) ?? "");
            if (baseCs) run(baseCs, 0, 0, depth + 1, []);
            if (accentCs) run(accentCs, adx + sbx - asb, ady, depth + 1, []);
            return true;
          }
          case 1212: {
            // div
            const b = s.pop() ?? 1;
            s.push((s.pop() ?? 0) / (b || 1));
            continue;
          }
          case 1216: {
            // callothersubr
            const other = s.pop() ?? 0;
            const count = s.pop() ?? 0;
            const args = s.splice(Math.max(0, s.length - count), count);
            if (other === 1) flex = [];
            else if (other === 0 && flex) {
              const p = flex;
              flex = null;
              if (p.length >= 7) {
                to(8, p[1]!, p[2]!, p[3]!);
                to(8, p[4]!, p[5]!, p[6]!);
                [x, y] = p[6]!;
              }
              results = [args[2] ?? y, args[1] ?? x];
            } else if (other !== 2) results = [...args].reverse();
            continue;
          }
          case 1217: // pop
            s.push(results.pop() ?? 0);
            continue;
          case 1233: // setcurrentpoint
            [x, y] = [s[0] ?? x, s[1] ?? y];
            break;
        }
        s.length = 0;
      }
      return false;
    };
    run(glyphs.get(name)!, 0, 0, 0, []);
    op(14);
    return Uint8Array.from(out);
  };

  const names = [".notdef", ...[...glyphs.keys()].filter((n) => n !== ".notdef")];
  const custom: string[] = [];
  const sid = (name: string) => {
    const standardSid = CFF_NAMES.indexOf(name);
    if (standardSid >= 0) return standardSid;
    custom.push(name);
    return 390 + custom.length;
  };
  const charset = names.slice(1).map(sid);
  const charstrings = names.map((n) => (glyphs.has(n) ? convert(n) : Uint8Array.of(139, 14)));
  const matrix = /\/FontMatrix\s*\[([^\]]*)\]/
    .exec(clear)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number) ?? [0.001, 0, 0, 0.001, 0, 0];
  const bbox = /\/FontBBox\s*[[{]([^\]}]*)[\]}]/
    .exec(clear)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number) ?? [0, -200, 1000, 800];
  const encoding = new Map<number, number>();
  const gids = new Map(names.map((n, gid) => [n, gid]));
  if (/\/Encoding\s+StandardEncoding/.test(clear))
    for (let code = 0; code < 256; code++) {
      const gid = gids.get(standardName(code) ?? "");
      if (gid) encoding.set(code, gid);
    }
  for (const m of clear.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g)) {
    const gid = gids.get(m[2]!);
    if (gid) encoding.set(Number(m[1]), gid);
  }
  // Top DICT with fixed-width offsets, so its size is known before layout.
  const int32 = (v: number) => [29, (v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const head = Uint8Array.of(1, 0, 4, 4);
  const nameIndex = cffIndexBytes([Uint8Array.from("PdfType1", (c) => c.charCodeAt(0))]);
  const stringIndex = cffIndexBytes(custom.map((n) => Uint8Array.from(n, (c) => c.charCodeAt(0))));
  const globalSubrs = cffIndexBytes([]);
  const charsetBytes = concat([Uint8Array.of(0), pack("H".repeat(charset.length), ...charset)]);
  const charstringIndex = cffIndexBytes(charstrings);
  const privateDict = Uint8Array.of(139, 21);
  const bboxBytes: number[] = [];
  for (const v of bbox.slice(0, 4)) cffNumber(Math.round(v || 0), bboxBytes);
  const topDict = (charsetAt: number, charstringsAt: number, privateAt: number) =>
    Uint8Array.from([
      ...bboxBytes,
      5,
      ...int32(charsetAt),
      15,
      ...int32(charstringsAt),
      17,
      ...int32(privateDict.length),
      ...int32(privateAt),
      18,
    ]);
  const charsetAt =
    head.length +
    nameIndex.length +
    cffIndexBytes([topDict(0, 0, 0)]).length +
    stringIndex.length +
    globalSubrs.length;
  const top = topDict(
    charsetAt,
    charsetAt + charsetBytes.length,
    charsetAt + charsetBytes.length + charstringIndex.length,
  );
  const cff = concat([
    head,
    nameIndex,
    cffIndexBytes([top]),
    stringIndex,
    globalSubrs,
    charsetBytes,
    charstringIndex,
    privateDict,
  ]);
  return {
    cff,
    info: {
      glyphs: names.length,
      cid: false,
      charset: [0, ...charset],
      names,
      encoding,
      matrix,
      bbox,
    },
  };
}

function cffTables(cff: Uint8Array, info: CffInfo) {
  const upem = info.matrix[0] && info.matrix[0] > 0 ? Math.round(1 / info.matrix[0]) : 1000;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = info.bbox;
  return new Map([
    ["CFF ", cff],
    [
      "head",
      pack(
        "LLLLHHLLLLhhhhHHhhh",
        0x10000,
        0x10000,
        0,
        0x5f0f3cf5,
        3,
        upem,
        0,
        0,
        0,
        0,
        x0,
        y0,
        x1,
        y1,
        0,
        8,
        2,
        0,
        0,
      ),
    ],
    [
      "hhea",
      pack(
        "LhhhHhhhhhhhhhhhH",
        0x10000,
        y1 || upem * 0.8,
        y0 || -upem * 0.2,
        0,
        upem,
        0,
        0,
        upem,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
      ),
    ],
  ]);
}

type Glyph = {
  code: number;
  text: string;
  width: number;
  space: boolean;
  gid: number;
  name?: string | undefined;
};
type Font = {
  decode: (bytes: Uint8Array) => Glyph[];
  /** CSS for the system font standing in when a glyph can't draw from the embedded program. */
  family: string;
  weight: string;
  style: string;
  /** The rebuilt embedded font's CSS family, once `load` has settled; null when it could not load. */
  face?: string | null | undefined;
  load: () => Promise<void>;
  measure: Map<string, number>;
  type3?:
    | {
        procs: PdfDict;
        matrix: Matrix;
        resources: PdfDict | undefined;
        content: Map<string, Promise<Uint8Array>>;
      }
    | undefined;
};
const FALLBACK_FONT: Font = {
  decode: (b) =>
    Array.from(b, (c) => ({
      code: c,
      text: String.fromCharCode(c),
      width: 0.5,
      space: c === 32,
      gid: -1,
    })),
  family: "sans-serif",
  weight: "400",
  style: "normal",
  load: async () => {},
  measure: new Map(),
};

let measurer: OffscreenCanvasRenderingContext2D | null | undefined;
const measureContext = () =>
  (measurer ??=
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d"));

/** Local font families for a PDF font name, ahead of a metric-compatible generic stack. */
function systemFamily(base: string, flags: number) {
  const stem = base
    .split(/[-,+]/)[0]!
    .replace(/(PS)?MT$|PS$/, "")
    .replace(/[^A-Za-z0-9 ]/g, "");
  const spaced = stem.replace(/([a-z])([A-Z])/g, "$1 $2");
  const generic =
    /courier|mono|consol/i.test(base) || flags & 1
      ? "'Courier New', Courier, 'Liberation Mono', monospace"
      : (/times|serif|roman|georgia|garamond|cambria|minion|palatino|book/i.test(base) ||
            flags & 2) &&
          !/sans|arial|helvet|gothic/i.test(base)
        ? "'Times New Roman', Times, 'Liberation Serif', serif"
        : "Helvetica, Arial, 'Liberation Sans', sans-serif";
  return [
    ...new Set([stem, spaced].filter((s) => s.length > 1).map((s) => `"${s}"`)),
    generic,
  ].join(", ");
}

/** Malformed font programs fall back to system fonts instead of failing the page. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function loadFont(doc: PdfDocument, dict: PdfDict): Promise<Font> {
  const subtype = nameOf(dict.get("Subtype"));
  const base = (nameOf(doc.get(dict.get("BaseFont"))) ?? "").replace(/^[A-Z]{6}\+/, "");
  const cidFont =
    subtype === "Type0" ? doc.dict(doc.array(dict.get("DescendantFonts"))[0]) : undefined;
  const descriptor = doc.dict((cidFont ?? dict).get("FontDescriptor"));
  const flags = num(doc.get(descriptor?.get("Flags")));
  const family = systemFamily(base, flags);
  const weight =
    /bold|black|heavy|semibold|demi/i.test(base) ||
    num(doc.get(descriptor?.get("FontWeight"))) >= 600
      ? "700"
      : "400";
  const style = /italic|oblique/i.test(base) || flags & 64 ? "italic" : "normal";
  const toUnicode = doc.get(dict.get("ToUnicode"));
  const cmap = isStream(toUnicode)
    ? parseCMap(await doc.decode(toUnicode).catch(() => new Uint8Array()))
    : null;
  const measure = new Map<string, number>();

  // The embedded program: sfnt tables (TrueType or OpenType) or a bare CFF.
  const file = (["FontFile2", "FontFile3", "FontFile"] as const)
    .map((key) => doc.get(descriptor?.get(key)))
    .find(isStream);
  const data = file ? await doc.decode(file).catch(() => null) : null;
  const sfnt =
    data &&
    data.length > 12 &&
    [0x00010000, 0x74727565, 0x4f54544f, 0x74746366].includes(u32(data, 0))
      ? sfntTables(data)
      : null;
  const bareCff =
    data && !sfnt && file !== doc.get(descriptor?.get("FontFile")) && data[0] === 1 ? data : null;
  const type1 =
    data && !sfnt && !bareCff && file === doc.get(descriptor?.get("FontFile"))
      ? attempt(() => type1ToCff(data))
      : null;
  const cffData = sfnt?.get("CFF ") ?? bareCff ?? type1?.cff;
  const cff = type1?.info ?? (cffData ? attempt(() => parseCff(cffData)) : null);
  const cmaps = sfntCmaps(sfnt?.get("cmap"));
  const glyphCount = cff?.glyphs ?? (sfnt?.get("maxp") ? u16(sfnt.get("maxp")!, 4) : 0);
  const program = sfnt ?? (cffData && cff ? cffTables(cffData, cff) : null);

  let face: Promise<void> | undefined;
  const font: Font = {
    decode: FALLBACK_FONT.decode,
    family,
    weight,
    style,
    measure,
    load: () =>
      (face ??= (async () => {
        font.face = null;
        const set = fontSet();
        if (!program || !set || typeof FontFace === "undefined") return;
        const bytes = attempt(() => buildFont(program, glyphCount));
        if (!bytes) return;
        const name = `pdf-font-${++faces}`;
        const loaded = new FontFace(name, bytes as Uint8Array<ArrayBuffer>);
        // A program the browser's sanitizer rejects falls back to system fonts.
        if (
          !(await loaded.load().then(
            () => true,
            () => false,
          ))
        )
          return;
        set.add(loaded);
        doc.faces.push(loaded);
        font.face = name;
      })()),
  };

  if (subtype === "Type3") {
    const matrix = doc.numbers(dict.get("FontMatrix"));
    const fm = toMatrix(matrix.length === 6 ? matrix : [0.001, 0, 0, 0.001, 0, 0]);
    const names = differences(doc, doc.dict(dict.get("Encoding")));
    const table = simpleTable(
      doc,
      dict,
      descriptor,
      cmap,
      names,
      encodingTable(undefined),
      (code) => ({ gid: -1, name: names[code] }),
      fm[0],
    );
    font.decode = (bytes) => Array.from(bytes, (c) => table[c]!);
    font.type3 = {
      procs: doc.dict(dict.get("CharProcs")) ?? new Map(),
      matrix: fm,
      resources: doc.dict(dict.get("Resources")),
      content: new Map(),
    };
    font.load = async () => {};
    return font;
  }

  if (subtype === "Type0") {
    const encodingValue = doc.get(dict.get("Encoding"));
    const encodingName = nameOf(encodingValue) ?? "";
    const encoding = isStream(encodingValue)
      ? parseCMap(await doc.decode(encodingValue).catch(() => new Uint8Array()))
      : null;
    const space = encoding?.space.length
      ? encoding.space
      : cmap?.space.length && !encodingName.startsWith("Identity")
        ? cmap.space
        : IDENTITY_SPACE;
    const ucs2 = /^Uni.*-(UCS2|UTF16)-[HV]$/.test(encodingName);
    const cidOf = (code: number) => {
      if (!encoding) return code;
      const direct = encoding.cid.get(code);
      if (direct !== undefined) return direct;
      for (const [lo, hi, cid] of encoding.ranges)
        if (code >= lo && code <= hi) return cid + code - lo;
      return 0;
    };
    const widths = new Map<number, number>();
    const w = doc.array(cidFont?.get("W"));
    for (let i = 0; i < w.length;) {
      const first = num(w[i]);
      const next = w[i + 1];
      if (Array.isArray(next)) {
        next.forEach((value, k) => widths.set(first + k, num(doc.get(value))));
        i += 2;
      } else {
        for (let c = first; c <= num(next) && c - first < 65536; c++) widths.set(c, num(w[i + 2]));
        i += 3;
      }
    }
    const fallbackWidth = num(doc.get(cidFont?.get("DW")), 1000);
    const cidToGid = doc.get(cidFont?.get("CIDToGIDMap"));
    const gidMap = isStream(cidToGid) ? await doc.decode(cidToGid).catch(() => null) : null;
    const cidGids = cff?.cid ? new Map(cff.charset.map((cid, gid) => [cid, gid])) : null;
    const unicodeCmap =
      cmaps.get("3,1") ?? cmaps.get("3,10") ?? cmaps.get("0,3") ?? cmaps.get("0,4");
    let reverse: Map<number, string> | undefined;
    const gidOf = (cid: number, code: number) => {
      if (!program) return -1;
      if (cidGids) return cidGids.get(cid) ?? 0;
      if (ucs2 && unicodeCmap) return unicodeCmap.get(code) ?? 0;
      return gidMap ? u16(gidMap, cid * 2) : cid;
    };
    const textOf = (code: number, gid: number) => {
      const mapped = cmap?.uni.get(code);
      if (mapped !== undefined) return mapped;
      if (ucs2) return String.fromCharCode(code);
      if (!reverse && unicodeCmap) {
        reverse = new Map();
        for (const [u, g] of unicodeCmap)
          if (!reverse.has(g)) reverse.set(g, String.fromCodePoint(u));
      }
      return reverse?.get(gid) ?? "";
    };
    const glyphs = new Map<number, Glyph>();
    font.decode = (bytes) => {
      const out: Glyph[] = [];
      for (let i = 0; i < bytes.length;) {
        const [code, len] = readCode(bytes, i, space);
        i += len;
        const key = code * 8 + len;
        let glyph = glyphs.get(key);
        if (!glyph) {
          const cid = cidOf(code);
          const gid = gidOf(cid, code);
          glyphs.set(
            key,
            (glyph = {
              code,
              text: textOf(code, gid),
              width: (widths.get(cid) ?? fallbackWidth) / 1000,
              space: len === 1 && code === 32,
              gid,
            }),
          );
        }
        out.push(glyph);
      }
      return out;
    };
    return font;
  }

  // Simple fonts: one byte per code, resolved once into a 256-entry table.
  const encodingValue = doc.get(dict.get("Encoding"));
  const encodingDict = isDict(encodingValue) ? encodingValue : undefined;
  const baseName = nameOf(encodingValue) ?? nameOf(encodingDict?.get("BaseEncoding"));
  const names = differences(doc, encodingDict);
  const symbolic = (flags & 4) !== 0 && !(flags & 32);
  const builtin = cff && !cff.cid ? cff.encoding : null;
  const fallbackTable = encodingTable(
    baseName ?? (subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding"),
  );
  const table =
    baseName || !builtin
      ? fallbackTable
      : fallbackTable.map((t, code) =>
          builtin.has(code) ? glyphText(cff!.names[builtin.get(code)!] ?? "") || t : t,
        );
  const byName = cff ? new Map(cff.names.map((name, gid) => [name, gid])) : null;
  const byUnicode = cff ? new Map(cff.names.map((name, gid) => [glyphText(name), gid])) : null;
  const c31 = cmaps.get("3,1");
  const c30 = cmaps.get("3,0");
  const c10 = cmaps.get("1,0");
  const gidOf = (code: number): number => {
    if (!program) return -1;
    const name = names[code];
    const text = name ? glyphText(name) : table[code]!;
    if (cff) {
      if (cff.cid) return code;
      return (
        (name ? byName!.get(name) : undefined) ??
        (baseName ? byUnicode!.get(text) : undefined) ??
        builtin?.get(code) ??
        byUnicode!.get(text) ??
        0
      );
    }
    if (c31 && (!symbolic || name)) {
      const gid = c31.get(text.codePointAt(0) ?? -1);
      if (gid) return gid;
    }
    if (c30)
      for (const offset of [0, 0xf000, 0xf100, 0xf200])
        if (c30.get(offset + code)) return c30.get(offset + code)!;
    if (c10?.get(code)) return c10.get(code)!;
    if (c31?.get(code)) return c31.get(code)!;
    return cmaps.size ? 0 : code;
  };
  const glyphs = simpleTable(
    doc,
    dict,
    descriptor,
    cmap,
    names,
    table,
    (code) => ({ gid: gidOf(code) }),
    0.001,
    family,
    style,
    weight,
  );
  font.decode = (bytes) => Array.from(bytes, (c) => glyphs[c]!);
  return font;
}

/** /Differences glyph names by code. */
function differences(doc: PdfDocument, encoding: PdfDict | undefined) {
  const names: (string | undefined)[] = [];
  let code = 0;
  for (const item of doc.array(encoding?.get("Differences"))) {
    if (typeof item === "number") code = item;
    else if (item instanceof Name) names[code++ & 255] = item.value;
  }
  return names;
}

/** The 256 glyphs of a single-byte font: text from ToUnicode, then glyph names, then the base encoding; widths from /Widths. */
function simpleTable(
  doc: PdfDocument,
  dict: PdfDict,
  descriptor: PdfDict | undefined,
  cmap: CMap | null,
  names: (string | undefined)[],
  table: string[],
  glyph: (code: number) => { gid: number; name?: string | undefined },
  unit: number,
  family?: string,
  style?: string,
  weight?: string,
): Glyph[] {
  const firstChar = num(doc.get(dict.get("FirstChar")));
  const widths = doc.numbers(dict.get("Widths"));
  const missing = num(doc.get(descriptor?.get("MissingWidth")));
  const context = family && !widths.length ? measureContext() : null;
  if (context) context.font = `${style} ${weight} 100px ${family}`;
  return Array.from({ length: 256 }, (_, code) => {
    const name = names[code];
    const text = cmap?.uni.get(code) ?? (name ? glyphText(name) : table[code]!);
    const declared = widths[code - firstChar];
    const width =
      declared !== undefined
        ? declared * unit
        : missing
          ? missing * unit
          : context && text
            ? context.measureText(text).width / 100
            : code === 32
              ? 0.25
              : 0.5;
    return { code, text, width, space: code === 32, ...glyph(code) };
  });
}

type Paint = { rgb: number[]; pattern?: PdfValue | undefined };
type Mask = (ctx: Ctx) => Promise<void>;
type State = {
  ctm: Matrix;
  /** The content stream's own default space, which patterns are defined against. */
  base: Matrix;
  fillSpace: ColorSpace;
  strokeSpace: ColorSpace;
  fill: Paint;
  stroke: Paint;
  fillAlpha: number;
  strokeAlpha: number;
  blend: GlobalCompositeOperation;
  lineWidth: number;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[];
  phase: number;
  font: Font | undefined;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
  leading: number;
  rise: number;
  render: number;
  /** Soft masks and text clips: each paint goes through a layer these cut with destination-in. */
  masks: Mask[];
};
const BLEND: Record<string, GlobalCompositeOperation> = {
  Multiply: "multiply",
  Screen: "screen",
  Overlay: "overlay",
  Darken: "darken",
  Lighten: "lighten",
  ColorDodge: "color-dodge",
  ColorBurn: "color-burn",
  HardLight: "hard-light",
  SoftLight: "soft-light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
};
const INLINE_KEYS: Record<string, string> = {
  BPC: "BitsPerComponent",
  CS: "ColorSpace",
  D: "Decode",
  DP: "DecodeParms",
  F: "Filter",
  H: "Height",
  IM: "ImageMask",
  I: "Interpolate",
  W: "Width",
  L: "Length",
};
const css = (rgb: number[]) =>
  `rgb(${Math.round(rgb[0] ?? 0)},${Math.round(rgb[1] ?? 0)},${Math.round(rgb[2] ?? 0)})`;
const layer = (ctx: Ctx) => {
  const canvas = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
  return canvas.getContext("2d")!;
};
const LIGATURES = /[ﬀ-ﬆ]/g;

class Painter {
  private readonly doc: PdfDocument;
  private readonly output: { text?: (item: PdfTextItem) => void; signal?: AbortSignal | undefined };
  private readonly viewport: Matrix;
  private ctx: Ctx | undefined;
  /** PDF user space to device pixels, before the content's own transforms. */
  private device: Matrix;
  private readonly images = new Map<object, Map<string, Promise<ImageBitmap | null>>>();
  private readonly softMasks = new WeakSet<Mask>();
  constructor(
    doc: PdfDocument,
    page: PdfPage,
    output: Painter["output"],
    ctx: Ctx | undefined,
    device: Matrix,
  ) {
    this.doc = doc;
    this.output = output;
    this.viewport = doc.viewport(page);
    this.ctx = ctx;
    this.device = device;
  }

  initial(ctm: Matrix): State {
    return {
      ctm,
      base: ctm,
      fillSpace: GRAY,
      strokeSpace: GRAY,
      fill: { rgb: [0, 0, 0] },
      stroke: { rgb: [0, 0, 0] },
      fillAlpha: 1,
      strokeAlpha: 1,
      blend: "source-over",
      lineWidth: 1,
      cap: "butt",
      join: "miter",
      miter: 10,
      dash: [],
      phase: 0,
      font: undefined,
      fontSize: 0,
      charSpacing: 0,
      wordSpacing: 0,
      scale: 1,
      leading: 0,
      rise: 0,
      render: 0,
      masks: [],
    };
  }

  close() {
    for (const group of this.images.values())
      for (const image of group.values()) void image.then((bitmap) => bitmap?.close());
    this.images.clear();
  }

  private async withTarget<T>(ctx: Ctx, device: Matrix, fn: () => Promise<T>) {
    const saved = [this.ctx, this.device] as const;
    this.ctx = ctx;
    this.device = device;
    try {
      return await fn();
    } finally {
      [this.ctx, this.device] = saved;
    }
  }

  private transform(ctx: Ctx, m: Matrix) {
    ctx.setTransform(...multiply(m, this.device));
  }

  /** Runs a paint operation with the state's blend mode, through a masked layer when masks or a group alpha apply. */
  private async draw(state: State, fn: (ctx: Ctx) => void | Promise<void>, group?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!state.masks.length && group === undefined) {
      ctx.globalCompositeOperation = state.blend;
      await fn(ctx);
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    const target = layer(ctx);
    await fn(target);
    for (const mask of state.masks) await mask(target);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = group ?? 1;
    ctx.globalCompositeOperation = state.blend;
    ctx.drawImage(target.canvas, 0, 0);
    ctx.restore();
    target.canvas.width = 0;
  }

  private hiddenContent(value: PdfValue | undefined): boolean {
    const doc = this.doc;
    const oc = doc.dict(value);
    if (!oc) return false;
    if (nameOf(oc.get("Type")) !== "OCMD") return doc.hidden.has(oc);
    const groups = doc.get(oc.get("OCGs"));
    const on = (Array.isArray(groups) ? doc.array(groups) : [groups])
      .filter(isDict)
      .map((g) => !doc.hidden.has(g));
    if (!on.length) return false;
    const policy = nameOf(oc.get("P")) ?? "AnyOn";
    return policy === "AllOn"
      ? on.includes(false)
      : policy === "AnyOff"
        ? !on.includes(false)
        : policy === "AllOff"
          ? on.includes(true)
          : !on.includes(true);
  }

  async annotations(page: PdfPage) {
    const doc = this.doc;
    for (const annotation of doc.array(page.dict.get("Annots"))) {
      if (
        !isDict(annotation) ||
        num(doc.get(annotation.get("F"))) & 0b100010 ||
        nameOf(annotation.get("Subtype")) === "Popup" ||
        this.hiddenContent(annotation.get("OC"))
      )
        continue;
      let appearance = doc.get(doc.dict(annotation.get("AP"))?.get("N"));
      if (isDict(appearance))
        appearance = doc.get(appearance.get(nameOf(annotation.get("AS")) ?? ""));
      const rect = doc.numbers(annotation.get("Rect"));
      if (!isStream(appearance) || rect.length !== 4) continue;
      const bbox = doc.numbers(appearance.dict.get("BBox"));
      if (bbox.length !== 4) continue;
      const matrix = toMatrix(doc.numbers(appearance.dict.get("Matrix")));
      const corners = [
        apply(matrix, bbox[0]!, bbox[1]!),
        apply(matrix, bbox[2]!, bbox[1]!),
        apply(matrix, bbox[0]!, bbox[3]!),
        apply(matrix, bbox[2]!, bbox[3]!),
      ];
      const [bx0, by0, bx1, by1] = [
        Math.min(...corners.map((c) => c[0])),
        Math.min(...corners.map((c) => c[1])),
        Math.max(...corners.map((c) => c[0])),
        Math.max(...corners.map((c) => c[1])),
      ];
      const [rx0, ry0, rx1, ry1] = [
        Math.min(rect[0]!, rect[2]!),
        Math.min(rect[1]!, rect[3]!),
        Math.max(rect[0]!, rect[2]!),
        Math.max(rect[1]!, rect[3]!),
      ];
      const sx = (rx1 - rx0) / (bx1 - bx0 || 1);
      const sy = (ry1 - ry0) / (by1 - by0 || 1);
      await this.form(
        appearance,
        this.initial([sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy]),
        page.resources,
        1,
      );
    }
  }

  async form(xobject: PdfStream, state: State, resources: PdfDict, depth: number) {
    const doc = this.doc;
    const dict = xobject.dict;
    if (depth > 12 || this.hiddenContent(dict.get("OC"))) return;
    const ctm = multiply(toMatrix(doc.numbers(dict.get("Matrix"))), state.ctm);
    const inner = doc.dict(dict.get("Resources")) ?? resources;
    const content = await doc.decode(xobject).catch(() => null);
    if (!content) return;
    const bbox = doc.numbers(dict.get("BBox"));
    const group = doc.dict(dict.get("Group"));
    const isolate =
      !!this.ctx &&
      nameOf(group?.get("S")) === "Transparency" &&
      (state.fillAlpha < 1 || state.blend !== "source-over" || state.masks.length > 0);
    const paint = async () => {
      const ctx = this.ctx;
      ctx?.save();
      if (ctx && bbox.length === 4) {
        this.transform(ctx, ctm);
        const clip = new Path2D();
        clip.rect(bbox[0]!, bbox[1]!, bbox[2]! - bbox[0]!, bbox[3]! - bbox[1]!);
        ctx.clip(clip);
      }
      const reset = isolate
        ? { fillAlpha: 1, strokeAlpha: 1, blend: "source-over" as const, masks: [] }
        : {};
      await this.run(content, inner, { ...state, ctm, base: ctm, ...reset }, depth + 1);
      ctx?.restore();
    };
    if (isolate)
      await this.draw(
        state,
        (target) => this.withTarget(target, this.device, paint),
        state.fillAlpha,
      );
    else await paint();
  }

  private softMask(dict: PdfDict, ctm: Matrix, resources: PdfDict, depth: number): Mask {
    const doc = this.doc;
    let prepared: Promise<OffscreenCanvas | null> | undefined;
    const mask: Mask = async (ctx) => {
      const { width, height } = ctx.canvas;
      prepared ??= (async () => {
        const group = doc.get(dict.get("G"));
        if (!isStream(group)) return null;
        const target = layer(ctx);
        const luminosity = nameOf(dict.get("S")) !== "Alpha";
        if (luminosity) {
          const space = await doc.colorSpace(
            doc.dict(group.dict.get("Group"))?.get("CS"),
            resources,
          );
          const backdrop = doc.numbers(dict.get("BC"));
          target.fillStyle = css(backdrop.length ? space.rgb(backdrop) : [0, 0, 0]);
          target.fillRect(0, 0, width, height);
        }
        await this.withTarget(target, this.device, () =>
          this.form(group, this.initial(ctm), resources, depth + 1),
        );
        const transfer = await doc.function(dict.get("TR"));
        const lut = Uint8Array.from({ length: 256 }, (_, v) =>
          transfer ? clamp((transfer([v / 255])[0] ?? 0) * 255, 0, 255) : v,
        );
        const image = target.getImageData(0, 0, width, height);
        const d = image.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i + 3] =
            lut[
              luminosity ? Math.round(d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11) : d[i + 3]!
            ]!;
          d[i] = d[i + 1] = d[i + 2] = 0;
        }
        target.putImageData(image, 0, 0);
        return target.canvas;
      })();
      const canvas = await prepared;
      if (!canvas || canvas.width !== width || canvas.height !== height) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
    };
    this.softMasks.add(mask);
    return mask;
  }

  /** Paints a shading over the whole current clip; `matrix` maps shading space to user space. */
  private async shade(
    ctx: Ctx,
    value: PdfValue | undefined,
    matrix: Matrix,
    resources: PdfDict,
    background: boolean,
  ) {
    const doc = this.doc;
    const shading = doc.get(value);
    const dict = doc.dict(shading);
    if (!dict) return;
    const space = await doc.colorSpace(dict.get("ColorSpace"), resources);
    const fn = await doc.function(dict.get("Function"));
    const type = num(doc.get(dict.get("ShadingType")));
    const toDevice = multiply(matrix, this.device);
    const inverse = invert(toDevice);
    const { width, height } = ctx.canvas;
    const corners = [
      apply(inverse, 0, 0),
      apply(inverse, width, 0),
      apply(inverse, 0, height),
      apply(inverse, width, height),
    ];
    const [x0, y0, x1, y1] = [
      Math.min(...corners.map((c) => c[0])),
      Math.min(...corners.map((c) => c[1])),
      Math.max(...corners.map((c) => c[0])),
      Math.max(...corners.map((c) => c[1])),
    ];
    ctx.save();
    ctx.setTransform(...toDevice);
    const bbox = doc.numbers(dict.get("BBox"));
    if (bbox.length === 4) {
      const clip = new Path2D();
      clip.rect(bbox[0]!, bbox[1]!, bbox[2]! - bbox[0]!, bbox[3]! - bbox[1]!);
      ctx.clip(clip);
    }
    const color = (comps: number[]) => css(space.rgb(fn ? fn(comps) : comps));
    if (background && dict.has("Background")) {
      ctx.fillStyle = css(space.rgb(doc.numbers(dict.get("Background"))));
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (type === 2 || type === 3) {
      const c = doc.numbers(dict.get("Coords"));
      const [t0 = 0, t1 = 1] = doc.numbers(dict.get("Domain"));
      const extend = doc.array(dict.get("Extend"));
      const gradient =
        type === 2
          ? ctx.createLinearGradient(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0)
          : ctx.createRadialGradient(
              c[0] ?? 0,
              c[1] ?? 0,
              Math.max(0, c[2] ?? 0),
              c[3] ?? 0,
              c[4] ?? 0,
              Math.max(0, c[5] ?? 0),
            );
      // Equal-offset stops: the first pads before, the last after, so unextended ends paint nothing.
      if (extend[0] !== true) gradient.addColorStop(0, "rgba(0,0,0,0)");
      const stops =
        fn &&
        num(doc.get(doc.dict(dict.get("Function"))?.get("FunctionType"))) === 2 &&
        num(doc.get(doc.dict(dict.get("Function"))?.get("N")), 1) === 1
          ? 1
          : 64;
      for (let i = 0; i <= stops; i++)
        gradient.addColorStop(i / stops, color([t0 + ((t1 - t0) * i) / stops]));
      if (extend[1] !== true) gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else if (type === 1) {
      const [d0 = 0, d1 = 1, d2 = 0, d3 = 1] = doc.numbers(dict.get("Domain"));
      const size = 64;
      const image = new ImageData(size, size);
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++) {
          const rgb = space.rgb(
            fn
              ? fn([d0 + ((i + 0.5) / size) * (d1 - d0), d2 + ((j + 0.5) / size) * (d3 - d2)])
              : [0],
          );
          image.data.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], (j * size + i) * 4);
        }
      const bitmap = await createImageBitmap(image);
      ctx.setTransform(
        ...multiply(multiply(toMatrix(doc.numbers(dict.get("Matrix"))), matrix), this.device),
      );
      ctx.drawImage(bitmap, d0, d2, d1 - d0, d3 - d2);
      bitmap.close();
    } else if (type >= 4 && type <= 7 && isStream(shading)) {
      await this.mesh(ctx, shading, type, space, fn, toDevice);
    }
    ctx.restore();
  }

  /** Free-form, lattice, Coons and tensor meshes, rasterized as Gouraud triangles in device space. */
  private async mesh(
    ctx: Ctx,
    shading: PdfStream,
    type: number,
    space: ColorSpace,
    fn: Fn | null,
    toDevice: Matrix,
  ) {
    const doc = this.doc;
    const dict = shading.dict;
    const data = await doc.decode(shading);
    const bpc = num(doc.get(dict.get("BitsPerCoordinate")), 16);
    const bpcomp = num(doc.get(dict.get("BitsPerComponent")), 8);
    const bpf = num(doc.get(dict.get("BitsPerFlag")), 8);
    const decode = doc.numbers(dict.get("Decode"));
    const colors = fn ? 1 : space.n;
    let bit = 0;
    const read = (bits: number) => {
      let v = 0;
      for (let k = 0; k < bits; k++, bit++)
        v = v * 2 + (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
      return v;
    };
    const align = () => (bit = (bit + 7) & ~7);
    const more = (bits: number) => bit + bits <= data.length * 8;
    const scaled = (v: number, bits: number, i: number) =>
      (decode[2 * i] ?? 0) +
      (v * ((decode[2 * i + 1] ?? 1) - (decode[2 * i] ?? 0))) / (2 ** bits - 1);
    type Vertex = { x: number; y: number; c: number[] };
    const vertex = (): Vertex => {
      const [x, y] = apply(toDevice, scaled(read(bpc), bpc, 0), scaled(read(bpc), bpc, 1));
      return {
        x,
        y,
        c: Array.from({ length: colors }, (_, k) => scaled(read(bpcomp), bpcomp, 2 + k)),
      };
    };
    const triangles: [Vertex, Vertex, Vertex][] = [];
    if (type === 4) {
      let a: Vertex | undefined;
      let b: Vertex | undefined;
      let c: Vertex | undefined;
      const next = () => {
        const flag = read(bpf);
        const v = vertex();
        align();
        return [flag, v] as const;
      };
      while (more(bpf + 2 * bpc) && triangles.length < 200_000) {
        const [flag, v] = next();
        if (flag === 0 || !a || !b || !c) [a, b, c] = [v, next()[1], next()[1]];
        else [a, b, c] = flag === 1 ? [b, c, v] : [a, c, v];
        triangles.push([a, b, c]);
      }
    } else if (type === 5) {
      const perRow = num(doc.get(dict.get("VerticesPerRow")), 2);
      const rows: Vertex[][] = [];
      while (more(2 * bpc) && rows.length < 4096) {
        const row = Array.from({ length: perRow }, vertex);
        rows.push(row);
      }
      for (let r = 0; r + 1 < rows.length; r++)
        for (let i = 0; i + 1 < perRow; i++)
          triangles.push(
            [rows[r]![i]!, rows[r]![i + 1]!, rows[r + 1]![i]!],
            [rows[r]![i + 1]!, rows[r + 1]![i + 1]!, rows[r + 1]![i]!],
          );
    } else {
      // Patches: 12 (Coons) or 16 (tensor) points, sampled on a grid and split into triangles.
      let previous: { p: [number, number][]; c: number[][] } | undefined;
      const count = type === 6 ? 12 : 16;
      while (more(bpf + 2 * bpc) && triangles.length < 200_000) {
        const flag = read(bpf);
        const kept = flag && previous ? 4 : 0;
        const points: [number, number][] = [];
        for (let k = kept; k < count; k++)
          points.push([scaled(read(bpc), bpc, 0), scaled(read(bpc), bpc, 1)]);
        const cornerColors: number[][] = [];
        for (let k = flag ? 2 : 0; k < 4; k++)
          cornerColors.push(
            Array.from({ length: colors }, (_, i) => scaled(read(bpcomp), bpcomp, 2 + i)),
          );
        align();
        if (!more(0)) break;
        let p: [number, number][];
        let c: number[][];
        if (kept && previous) {
          // The shared edge comes from the previous patch's side named by the flag.
          const q = previous.p;
          const pc = previous.c;
          const edge = [
            [3, 4, 5, 6],
            [6, 7, 8, 9],
            [9, 10, 11, 0],
          ][flag - 1]!;
          const colorEdge = [
            [1, 2],
            [2, 3],
            [3, 0],
          ][flag - 1]!;
          p = [...edge.map((i) => q[i]!), ...points];
          c = [pc[colorEdge[0]!]!, pc[colorEdge[1]!]!, ...cornerColors];
        } else {
          p = points;
          c = cornerColors;
        }
        previous = { p, c };
        // Boundary in order: 0..11 around the patch; corners 0 (u0v0), 3 (u0v1), 6 (u1v1), 9 (u1v0).
        const at = (i: number) => p[i] ?? [0, 0];
        const bez = (
          a: [number, number],
          b: [number, number],
          cc: [number, number],
          d: [number, number],
          t: number,
        ): [number, number] => {
          const s = 1 - t;
          return [
            s * s * s * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * cc[0] + t * t * t * d[0],
            s * s * s * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * cc[1] + t * t * t * d[1],
          ];
        };
        const steps = 8;
        const grid: Vertex[][] = [];
        for (let i = 0; i <= steps; i++) {
          const u = i / steps;
          const row: Vertex[] = [];
          for (let j = 0; j <= steps; j++) {
            const v = j / steps;
            // Coons surface from its four boundary curves.
            const left = bez(at(0), at(1), at(2), at(3), v);
            const right = bez(at(9), at(8), at(7), at(6), v);
            const bottom = bez(at(0), at(11), at(10), at(9), u);
            const top = bez(at(3), at(4), at(5), at(6), u);
            const [c00, c01, c11, c10] = [at(0), at(3), at(6), at(9)];
            const x =
              (1 - u) * left[0] +
              u * right[0] +
              (1 - v) * bottom[0] +
              v * top[0] -
              ((1 - u) * (1 - v) * c00[0] +
                (1 - u) * v * c01[0] +
                u * v * c11[0] +
                u * (1 - v) * c10[0]);
            const y =
              (1 - u) * left[1] +
              u * right[1] +
              (1 - v) * bottom[1] +
              v * top[1] -
              ((1 - u) * (1 - v) * c00[1] +
                (1 - u) * v * c01[1] +
                u * v * c11[1] +
                u * (1 - v) * c10[1]);
            const [dx, dy] = apply(toDevice, x, y);
            const color = (c[0] ?? []).map(
              (_, k) =>
                (1 - u) * (1 - v) * (c[0]?.[k] ?? 0) +
                (1 - u) * v * (c[1]?.[k] ?? 0) +
                u * v * (c[2]?.[k] ?? 0) +
                u * (1 - v) * (c[3]?.[k] ?? 0),
            );
            row.push({ x: dx, y: dy, c: color });
          }
          grid.push(row);
        }
        for (let i = 0; i < steps; i++)
          for (let j = 0; j < steps; j++)
            triangles.push(
              [grid[i]![j]!, grid[i + 1]![j]!, grid[i]![j + 1]!],
              [grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!],
            );
      }
    }
    if (!triangles.length) return;
    const xs = triangles.flatMap((t) => t.map((v) => v.x));
    const ys = triangles.flatMap((t) => t.map((v) => v.y));
    const left = Math.max(0, Math.floor(Math.min(...xs)));
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const w = Math.min(ctx.canvas.width, Math.ceil(Math.max(...xs))) - left;
    const h = Math.min(ctx.canvas.height, Math.ceil(Math.max(...ys))) - top;
    if (w <= 0 || h <= 0) return;
    const image = new ImageData(w, h);
    const rgb = (comps: number[]) => space.rgb(fn ? fn(comps) : comps);
    for (const [a, b, c] of triangles) {
      const minX = Math.max(left, Math.floor(Math.min(a.x, b.x, c.x)));
      const maxX = Math.min(left + w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const minY = Math.max(top, Math.floor(Math.min(a.y, b.y, c.y)));
      const maxY = Math.min(top + h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (!area) continue;
      const [ca, cb, cc] = [rgb(a.c), rgb(b.c), rgb(c.c)];
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const wa = ((b.x - px) * (c.y - py) - (c.x - px) * (b.y - py)) / area;
          const wb = ((c.x - px) * (a.y - py) - (a.x - px) * (c.y - py)) / area;
          const wc = 1 - wa - wb;
          if (wa < -0.01 || wb < -0.01 || wc < -0.01) continue;
          const o = ((y - top) * w + (x - left)) * 4;
          for (let k = 0; k < 3; k++) image.data[o + k] = wa * ca[k]! + wb * cb[k]! + wc * cc[k]!;
          image.data[o + 3] = 255;
        }
    }
    const bitmap = await createImageBitmap(image);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, left, top);
    bitmap.close();
  }

  /** Fills the current clip with a pattern paint. */
  private async pattern(ctx: Ctx, paint: Paint, state: State, resources: PdfDict, depth: number) {
    const doc = this.doc;
    const pattern = doc.get(paint.pattern);
    const dict = doc.dict(pattern);
    if (!dict) return;
    const matrix = multiply(toMatrix(doc.numbers(dict.get("Matrix"))), state.base);
    if (num(doc.get(dict.get("PatternType"))) === 2)
      return this.shade(ctx, dict.get("Shading"), matrix, resources, true);
    if (!isStream(pattern) || depth > 8) return;
    const bbox = doc.numbers(dict.get("BBox"));
    if (bbox.length !== 4) return;
    const [bx0, by0] = [Math.min(bbox[0]!, bbox[2]!), Math.min(bbox[1]!, bbox[3]!)];
    const xstep = Math.abs(num(doc.get(dict.get("XStep")))) || Math.abs(bbox[2]! - bbox[0]!);
    const ystep = Math.abs(num(doc.get(dict.get("YStep")))) || Math.abs(bbox[3]! - bbox[1]!);
    const toDevice = multiply(matrix, this.device);
    const w = clamp(Math.ceil(xstep * Math.hypot(toDevice[0], toDevice[1])), 1, 2048);
    const h = clamp(Math.ceil(ystep * Math.hypot(toDevice[2], toDevice[3])), 1, 2048);
    const kx = w / xstep;
    const ky = h / ystep;
    const tile = new OffscreenCanvas(w, h).getContext("2d")!;
    const content = await doc.decode(pattern).catch(() => null);
    if (!content) return;
    const inner = this.initial(IDENTITY);
    if (num(doc.get(dict.get("PaintType"))) === 2) inner.fill = inner.stroke = { rgb: paint.rgb };
    await this.withTarget(tile, [kx, 0, 0, ky, -bx0 * kx, -by0 * ky], async () => {
      const clip = new Path2D();
      clip.rect(bbox[0]!, bbox[1]!, bbox[2]! - bbox[0]!, bbox[3]! - bbox[1]!);
      this.transform(tile, IDENTITY);
      tile.clip(clip);
      await this.run(content, doc.dict(dict.get("Resources")) ?? resources, inner, depth + 1);
    });
    const fill = ctx.createPattern(tile.canvas, "repeat");
    if (!fill) return;
    fill.setTransform(new DOMMatrix(multiply([1 / kx, 0, 0, 1 / ky, bx0, by0], toDevice)));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
    tile.canvas.width = 0;
  }

  async run(content: Uint8Array, resources: PdfDict, init: State, depth: number) {
    const doc = this.doc;
    let state = init;
    const stack: State[] = [];
    let saves = 0;
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let path: Path2D | null = null;
    let pendingClip: CanvasFillRule | null = null;
    let textClip: ((ctx: Ctx) => void)[] = [];
    const marked: boolean[] = [];
    let hidden = 0;
    const lexer = new Lexer(content);
    const operands: PdfValue[] = [];
    const resource = (kind: string, name: PdfValue | undefined) =>
      isDict(name) ? name : doc.dict(resources.get(kind))?.get(nameOf(name) ?? "");
    const paintOf = (space: ColorSpace, values: PdfValue[]): Paint => {
      const comps = values.filter((v): v is number => typeof v === "number");
      if (!space.pattern) return { rgb: space.rgb(comps.length ? comps : space.init) };
      const under = space.pattern.under;
      return {
        rgb: under && comps.length ? under.rgb(comps) : [128, 128, 128],
        pattern: resource("Pattern", values.at(-1)),
      };
    };
    const fillPath = (target: Path2D, rule: CanvasFillRule) =>
      this.draw(state, async (ctx) => {
        this.transform(ctx, state.ctm);
        ctx.globalAlpha = state.fillAlpha;
        if (state.fill.pattern) {
          ctx.save();
          ctx.clip(target, rule);
          await this.pattern(ctx, state.fill, state, resources, depth);
          ctx.restore();
        } else {
          ctx.fillStyle = css(state.fill.rgb);
          ctx.fill(target, rule);
        }
      });
    const strokePath = (target: Path2D) =>
      this.draw(state, (ctx) => {
        this.transform(ctx, state.ctm);
        ctx.globalAlpha = state.strokeAlpha;
        ctx.strokeStyle = css(state.stroke.rgb);
        // Hairlines and thin lines stay one device pixel wide at any zoom.
        ctx.lineWidth = Math.max(
          state.lineWidth,
          1 / (scaleOf(multiply(state.ctm, this.device)) || 1),
        );
        ctx.lineCap = state.cap;
        ctx.lineJoin = state.join;
        ctx.miterLimit = Math.max(1, state.miter);
        ctx.setLineDash(
          state.dash.some((d) => d > 0) && state.dash.every((d) => d >= 0) ? state.dash : [],
        );
        ctx.lineDashOffset = state.phase;
        ctx.stroke(target);
      });
    const paintImage = async (stream: PdfStream, key: object, subkey: string) => {
      const ctx = this.ctx;
      if (!ctx || hidden || this.hiddenContent(stream.dict.get("OC"))) return;
      const isMask = doc.get(stream.dict.get("ImageMask") ?? stream.dict.get("IM")) === true;
      const id = `${subkey}:${isMask ? state.fill.rgb.join() : ""}`;
      let group = this.images.get(key);
      if (!group) this.images.set(key, (group = new Map()));
      let image = group.get(id);
      if (!image)
        group.set(id, (image = this.image(stream, resources, state.fill.rgb).catch(() => null)));
      const bitmap = await image;
      if (!bitmap) return;
      const matrix = multiply([1, 0, 0, -1, 0, 1], state.ctm);
      // Upscaled images stay crisp unless they ask to /Interpolate, as in other renderers.
      const sharp =
        doc.get(stream.dict.get("Interpolate")) !== true &&
        scaleOf(multiply(matrix, this.device)) > Math.sqrt(bitmap.width * bitmap.height);
      await this.draw(state, (target) => {
        this.transform(target, matrix);
        target.globalAlpha = state.fillAlpha;
        target.imageSmoothingEnabled = !sharp;
        target.imageSmoothingQuality = "high";
        target.drawImage(bitmap, 0, 0, 1, 1);
        target.imageSmoothingEnabled = true;
      });
    };
    const showText = async (bytes: Uint8Array) => {
      const font = state.font;
      if (!font) return;
      const size = state.fontSize;
      const h = state.scale;
      const glyphs = font.decode(bytes);
      const xs: number[] = [];
      let x = 0;
      let text = "";
      for (const glyph of glyphs) {
        xs.push(x);
        text += glyph.text;
        x += glyph.width * size + state.charSpacing + (glyph.space ? state.wordSpacing : 0);
      }
      // Text space (y up, one unit per point of font size) to user space.
      const run = multiply([h, 0, 0, 1, 0, state.rise], multiply(tm, state.ctm));
      const ctx = this.ctx;
      if (text.trim() && depth < 20) {
        const toPage = multiply(run, this.viewport);
        const [sx, sy] = apply(toPage, 0, 0);
        const [ex, ey] = apply(toPage, x, 0);
        const [ux, uy] = apply(toPage, 0, size);
        this.output.text?.({
          str: text.replace(LIGATURES, (c) => c.normalize("NFKC")),
          hasEOL: false,
          x: sx,
          y: sy,
          width: Math.hypot(ex - sx, ey - sy),
          height: Math.hypot(ux - sx, uy - sy),
          angle: Math.atan2(ey - sy, ex - sx),
          font: font.family,
        });
      }
      const mode = state.render;
      if (ctx && !hidden && size && mode !== 3 && mode !== 7 && font.type3) {
        const type3 = font.type3;
        for (const [i, glyph] of glyphs.entries()) {
          const proc = doc.get(type3.procs.get(glyph.name ?? ""));
          if (!isStream(proc)) continue;
          let content = type3.content.get(glyph.name!);
          if (!content)
            type3.content.set(
              glyph.name!,
              (content = doc.decode(proc).catch(() => new Uint8Array())),
            );
          const ctm = multiply(multiply(type3.matrix, [size, 0, 0, size, xs[i]!, 0]), run);
          await this.run(
            await content,
            type3.resources ?? resources,
            { ...state, ctm, base: ctm, font: undefined },
            depth + 1,
          );
        }
      } else if (ctx && size && mode !== 3 && (!hidden || mode >= 4)) {
        const device = multiply(multiply([1, 0, 0, -1, 0, 0], run), this.device);
        // Fold the transform's scale into the font size so glyphs rasterize at device resolution.
        const k = scaleOf(device) || 1;
        const flip = size < 0 ? -1 : 1;
        const [a, b, c, d, e, f] = [
          (device[0] / k) * flip,
          (device[1] / k) * flip,
          (device[2] / k) * flip,
          (device[3] / k) * flip,
          device[4],
          device[5],
        ];
        const px = Math.abs(size) * k;
        const face = font.face;
        const fontCss = face
          ? `${px}px "${face}"`
          : `${font.style} ${font.weight} ${px}px ${font.family}`;
        const paintGlyphs = (target: Ctx, fill: boolean, stroke: boolean) => {
          target.font = fontCss;
          for (const [i, glyph] of glyphs.entries()) {
            const char =
              face && glyph.gid >= 0
                ? glyph.gid
                  ? pua(glyph.gid)
                  : ""
                : glyph.text.trim() && glyph.text;
            if (!char) continue;
            let sx = 1;
            if (!face || glyph.gid < 0) {
              // A system font glyph stretches to the PDF's advance so layout holds.
              let width = font.measure.get(char);
              if (width === undefined)
                font.measure.set(char, (width = target.measureText(char).width / px));
              if (width > 0 && glyph.width > 0) sx = clamp(glyph.width / width, 0.5, 2);
            }
            const u = k * xs[i]! * flip;
            target.setTransform(a * sx, b * sx, c, d, e + a * u, f + b * u);
            if (fill) target.fillText(char, 0, 0);
            if (stroke) target.strokeText(char, 0, 0);
          }
        };
        if (!hidden && mode !== 7) {
          const fill = mode === 0 || mode === 2 || mode === 4 || mode === 6;
          const stroke = mode === 1 || mode === 2 || mode === 5 || mode === 6;
          await this.draw(state, (target) => {
            target.globalAlpha = stroke && !fill ? state.strokeAlpha : state.fillAlpha;
            target.fillStyle = css(state.fill.rgb);
            target.strokeStyle = css(state.stroke.rgb);
            target.lineWidth = Math.max(
              1,
              state.lineWidth * scaleOf(multiply(state.ctm, this.device)),
            );
            paintGlyphs(target, fill, stroke);
          });
        }
        if (mode >= 4) textClip.push((target) => paintGlyphs(target, true, false));
      }
      tm = multiply([1, 0, 0, 1, x * h, 0], tm);
    };
    for (let token = lexer.read(); token !== undefined; token = lexer.read()) {
      if (!(token instanceof Op)) {
        operands.push(token);
        continue;
      }
      if (this.output.signal?.aborted) break;
      const op = token.value;
      const a = operands;
      const n = (i: number) => num(a[i]);
      const ctx = this.ctx;
      try {
        switch (op) {
          case "q":
            stack.push({ ...state });
            ctx?.save();
            saves++;
            break;
          case "Q":
            if (stack.length) {
              state = stack.pop()!;
              ctx?.restore();
              saves--;
            }
            break;
          case "cm":
            state.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], state.ctm);
            break;
          case "w":
            state.lineWidth = n(0);
            break;
          case "J":
            state.cap = (["butt", "round", "square"] as const)[n(0)] ?? "butt";
            break;
          case "j":
            state.join = (["miter", "round", "bevel"] as const)[n(0)] ?? "miter";
            break;
          case "M":
            state.miter = n(0);
            break;
          case "d":
            state.dash = doc.numbers(a[0]);
            state.phase = n(1);
            break;
          case "gs": {
            const gs = doc.dict(resource("ExtGState", a[0]));
            if (!gs) break;
            for (const [key, raw] of gs) {
              const value = doc.get(raw);
              if (key === "ca") state.fillAlpha = num(value, 1);
              else if (key === "CA") state.strokeAlpha = num(value, 1);
              else if (key === "LW") state.lineWidth = num(value, 1);
              else if (key === "LC")
                state.cap = (["butt", "round", "square"] as const)[num(value)] ?? "butt";
              else if (key === "LJ")
                state.join = (["miter", "round", "bevel"] as const)[num(value)] ?? "miter";
              else if (key === "ML") state.miter = num(value, 10);
              else if (key === "D" && Array.isArray(value)) {
                state.dash = doc.numbers(value[0]);
                state.phase = num(doc.get(value[1]));
              } else if (key === "BM")
                state.blend =
                  BLEND[nameOf(Array.isArray(value) ? doc.get(value[0]) : value) ?? ""] ??
                  "source-over";
              else if (key === "Font" && Array.isArray(value)) {
                state.font = await doc.font(doc.dict(value[0]));
                state.fontSize = num(doc.get(value[1]));
                if (ctx) await state.font.load();
              } else if (key === "SMask") {
                const masks = state.masks.filter((m) => !this.softMasks.has(m));
                state.masks = isDict(value)
                  ? [...masks, this.softMask(value, state.ctm, resources, depth)]
                  : masks;
              }
            }
            break;
          }
          case "g":
          case "rg":
          case "k":
            state.fillSpace = op === "g" ? GRAY : op === "rg" ? RGB : CMYK;
            state.fill = paintOf(state.fillSpace, a);
            break;
          case "G":
          case "RG":
          case "K":
            state.strokeSpace = op === "G" ? GRAY : op === "RG" ? RGB : CMYK;
            state.stroke = paintOf(state.strokeSpace, a);
            break;
          case "cs":
            state.fillSpace = await doc.colorSpace(a[0], resources);
            state.fill = paintOf(state.fillSpace, []);
            break;
          case "CS":
            state.strokeSpace = await doc.colorSpace(a[0], resources);
            state.stroke = paintOf(state.strokeSpace, []);
            break;
          case "sc":
          case "scn":
            state.fill = paintOf(state.fillSpace, a);
            break;
          case "SC":
          case "SCN":
            state.stroke = paintOf(state.strokeSpace, a);
            break;
          case "m":
            (path ??= new Path2D()).moveTo(n(0), n(1));
            break;
          case "l":
            path?.lineTo(n(0), n(1));
            break;
          case "c":
            path?.bezierCurveTo(n(0), n(1), n(2), n(3), n(4), n(5));
            break;
          case "v":
            path?.bezierCurveTo(n(0), n(1), n(0), n(1), n(2), n(3));
            break;
          case "y":
            path?.bezierCurveTo(n(0), n(1), n(2), n(3), n(2), n(3));
            break;
          case "h":
            path?.closePath();
            break;
          case "re":
            (path ??= new Path2D()).rect(n(0), n(1), n(2), n(3));
            break;
          case "W":
          case "W*":
            pendingClip = op === "W" ? "nonzero" : "evenodd";
            break;
          case "S":
          case "s":
          case "f":
          case "F":
          case "f*":
          case "B":
          case "B*":
          case "b":
          case "b*":
          case "n": {
            if (ctx && path) {
              if (op === "s" || op === "b" || op === "b*") path.closePath();
              if (!hidden) {
                if (op !== "S" && op !== "s" && op !== "n")
                  await fillPath(path, op.includes("*") ? "evenodd" : "nonzero");
                if (op === "S" || op === "s" || op[0] === "B" || op[0] === "b")
                  await strokePath(path);
              }
              if (pendingClip) {
                this.transform(ctx, state.ctm);
                ctx.clip(path, pendingClip);
              }
            }
            path = null;
            pendingClip = null;
            break;
          }
          case "sh":
            if (ctx && !hidden) {
              const shading = resource("Shading", a[0]);
              await this.draw(state, (target) => {
                target.globalAlpha = state.fillAlpha;
                return this.shade(target, shading, state.ctm, resources, false);
              });
            }
            break;
          case "BT":
            tm = tlm = IDENTITY;
            textClip = [];
            break;
          case "ET":
            if (textClip.length) {
              const glyphs = textClip;
              let canvas: OffscreenCanvasRenderingContext2D | undefined;
              state.masks = [
                ...state.masks,
                async (target) => {
                  if (!canvas) {
                    canvas = layer(target);
                    for (const paint of glyphs) paint(canvas);
                  }
                  target.save();
                  target.setTransform(1, 0, 0, 1, 0, 0);
                  target.globalAlpha = 1;
                  target.globalCompositeOperation = "destination-in";
                  target.drawImage(canvas.canvas, 0, 0);
                  target.restore();
                },
              ];
            }
            textClip = [];
            break;
          case "Tf":
            state.font = await doc.font(doc.dict(resource("Font", a[0])));
            state.fontSize = n(1);
            if (ctx) await state.font.load();
            break;
          case "Tc":
            state.charSpacing = n(0);
            break;
          case "Tw":
            state.wordSpacing = n(0);
            break;
          case "Tz":
            state.scale = n(0) / 100;
            break;
          case "TL":
            state.leading = n(0);
            break;
          case "Ts":
            state.rise = n(0);
            break;
          case "Tr":
            state.render = n(0);
            break;
          case "Td":
            tm = tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
            break;
          case "TD":
            state.leading = -n(1);
            tm = tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
            break;
          case "Tm":
            tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
            break;
          case "T*":
            tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
            break;
          case "Tj":
            if (isBytes(a[0])) await showText(a[0]);
            break;
          case "'":
          case '"':
            if (op === '"') {
              state.wordSpacing = n(0);
              state.charSpacing = n(1);
            }
            tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
            if (isBytes(a.at(-1))) await showText(a.at(-1) as Uint8Array);
            break;
          case "TJ":
            for (const item of Array.isArray(a[0]) ? a[0] : []) {
              if (isBytes(item)) await showText(item);
              else if (typeof item === "number")
                tm = multiply([1, 0, 0, 1, (-item / 1000) * state.fontSize * state.scale, 0], tm);
            }
            break;
          case "Do": {
            const xobject = doc.get(resource("XObject", a[0]));
            if (!isStream(xobject)) break;
            const subtype = nameOf(xobject.dict.get("Subtype"));
            if (subtype === "Form") {
              if (!hidden) await this.form(xobject, state, resources, depth);
            } else if (subtype === "Image") await paintImage(xobject, xobject, "");
            break;
          }
          case "BI": {
            const dict: PdfDict = new Map();
            for (
              let key = lexer.read(false);
              key !== undefined && !(key instanceof Op);
              key = lexer.read(false)
            ) {
              const value = lexer.read(false);
              if (key instanceof Name) dict.set(INLINE_KEYS[key.value] ?? key.value, value ?? null);
            }
            const start = lexer.pos + (WHITE[content[lexer.pos]!] ? 1 : 0);
            let end = -1;
            if (!dict.get("Filter")) {
              const space =
                dict.get("ImageMask") === true
                  ? null
                  : await doc.colorSpace(dict.get("ColorSpace"), resources);
              const bits = num(dict.get("BitsPerComponent"), 1) * (space?.n ?? 1);
              end =
                start + Math.ceil((num(dict.get("Width")) * bits) / 8) * num(dict.get("Height"));
            }
            let scan = end < 0 ? start : end;
            for (; scan + 1 < content.length; scan++)
              if (
                content[scan] === 0x45 &&
                content[scan + 1] === 0x49 &&
                (scan === 0 || WHITE[content[scan - 1]!]) &&
                (scan + 2 >= content.length || WHITE[content[scan + 2]!])
              )
                break;
            if (end < 0) end = scan - 1;
            lexer.pos = Math.min(content.length, scan + 2);
            await paintImage(
              { dict, data: content.subarray(start, Math.max(start, end)) },
              content,
              String(start),
            );
            break;
          }
          case "BMC":
            marked.push(false);
            break;
          case "BDC": {
            const off =
              nameOf(a[0]) === "OC" &&
              this.hiddenContent(isDict(a[1]) ? a[1] : resource("Properties", a[1]));
            marked.push(off);
            if (off) hidden++;
            break;
          }
          case "EMC":
            if (marked.pop()) hidden--;
            break;
        }
      } catch {
        // A damaged operator leaves the rest of the page drawable.
      }
      operands.length = 0;
    }
    for (; saves > 0; saves--) this.ctx?.restore();
  }

  /** Decodes an image XObject or inline image to a bitmap with its soft mask, color key or stencil applied. */
  private async image(
    stream: PdfStream,
    resources: PdfDict,
    fill: number[],
  ): Promise<ImageBitmap | null> {
    const doc = this.doc;
    const dict = stream.dict;
    const filters = doc.get(dict.get("Filter"));
    const last = nameOf(Array.isArray(filters) ? doc.get(filters.at(-1)) : filters);
    const width = num(doc.get(dict.get("Width")));
    const height = num(doc.get(dict.get("Height")));
    if (!width || !height || width * height > 40_000_000) return null;
    const mask = doc.get(dict.get("ImageMask")) === true;
    const smask = doc.get(dict.get("SMask"));
    const explicit = doc.get(dict.get("Mask"));
    const decodeArray = doc.numbers(dict.get("Decode"));
    let rgba: Uint8ClampedArray<ArrayBuffer>;
    if (last === "DCTDecode" || last === "DCT" || last === "JPXDecode") {
      const data = await doc.decode(stream, true);
      const bitmap = await createImageBitmap(
        new Blob([data as Uint8Array<ArrayBuffer>], {
          type: last === "JPXDecode" ? "image/jp2" : "image/jpeg",
        }),
      ).catch(() => null);
      if (!bitmap || (!isStream(smask) && !isStream(explicit) && !mask)) return bitmap;
      rgba = pixels(bitmap, width, height);
      bitmap.close();
      if (mask)
        for (let i = 0; i < rgba.length; i += 4)
          rgba.set(
            [fill[0]!, fill[1]!, fill[2]!, rgba[i]! < 128 !== (decodeArray[0] === 1) ? 255 : 0],
            i,
          );
    } else if (last === "JBIG2Decode" || last === "CCITTFaxDecode") return null;
    else {
      const data = await doc.decode(stream);
      const bpc = mask ? 1 : num(doc.get(dict.get("BitsPerComponent")), 8);
      const space = mask ? GRAY : await doc.colorSpace(dict.get("ColorSpace"), resources);
      const n = space.n || 1;
      const rowBytes = Math.ceil((width * n * bpc) / 8);
      const max = 2 ** bpc - 1;
      const sample = (row: number, index: number) => {
        if (bpc === 8) return data[row * rowBytes + index] ?? 0;
        if (bpc === 16) return data[row * rowBytes + index * 2] ?? 0;
        const bit = index * bpc;
        return ((data[row * rowBytes + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
      };
      const levels = bpc === 16 ? 255 : max;
      const defaults = space.indexed ? [0, max] : (space.range ?? []);
      const ranges = Array.from(
        { length: n },
        (_, k) =>
          [
            decodeArray[2 * k] ?? defaults[2 * k] ?? 0,
            decodeArray[2 * k + 1] ?? defaults[2 * k + 1] ?? 1,
          ] as const,
      );
      rgba = new Uint8ClampedArray(width * height * 4);
      if (mask) {
        const paint = ranges[0]![0] === 1 ? 1 : 0;
        for (let y = 0, o = 0; y < height; y++)
          for (let x = 0; x < width; x++, o += 4)
            rgba.set([fill[0]!, fill[1]!, fill[2]!, sample(y, x) === paint ? 255 : 0], o);
      } else {
        const plain = ranges.every(([lo, hi]) => lo === 0 && hi === 1) && levels === 255;
        // One-component spaces and 8-bit color go through lookup tables; others through a per-color cache.
        const lut =
          n === 1
            ? Array.from({ length: levels + 1 }, (_, s) =>
                space.rgb([ranges[0]![0] + (s * (ranges[0]![1] - ranges[0]![0])) / levels]),
              )
            : null;
        const cache = new Map<number, number[]>();
        const comps = new Array<number>(n);
        for (let y = 0, o = 0; y < height; y++)
          for (let x = 0; x < width; x++, o += 4) {
            rgba[o + 3] = 255;
            if (lut) {
              const c = lut[sample(y, x)]!;
              rgba[o] = c[0]!;
              rgba[o + 1] = c[1]!;
              rgba[o + 2] = c[2]!;
            } else if (plain && space.device === "rgb") {
              rgba[o] = sample(y, x * 3);
              rgba[o + 1] = sample(y, x * 3 + 1);
              rgba[o + 2] = sample(y, x * 3 + 2);
            } else if (plain && space.device === "cmyk") {
              cmyk(
                sample(y, x * 4) / 255,
                sample(y, x * 4 + 1) / 255,
                sample(y, x * 4 + 2) / 255,
                sample(y, x * 4 + 3) / 255,
                rgba,
                o,
              );
            } else {
              let key = 0;
              for (let k = 0; k < n; k++) key = key * (levels + 1) + sample(y, x * n + k);
              let c = cache.get(key);
              if (!c) {
                for (let k = 0; k < n; k++)
                  comps[k] =
                    ranges[k]![0] +
                    (sample(y, x * n + k) * (ranges[k]![1] - ranges[k]![0])) / levels;
                c = space.rgb(comps);
                if (cache.size < 65536) cache.set(key, c);
              }
              rgba[o] = c[0]!;
              rgba[o + 1] = c[1]!;
              rgba[o + 2] = c[2]!;
            }
          }
        if (Array.isArray(explicit)) {
          // Color key masking: samples inside every [min max] pair are transparent.
          const keys = doc.numbers(explicit);
          for (let y = 0, o = 3; y < height; y++)
            for (let x = 0; x < width; x++, o += 4) {
              let inside = true;
              for (let k = 0; k < n && inside; k++) {
                const s = sample(y, x * n + k);
                inside = s >= (keys[2 * k] ?? 0) && s <= (keys[2 * k + 1] ?? max);
              }
              if (inside) rgba[o] = 0;
            }
        }
      }
    }
    const alphaSource = isStream(smask) ? smask : isStream(explicit) ? explicit : null;
    if (alphaSource) {
      const plane = await this.plane(alphaSource, alphaSource === explicit);
      if (plane) {
        const matte = alphaSource === smask ? doc.numbers(smask.dict.get("Matte")) : [];
        const matteRgb = matte.length
          ? (await doc.colorSpace(dict.get("ColorSpace"), resources)).rgb(matte)
          : null;
        for (let y = 0; y < height; y++) {
          const row =
            Math.min(plane.height - 1, Math.floor((y * plane.height) / height)) * plane.width;
          for (let x = 0; x < width; x++) {
            const alpha =
              plane.data[row + Math.min(plane.width - 1, Math.floor((x * plane.width) / width))]!;
            const o = (y * width + x) * 4;
            if (matteRgb && alpha)
              for (let k = 0; k < 3; k++)
                rgba[o + k] = matteRgb[k]! + ((rgba[o + k]! - matteRgb[k]!) * 255) / alpha;
            rgba[o + 3] = Math.min(rgba[o + 3]!, alpha);
          }
        }
      }
    }
    return createImageBitmap(new ImageData(rgba, width, height)).catch(() => null);
  }

  /** A soft mask or stencil mask image as one 0-255 alpha byte per pixel. */
  private async plane(stream: PdfStream, stencil: boolean) {
    const doc = this.doc;
    const dict = stream.dict;
    const width = num(doc.get(dict.get("Width")));
    const height = num(doc.get(dict.get("Height")));
    if (!width || !height || width * height > 40_000_000) return null;
    const filters = doc.get(dict.get("Filter"));
    const last = nameOf(Array.isArray(filters) ? doc.get(filters.at(-1)) : filters);
    const decodeArray = doc.numbers(dict.get("Decode"));
    const out = new Uint8Array(width * height);
    if (last === "DCTDecode" || last === "DCT" || last === "JPXDecode") {
      const data = await doc.decode(stream, true);
      const bitmap = await createImageBitmap(
        new Blob([data as Uint8Array<ArrayBuffer>], {
          type: last === "JPXDecode" ? "image/jp2" : "image/jpeg",
        }),
      ).catch(() => null);
      if (!bitmap) return null;
      const rgba = pixels(bitmap, width, height);
      bitmap.close();
      for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]!;
    } else {
      const data = await doc.decode(stream).catch(() => null);
      if (!data) return null;
      const bpc = stencil ? 1 : num(doc.get(dict.get("BitsPerComponent")), 8);
      const rowBytes = Math.ceil((width * bpc) / 8);
      const max = 2 ** bpc - 1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const bit = x * bpc;
          const s =
            bpc === 8
              ? (data[y * rowBytes + x] ?? 0)
              : bpc === 16
                ? (data[y * rowBytes + x * 2] ?? 0)
                : ((data[y * rowBytes + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & max;
          const level = bpc === 16 ? s / 255 : s / max;
          out[y * width + x] = stencil
            ? (s === 0) !== (decodeArray[0] === 1)
              ? 255
              : 0
            : 255 *
              ((decodeArray[0] ?? 0) + level * ((decodeArray[1] ?? 1) - (decodeArray[0] ?? 0)));
        }
    }
    return { data: out, width, height };
  }
}

function pixels(bitmap: ImageBitmap, width: number, height: number) {
  const context = new OffscreenCanvas(width, height).getContext("2d")!;
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}
