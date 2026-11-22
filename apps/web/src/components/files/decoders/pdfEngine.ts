// Zero-dependency PDF reader: objects, xref tables and streams, page tree, text extraction and a canvas painter.

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
export type PdfValue = number | boolean | null | Uint8Array | Name | Ref | PdfValue[] | PdfDict | PdfStream | Op;

const isStream = (value: PdfValue | undefined): value is PdfStream => typeof value === "object" && value !== null && "data" in value && "dict" in value;
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
    while (this.pos < this.bytes.length && !WHITE[this.bytes[this.pos]!] && !DELIM[this.bytes[this.pos]!]) this.pos++;
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
      return Name.of(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
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
          dict.set(key.value, this.read() ?? null);
        }
      }
      this.pos++;
      const start = this.pos;
      while (this.pos < b.length && b[this.pos] !== 0x3e) this.pos++;
      const hex = latin1.decode(b.subarray(start, this.pos++)).replace(/[^0-9a-fA-F]/g, "");
      const out = new Uint8Array(Math.ceil(hex.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.slice(i * 2, i * 2 + 2) + "0").slice(0, 2), 16);
      return out;
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
        const value = this.read();
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
        if (/^\d+$/.test(gen) && this.bytes[this.pos] === 0x52 && (this.pos + 1 >= b.length || WHITE[b[this.pos + 1]!] || DELIM[b[this.pos + 1]!])) {
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
        const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let n = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; k++) n = n * 8 + b[this.pos++]! - 0x30;
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

// ---------- Filters ----------

async function inflate(data: Uint8Array, raw = false): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(raw ? "deflate-raw" : "deflate")).getReader();
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
    if (!total && !raw && data.length > 2) return inflate(data.subarray(2), true).catch(() => new Uint8Array());
    if (!total) throw cause;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

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
    for (let r = 0; r * rowBytes < out.length; r++)
      for (let i = r * rowBytes + bpp; i < Math.min(out.length, (r + 1) * rowBytes); i++) out[i] = (out[i]! + out[i - bpp]!) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]!;
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? out[dst + i - bpp]! : 0;
      const up = r ? out[dst + i - rowBytes]! : 0;
      const corner = r && i >= bpp ? out[dst + i - rowBytes - bpp]! : 0;
      const x = data[src + i]!;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      out[dst + i] = (x + [0, left, up, (left + up) >> 1, paeth][type]!) & 255;
    }
  }
  return out;
}

function asciiHex(data: Uint8Array) {
  const hex = latin1.decode(data).replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
  return Uint8Array.from({ length: Math.ceil(hex.length / 2) }, (_, i) => parseInt((hex.slice(i * 2, i * 2 + 2) + "0").slice(0, 2), 16));
}
function ascii85(data: Uint8Array) {
  const text = latin1.decode(data).replace(/^<~/, "").replace(/~>.*$/s, "").replace(/\s/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "z") {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const group = text.slice(i, i + 5);
    i += 5;
    const padded = group.padEnd(5, "u");
    let value = 0;
    for (const ch of padded) value = value * 85 + (ch.charCodeAt(0) - 33);
    const bytes = [value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255];
    out.push(...bytes.slice(0, group.length - 1));
  }
  return Uint8Array.from(out);
}
function runLength(data: Uint8Array) {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      out.push(...data.subarray(i, i + n + 1));
      i += n + 1;
    } else {
      out.push(...new Array<number>(257 - n).fill(data[i++]!));
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
  for (let pos = 0; pos + bits <= data.length * 8; ) {
    let code = 0;
    for (let i = 0; i < bits; i++, pos++) code = (code << 1) | ((data[pos >> 3]! >> (7 - (pos & 7))) & 1);
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    const entry: number[] | undefined = table[code] ?? (prev && code === table.length ? [...prev, prev[0]!] : undefined);
    if (!entry) break;
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]!]);
    prev = entry;
    if (table.length + early >= 1 << bits && bits < 12) bits++;
  }
  return Uint8Array.from(out);
}

const num = (value: PdfValue | undefined, fallback = 0) => (typeof value === "number" ? value : fallback);
const nameOf = (value: PdfValue | undefined) => (value instanceof Name ? value.value : undefined);

/** PDF text strings: UTF-16 with a byte order mark, UTF-8 with one, else PDFDocEncoding (close to Latin-1). */
export function pdfText(value: PdfValue | undefined) {
  if (!isBytes(value)) return "";
  if (value[0] === 0xfe && value[1] === 0xff) return new TextDecoder("utf-16be").decode(value.subarray(2));
  if (value[0] === 0xff && value[1] === 0xfe) return new TextDecoder("utf-16le").decode(value.subarray(2));
  if (value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) return new TextDecoder().decode(value.subarray(3));
  return latin1.decode(value);
}

// ---------- Document ----------

export type PdfTextItem = { str: string; hasEOL: boolean; x: number; y: number; width: number; height: number; angle: number; font: string };
export type PdfLink = { rect: [number, number, number, number] } & ({ url: string } | { page: number });
export type PdfPage = { dict: PdfDict; resources: PdfDict; box: [number, number, number, number]; rotate: number; width: number; height: number };

export class PdfDocument {
  readonly bytes: Uint8Array;
  private readonly offsets = new Map<number, number>();
  private readonly compressed = new Map<number, { stream: number; index: number }>();
  private readonly objectStreams = new Map<number, Map<number, PdfValue>>();
  private readonly cache = new Map<number, PdfValue>();
  trailer: PdfDict = new Map();
  pages: PdfPage[] = [];
  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static async open(input: ArrayBuffer | Uint8Array) {
    const doc = new PdfDocument(input instanceof Uint8Array ? input : new Uint8Array(input));
    if (latin1.decode(doc.bytes.subarray(0, 1024)).indexOf("%PDF-") < 0) throw new Error("Not a PDF file");
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
    return doc;
  }

  get numPages() {
    return this.pages.length;
  }

  /** Document information, for titles and search. */
  get info() {
    const info = this.get(this.trailer.get("Info"));
    const out: Record<string, string> = {};
    if (isDict(info)) for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) if (info.has(key)) out[key] = pdfText(this.get(info.get(key)));
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
            if (entry[3] === "n" && !this.offsets.has(id) && !this.compressed.has(id)) this.offsets.set(id, Number(entry[1]));
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
    if (!isStream(object) || nameOf(object.dict.get("Type")) !== "XRef") throw new Error("Bad xref stream");
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
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) this.offsets.set(Number(m[1]), m.index);
    this.cache.clear();
    const trailerAt = text.lastIndexOf("trailer");
    if (trailerAt >= 0) {
      const value = new Lexer(this.bytes, trailerAt + 7).read();
      if (isDict(value)) for (const [key, entry] of value) this.trailer.set(key, entry);
    }
    if (!this.trailer.get("Root"))
      for (const [id] of this.offsets) {
        const object = this.object(id);
        if (isDict(object) && nameOf(object.get("Type")) === "Catalog") this.trailer.set("Root", new Ref(id, 0));
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
    if (isDict(value) && latin1.decode(this.bytes.subarray(lexer.pos, lexer.pos + 6)) === "stream") {
      let start = lexer.pos + 6;
      if (this.bytes[start] === 13) start++;
      if (this.bytes[start] === 10) start++;
      let length = this.get(value.get("Length"));
      const declared = typeof length === "number" ? start + length : -1;
      if (declared < 0 || declared > this.bytes.length || !/^\s*endstream/.test(latin1.decode(this.bytes.subarray(declared, declared + 20)))) {
        const end = latin1.decode(this.bytes.subarray(start, Math.min(this.bytes.length, start + 64 * 1024 * 1024))).indexOf("endstream");
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
    for (let i = 0; i < count; i++) entries.push([num(header.read(false)), num(header.read(false))]);
    const map = this.objectStreams.get(id)!;
    for (const [objectId, offset] of entries) map.set(objectId, new Lexer(data, first + offset).read() ?? null);
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

  async decode(stream: PdfStream, stopAtImage = false): Promise<Uint8Array> {
    const filters = this.get(stream.dict.get("Filter") ?? stream.dict.get("F"));
    const parms = this.get(stream.dict.get("DecodeParms") ?? stream.dict.get("DP"));
    const list = (Array.isArray(filters) ? filters : filters ? [filters] : []).map((f) => nameOf(this.get(f)));
    const parmList = Array.isArray(parms) ? parms.map((p) => this.dict(p)) : [this.dict(parms)];
    let data = stream.data;
    for (const [i, filter] of list.entries()) {
      const p = parmList[i];
      if (filter === "FlateDecode" || filter === "Fl") data = unpredict(await inflate(data), p);
      else if (filter === "LZWDecode" || filter === "LZW") data = unpredict(lzw(data, num(p?.get("EarlyChange"), 1)), p);
      else if (filter === "ASCIIHexDecode" || filter === "AHx") data = asciiHex(data);
      else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
      else if (filter === "RunLengthDecode" || filter === "RL") data = runLength(data);
      else if (stopAtImage) return data;
      else throw new Error(`Unsupported PDF filter ${filter}`);
    }
    return data;
  }

  private collectPages() {
    const pages: PdfPage[] = [];
    const root = this.dict(this.trailer.get("Root"));
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, inherited: { resources?: PdfDict | undefined; media?: PdfValue[] | undefined; crop?: PdfValue[] | undefined; rotate?: number | undefined }) => {
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
      const box = (crop?.length === 4 ? intersect(media, crop) : media) as [number, number, number, number];
      const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
      const rotate = ((((state.rotate ?? 0) % 360) + 360) % 360) as number;
      const [w, h] = [x1 - x0 || 612, y1 - y0 || 792];
      pages.push({ dict: node, resources: state.resources ?? new Map(), box: [x0, y0, x1, y1], rotate, width: rotate % 180 ? h : w, height: rotate % 180 ? w : h });
    };
    walk(this.dict(root?.get("Pages")), {});
    return pages;
  }

  async contents(page: PdfPage) {
    const contents = this.get(page.dict.get("Contents"));
    const streams = (Array.isArray(contents) ? contents.map((c) => this.get(c)) : [contents]).filter(isStream);
    const parts = await Promise.all(streams.map((s) => this.decode(s).catch(() => new Uint8Array())));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      out[at + part.length] = 10;
      at += part.length + 1;
    }
    return out;
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
      const rect = this.array(annotation.get("Rect")).map((v) => num(v));
      if (rect.length !== 4) continue;
      const [ax, ay] = apply(vp, rect[0]!, rect[1]!);
      const [bx, by] = apply(vp, rect[2]!, rect[3]!);
      const box: [number, number, number, number] = [Math.min(ax, bx) / page.width, Math.min(ay, by) / page.height, Math.abs(bx - ax) / page.width, Math.abs(by - ay) / page.height];
      const action = this.dict(annotation.get("A"));
      const uri = action && nameOf(action.get("S")) === "URI" ? pdfText(this.get(action.get("URI"))) : "";
      if (/^https?:\/\//i.test(uri)) {
        out.push({ rect: box, url: uri });
        continue;
      }
      const target = this.destinationPage(action && nameOf(action.get("S")) === "GoTo" ? action.get("D") : annotation.get("Dest"));
      if (target !== null) out.push({ rect: box, page: target });
    }
    return out;
  }

  private destinationPage(dest: PdfValue | undefined, depth = 0): number | null {
    let value = this.get(dest);
    if ((isBytes(value) || value instanceof Name) && depth < 4) value = this.namedDestination(isBytes(value) ? pdfText(value) : value.value);
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
      for (let i = 0; i + 1 < names.length; i += 2) if (pdfText(names[i]!) === name) return this.get(names[i + 1]!);
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
  paint(index: number, context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, signal?: AbortSignal) {
    return this.render(index, context, signal);
  }

  private async render(index: number, context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, signal?: AbortSignal): Promise<PdfTextItem[]> {
    const page = this.pages[index]!;
    const items: PdfTextItem[] = [];
    const text = (item: PdfTextItem) => {
      // Pieces of one line merge into a run, with a space where the gap is a word break.
      const last = items.at(-1);
      const gap = last ? (item.x - (last.x + Math.cos(last.angle) * last.width)) / (last.height || 1) : 0;
      if (last && last.angle === item.angle && Math.abs(last.height - item.height) < 0.5 && Math.abs(item.y - last.y) < last.height * 0.2 && gap > -0.3 && gap < 1.2) {
        last.str += (gap > 0.15 && !last.str.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") + item.str;
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
    const painter = new Painter(this, page, { context, text, signal }, base ? base.multiply(new DOMMatrix(this.viewport(page))) : undefined);
    await painter.run(await this.contents(page), page.resources, [1, 0, 0, 1, 0, 0], 0);
    context?.restore();
    for (let i = 0; i < items.length; i++) {
      const next = items[i + 1];
      items[i]!.hasEOL = !next || Math.abs(next.y - items[i]!.y) > items[i]!.height * 0.5;
    }
    return items;
  }
}

function intersect(a: number[], b: number[]) {
  const [ax0, ay0, ax1, ay1] = [Math.min(a[0]!, a[2]!), Math.min(a[1]!, a[3]!), Math.max(a[0]!, a[2]!), Math.max(a[1]!, a[3]!)];
  const [bx0, by0, bx1, by1] = [Math.min(b[0]!, b[2]!), Math.min(b[1]!, b[3]!), Math.max(b[0]!, b[2]!), Math.max(b[1]!, b[3]!)];
  const box = [Math.max(ax0, bx0), Math.max(ay0, by0), Math.min(ax1, bx1), Math.min(ay1, by1)];
  return box[2]! > box[0]! && box[3]! > box[1]! ? box : a;
}

// ---------- Content interpretation ----------

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

type Font = { decode: (bytes: Uint8Array) => { code: number; text: string; width: number; space: boolean }[]; family: string; weight: string; style: string };

const WIN_ANSI_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const GLYPHS: Record<string, string> = {
  space: " ", quotesingle: "'", quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”", bullet: "•", endash: "–", emdash: "—",
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", ellipsis: "…", trademark: "™", copyright: "©", registered: "®", degree: "°", minus: "−",
  hyphen: "-", period: ".", comma: ",", colon: ":", semicolon: ";", exclam: "!", question: "?", parenleft: "(", parenright: ")", bracketleft: "[",
  bracketright: "]", braceleft: "{", braceright: "}", slash: "/", backslash: "\\", ampersand: "&", percent: "%", dollar: "$", numbersign: "#",
  at: "@", asterisk: "*", plus: "+", equal: "=", less: "<", greater: ">", underscore: "_", bar: "|", asciitilde: "~", asciicircum: "^", grave: "`",
  quotedbl: '"', zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", dagger: "†",
  daggerdbl: "‡", section: "§", paragraph: "¶", florin: "ƒ", Euro: "€", sterling: "£", yen: "¥", cent: "¢", nbspace: " ",
};
function glyphText(name: string) {
  if (GLYPHS[name]) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-F]{4,6})$/.exec(name) ?? /^u([0-9A-F]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16));
  const accented = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron)$/.exec(name);
  if (accented) return (accented[1]! + { acute: "́", grave: "̀", circumflex: "̂", dieresis: "̈", tilde: "̃", ring: "̊", cedilla: "̧", caron: "̌" }[accented[2]!]).normalize("NFC");
  return "";
}
function baseEncoding(name: string | undefined) {
  return Array.from({ length: 256 }, (_, code) => {
    if (name === "MacRomanEncoding" && code >= 128) return new TextDecoder("macintosh").decode(Uint8Array.of(code));
    if (code >= 0x80 && code < 0xa0) return WIN_ANSI_HIGH[code - 0x80];
    if (name === "StandardEncoding" && code === 0x27) return "’";
    return code >= 32 ? String.fromCharCode(code) : "";
  });
}

/** A ToUnicode CMap's bfchar and bfrange mappings, with its code space byte lengths. */
function parseCMap(data: Uint8Array) {
  const map = new Map<number, string>();
  const lengths = new Set<number>();
  const lexer = new Lexer(data);
  const hex = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);
  const utf16 = (b: Uint8Array) => {
    let out = "";
    for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return b.length % 2 ? latin1.decode(b) : out;
  };
  const stack: PdfValue[] = [];
  for (let token = lexer.read(false); token !== undefined; token = lexer.read(false)) {
    if (!(token instanceof Op)) {
      stack.push(token);
      continue;
    }
    if (token.value === "endcodespacerange") for (let i = 0; i + 1 < stack.length; i += 2) if (isBytes(stack[i])) lengths.add((stack[i] as Uint8Array).length);
    if (token.value === "endbfchar")
      for (let i = 0; i + 1 < stack.length; i += 2) {
        const [src, dst] = [stack[i], stack[i + 1]];
        if (isBytes(src) && isBytes(dst)) map.set(hex(src), utf16(dst));
        if (isBytes(src)) lengths.add(src.length);
      }
    if (token.value === "endbfrange")
      for (let i = 0; i + 2 < stack.length; i += 3) {
        const [lo, hi, dst] = [stack[i], stack[i + 1], stack[i + 2]];
        if (!isBytes(lo) || !isBytes(hi)) continue;
        lengths.add(lo.length);
        const start = hex(lo);
        const end = Math.min(hex(hi), start + 65535);
        for (let code = start; code <= end; code++) {
          if (Array.isArray(dst)) {
            const item = dst[code - start];
            if (isBytes(item)) map.set(code, utf16(item));
          } else if (isBytes(dst)) {
            const base = utf16(dst);
            map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + code - start));
          }
        }
      }
    if (/^(begin|end)/.test(token.value)) stack.length = 0;
  }
  return { map, lengths: lengths.size ? [...lengths].sort((a, b) => a - b) : [1] };
}

class Painter {
  private readonly fonts = new Map<PdfDict, Font>();
  private readonly doc: PdfDocument;
  private readonly output: { context?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined; text?: (item: PdfTextItem) => void; signal?: AbortSignal | undefined };
  private readonly viewport: Matrix;
  /** PDF user space to device pixels, before the content's own transforms. */
  private readonly device: Matrix;
  constructor(doc: PdfDocument, page: PdfPage, output: Painter["output"], device: DOMMatrix | undefined) {
    this.doc = doc;
    this.output = output;
    this.viewport = doc.viewport(page);
    this.device = device ? [device.a, device.b, device.c, device.d, device.e, device.f] : this.viewport;
  }

  private async font(dict: PdfDict | undefined): Promise<Font> {
    const fallback: Font = { decode: (b) => Array.from(b, (c) => ({ code: c, text: String.fromCharCode(c), width: 500, space: c === 32 })), family: "sans-serif", weight: "400", style: "normal" };
    if (!dict) return fallback;
    const cached = this.fonts.get(dict);
    if (cached) return cached;
    const doc = this.doc;
    const subtype = nameOf(dict.get("Subtype"));
    const base = (nameOf(dict.get("BaseFont")) ?? "").replace(/^[A-Z]{6}\+/, "");
    const descendant = subtype === "Type0" ? doc.dict(doc.array(dict.get("DescendantFonts"))[0]) : undefined;
    const descriptor = doc.dict((descendant ?? dict).get("FontDescriptor"));
    const flags = num(doc.get(descriptor?.get("Flags")));
    const family = /courier|mono|consol/i.test(base) || flags & 1 ? "ui-monospace, Menlo, Consolas, monospace" : /times|serif|roman|georgia|garamond|cambria|minion/i.test(base) && !/sans/i.test(base) ? "Georgia, 'Times New Roman', serif" : flags & 2 && !/sans|arial|helvet/i.test(base) ? "Georgia, 'Times New Roman', serif" : "Helvetica, Arial, sans-serif";
    const weight = /bold|black|heavy|semibold|demi/i.test(base) || num(doc.get(descriptor?.get("FontWeight"))) >= 600 ? "700" : "400";
    const style = /italic|oblique/i.test(base) || flags & 64 ? "italic" : "normal";
    const toUnicode = doc.get(dict.get("ToUnicode"));
    const cmap = isStream(toUnicode) ? parseCMap(await doc.decode(toUnicode).catch(() => new Uint8Array())) : null;
    let font: Font;
    if (subtype === "Type0") {
      const widths = new Map<number, number>();
      const w = doc.array(descendant?.get("W"));
      for (let i = 0; i < w.length; ) {
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
      const fallbackWidth = num(doc.get(descendant?.get("DW")), 1000);
      const twoByte = nameOf(dict.get("Encoding"))?.startsWith("Identity") ?? true;
      font = {
        family, weight, style,
        decode: (bytes) => {
          const out: ReturnType<Font["decode"]> = [];
          const lengths = cmap?.lengths ?? [twoByte ? 2 : 1];
          for (let i = 0; i < bytes.length; ) {
            let length = lengths.at(-1)!;
            let code = 0;
            for (const candidate of lengths) {
              let value = 0;
              for (let k = 0; k < candidate; k++) value = value * 256 + (bytes[i + k] ?? 0);
              if (cmap?.map.has(value)) {
                length = candidate;
                break;
              }
            }
            for (let k = 0; k < length; k++) code = code * 256 + (bytes[i + k] ?? 0);
            i += length;
            out.push({ code, text: cmap?.map.get(code) ?? "", width: widths.get(code) ?? fallbackWidth, space: false });
          }
          return out;
        },
      };
    } else {
      const encodingValue = doc.get(dict.get("Encoding"));
      const encodingDict = isDict(encodingValue) ? encodingValue : undefined;
      const table = baseEncoding(nameOf(encodingValue) ?? nameOf(encodingDict?.get("BaseEncoding")));
      let code = 0;
      for (const item of doc.array(encodingDict?.get("Differences"))) {
        if (typeof item === "number") code = item;
        else if (item instanceof Name) table[code++ & 255] = glyphText(item.value);
      }
      const firstChar = num(doc.get(dict.get("FirstChar")));
      const widthList = doc.array(dict.get("Widths")).map((v) => num(v));
      const missing = num(doc.get(descriptor?.get("MissingWidth")), 0);
      const standard = family.includes("monospace") ? 600 : family.includes("serif") && !family.includes("sans") ? 480 : 540;
      font = {
        family, weight, style,
        decode: (bytes) =>
          Array.from(bytes, (c) => ({
            code: c,
            text: cmap?.map.get(c) ?? table[c] ?? "",
            width: widthList[c - firstChar] ?? (missing || (c === 32 ? 278 : standard)),
            space: c === 32,
          })),
      };
    }
    this.fonts.set(dict, font);
    return font;
  }

  async run(content: Uint8Array, resources: PdfDict, base: Matrix, depth: number) {
    const doc = this.doc;
    const context = this.output.context;
    type State = { ctm: Matrix; fill: string; stroke: string; fillAlpha: number; strokeAlpha: number; lineWidth: number; font: Font | undefined; fontSize: number; charSpacing: number; wordSpacing: number; scale: number; leading: number; rise: number; render: number; fillSpace: string; strokeSpace: string };
    let state: State = { ctm: base, fill: "#000", stroke: "#000", fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, font: undefined, fontSize: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0, render: 0, fillSpace: "DeviceGray", strokeSpace: "DeviceGray" };
    const stack: State[] = [];
    let tm: Matrix = [1, 0, 0, 1, 0, 0];
    let tlm: Matrix = [1, 0, 0, 1, 0, 0];
    let path: Path2D | null = null;
    let pendingClip: "nonzero" | "evenodd" | null = null;
    const lexer = new Lexer(content);
    const operands: PdfValue[] = [];
    const resource = (kind: string, name: PdfValue | undefined) => doc.dict(resources.get(kind))?.get(nameOf(name) ?? "");
    const color = (values: PdfValue[], space: string) => {
      const n = values.filter((v): v is number => typeof v === "number");
      if (space === "DeviceCMYK" || n.length === 4) {
        const [c, m, y, k] = n as [number, number, number, number];
        return `rgb(${255 * (1 - c) * (1 - k)},${255 * (1 - m) * (1 - k)},${255 * (1 - y) * (1 - k)})`;
      }
      if (n.length >= 3) return `rgb(${n[0]! * 255},${n[1]! * 255},${n[2]! * 255})`;
      if (n.length === 1 && space !== "Pattern") return `rgb(${n[0]! * 255},${n[0]! * 255},${n[0]! * 255})`;
      return "#777";
    };
    const spaceName = (value: PdfValue | undefined) => {
      const name = nameOf(value);
      if (name && ["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern"].includes(name)) return name;
      const resolved = doc.get(resource("ColorSpace", value));
      const family = Array.isArray(resolved) ? nameOf(doc.get(resolved[0])) : nameOf(resolved);
      if (family === "ICCBased" && Array.isArray(resolved)) {
        const n = num(doc.dict(resolved[1])?.get("N"), 3);
        return n === 1 ? "DeviceGray" : n === 4 ? "DeviceCMYK" : "DeviceRGB";
      }
      return family ?? "DeviceRGB";
    };
    const setTransform = () => context?.setTransform(...(multiply(state.ctm, this.device) as Matrix));
    const showText = (bytes: Uint8Array) => {
      const font = state.font;
      if (!font) return;
      const size = state.fontSize;
      const h = state.scale;
      let advance = 0;
      let text = "";
      for (const glyph of font.decode(bytes)) {
        text += glyph.text;
        advance += ((glyph.width / 1000) * size + state.charSpacing + (glyph.space ? state.wordSpacing : 0)) * h;
      }
      // Text space (y up, one unit per point of font size) to user space.
      const run = multiply([h, 0, 0, 1, 0, state.rise], multiply(tm, state.ctm));
      if (text.trim()) {
        const toPage = multiply(run, this.viewport);
        const [sx, sy] = apply(toPage, 0, 0);
        const [ex, ey] = apply(toPage, advance / h, 0);
        const [ux, uy] = apply(toPage, 0, size);
        const height = Math.hypot(ux - sx, uy - sy);
        this.output.text?.({ str: text, hasEOL: false, x: sx, y: sy, width: Math.hypot(ex - sx, ey - sy), height, angle: Math.atan2(ey - sy, ex - sx), font: font.family });
        if (context && state.render !== 3 && state.render !== 7 && size) {
          const device = multiply(multiply([1, 0, 0, -1, 0, 0], run), this.device);
          // Fold the transform's scale into the font size so glyphs rasterize at device resolution.
          const k = Math.sqrt(Math.abs(device[0] * device[3] - device[1] * device[2])) || 1;
          const px = Math.abs(size) * k;
          const flip = size < 0 ? -1 : 1;
          context.save();
          context.font = `${font.style} ${font.weight} ${px}px ${font.family}`;
          const measured = context.measureText(text).width / k;
          // System fonts substitute embedded ones; each run stretches to the PDF's advance so layout holds.
          const stretch = measured > 0 ? Math.min(4, Math.max(0.25, advance / h / measured)) : 1;
          context.setTransform((device[0] / k) * stretch * flip, (device[1] / k) * stretch * flip, (device[2] / k) * flip, (device[3] / k) * flip, device[4], device[5]);
          context.globalAlpha = state.fillAlpha;
          context.fillStyle = state.fill;
          context.fillText(text, 0, 0);
          context.restore();
        }
      }
      tm = multiply([1, 0, 0, 1, advance, 0], tm);
    };
    for (let token = lexer.read(); token !== undefined; token = lexer.read()) {
      if (!(token instanceof Op)) {
        operands.push(token);
        continue;
      }
      if (this.output.signal?.aborted) return;
      const op = token.value;
      const a = operands;
      const n = (i: number) => num(a[i]);
      try {
        switch (op) {
          case "q":
            stack.push({ ...state });
            context?.save();
            break;
          case "Q":
            if (stack.length) {
              state = stack.pop()!;
              context?.restore();
            }
            break;
          case "cm":
            state.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], state.ctm);
            break;
          case "w":
            state.lineWidth = n(0);
            break;
          case "J":
            if (context) context.lineCap = (["butt", "round", "square"] as const)[n(0)] ?? "butt";
            break;
          case "j":
            if (context) context.lineJoin = (["miter", "round", "bevel"] as const)[n(0)] ?? "miter";
            break;
          case "d":
            context?.setLineDash(doc.array(a[0]).map((v) => num(v)));
            break;
          case "gs": {
            const gs = doc.dict(resource("ExtGState", a[0]));
            if (gs?.has("ca")) state.fillAlpha = num(doc.get(gs.get("ca")), 1);
            if (gs?.has("CA")) state.strokeAlpha = num(doc.get(gs.get("CA")), 1);
            if (gs?.has("LW")) state.lineWidth = num(doc.get(gs.get("LW")), 1);
            break;
          }
          case "g": case "rg": case "k":
            state.fillSpace = op === "g" ? "DeviceGray" : op === "rg" ? "DeviceRGB" : "DeviceCMYK";
            state.fill = color(a, state.fillSpace);
            break;
          case "G": case "RG": case "K":
            state.strokeSpace = op === "G" ? "DeviceGray" : op === "RG" ? "DeviceRGB" : "DeviceCMYK";
            state.stroke = color(a, state.strokeSpace);
            break;
          case "cs":
            state.fillSpace = spaceName(a[0]);
            state.fill = state.fillSpace === "DeviceCMYK" ? color([0, 0, 0, 1], "DeviceCMYK") : "#000";
            break;
          case "CS":
            state.strokeSpace = spaceName(a[0]);
            state.stroke = "#000";
            break;
          case "sc": case "scn":
            state.fill = color(a, state.fillSpace);
            break;
          case "SC": case "SCN":
            state.stroke = color(a, state.strokeSpace);
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
          case "W": case "W*":
            pendingClip = op === "W" ? "nonzero" : "evenodd";
            break;
          case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "n": {
            if (context && path) {
              if (op === "s" || op === "b" || op === "b*") path.closePath();
              setTransform();
              const fill = op !== "S" && op !== "s" && op !== "n";
              const stroke = ["S", "s", "B", "B*", "b", "b*"].includes(op);
              if (fill) {
                context.globalAlpha = state.fillAlpha;
                context.fillStyle = state.fill;
                context.fill(path, op.includes("*") ? "evenodd" : "nonzero");
              }
              if (stroke) {
                context.globalAlpha = state.strokeAlpha;
                context.strokeStyle = state.stroke;
                // Hairlines stay one device pixel wide at any zoom.
                const scale = Math.hypot(state.ctm[0], state.ctm[1]) || 1;
                context.lineWidth = Math.max(state.lineWidth, 0.6 / scale);
                context.stroke(path);
              }
              if (pendingClip) context.clip(path, pendingClip);
            }
            path = null;
            pendingClip = null;
            break;
          }
          case "BT":
            tm = [1, 0, 0, 1, 0, 0];
            tlm = [1, 0, 0, 1, 0, 0];
            break;
          case "Tf":
            state.font = await this.font(doc.dict(resource("Font", a[0])));
            state.fontSize = n(1);
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
            tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
            tm = tlm;
            break;
          case "TD":
            state.leading = -n(1);
            tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
            tm = tlm;
            break;
          case "Tm":
            tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
            tm = tlm;
            break;
          case "T*":
            tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
            tm = tlm;
            break;
          case "Tj":
            if (isBytes(a[0])) showText(a[0]);
            break;
          case "'":
          case '"':
            if (op === '"') {
              state.wordSpacing = n(0);
              state.charSpacing = n(1);
            }
            tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
            tm = tlm;
            if (isBytes(a.at(-1))) showText(a.at(-1) as Uint8Array);
            break;
          case "TJ":
            for (const item of Array.isArray(a[0]) ? a[0] : []) {
              if (isBytes(item)) showText(item);
              else if (typeof item === "number") tm = multiply([1, 0, 0, 1, (-item / 1000) * state.fontSize * state.scale, 0], tm);
            }
            break;
          case "Do": {
            const xobject = doc.get(resource("XObject", a[0]));
            if (!isStream(xobject) || depth > 12) break;
            const subtype = nameOf(xobject.dict.get("Subtype"));
            if (subtype === "Form") {
              const matrix = doc.array(xobject.dict.get("Matrix")).map((v) => num(v));
              const ctm = matrix.length === 6 ? multiply(matrix as Matrix, state.ctm) : state.ctm;
              const inner = doc.dict(xobject.dict.get("Resources")) ?? resources;
              context?.save();
              const bbox = doc.array(xobject.dict.get("BBox")).map((v) => num(v));
              if (context && bbox.length === 4) {
                context.setTransform(...(multiply(ctm, this.device) as Matrix));
                const clip = new Path2D();
                clip.rect(bbox[0]!, bbox[1]!, bbox[2]! - bbox[0]!, bbox[3]! - bbox[1]!);
                context.clip(clip);
              }
              const saved = { ...state };
              await this.run(await doc.decode(xobject), inner, ctm, depth + 1);
              state = { ...saved, ctm: saved.ctm };
              context?.restore();
            } else if (subtype === "Image" && context) {
              const bitmap = await this.image(xobject, state.fill);
              if (bitmap) {
                context.save();
                context.setTransform(...(multiply(multiply([1, 0, 0, -1, 0, 1], state.ctm), this.device) as Matrix));
                context.globalAlpha = state.fillAlpha;
                context.imageSmoothingQuality = "high";
                context.drawImage(bitmap, 0, 0, 1, 1);
                context.restore();
                bitmap.close();
              }
            }
            break;
          }
          case "BI": {
            // Inline images are skipped to their end marker.
            const start = lexer.pos;
            const end = latin1.decode(content.subarray(start, Math.min(content.length, start + 4 * 1024 * 1024))).search(/\sEI(?=[\s]|$)/);
            lexer.pos = end < 0 ? content.length : start + end + 3;
            break;
          }
        }
      } catch {
        // A damaged operator leaves the rest of the page drawable.
      }
      operands.length = 0;
    }
  }

  private async image(stream: PdfStream, fill: string): Promise<ImageBitmap | null> {
    const doc = this.doc;
    const dict = stream.dict;
    const filters = doc.get(dict.get("Filter"));
    const last = nameOf(Array.isArray(filters) ? doc.get(filters.at(-1)) : filters);
    const width = num(doc.get(dict.get("Width")));
    const height = num(doc.get(dict.get("Height")));
    if (!width || !height || width * height > 40_000_000) return null;
    if (last === "DCTDecode" || last === "DCT") {
      const data = await doc.decode(stream, true);
      return createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).catch(() => null);
    }
    if (last === "JPXDecode" || last === "JBIG2Decode" || last === "CCITTFaxDecode") return null;
    const data = await doc.decode(stream);
    const bpc = num(doc.get(dict.get("BitsPerComponent")), 1);
    const mask = dict.get("ImageMask") === true;
    const csValue = doc.get(dict.get("ColorSpace"));
    let components = 1;
    let palette: Uint8Array | null = null;
    let baseComponents = 3;
    const resolveSpace = (value: PdfValue | undefined): number => {
      const resolved = doc.get(value);
      const family = Array.isArray(resolved) ? nameOf(doc.get(resolved[0])) : nameOf(resolved);
      if (family === "DeviceRGB" || family === "CalRGB" || family === "Lab") return 3;
      if (family === "DeviceCMYK") return 4;
      if (family === "ICCBased" && Array.isArray(resolved)) return num(doc.dict(resolved[1])?.get("N"), 3);
      if (family === "Indexed" && Array.isArray(resolved)) {
        baseComponents = resolveSpace(resolved[1]);
        const lookup = doc.get(resolved[3]);
        palette = isBytes(lookup) ? lookup : null;
        return 1;
      }
      return 1;
    };
    if (!mask) components = resolveSpace(csValue);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const rowBits = width * components * bpc;
    const rowBytes = Math.ceil(rowBits / 8);
    const sample = (row: number, index: number) => {
      if (bpc === 8) return data[row * rowBytes + index] ?? 0;
      if (bpc === 16) return data[row * rowBytes + index * 2] ?? 0;
      const bit = index * bpc;
      const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
      return (byte >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
    };
    const max = bpc === 16 ? 255 : (1 << bpc) - 1;
    const decodeArray = doc.array(dict.get("Decode")).map((v) => num(v));
    const invert = decodeArray[0] === 1 && decodeArray[1] === 0;
    const [fr, fg, fb] = (/rgb\(([^)]*)\)/.exec(fill)?.[1]?.split(",").map(Number) ?? [0, 0, 0]) as [number, number, number];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (mask) {
          const on = (sample(y, x) === 0) !== invert;
          rgba[o] = fr;
          rgba[o + 1] = fg;
          rgba[o + 2] = fb;
          rgba[o + 3] = on ? 255 : 0;
          continue;
        }
        rgba[o + 3] = 255;
        if (palette) {
          const p = sample(y, x) * baseComponents;
          const entry = palette as Uint8Array;
          if (baseComponents === 4) {
            const k = 255 - entry[p + 3]!;
            for (let c = 0; c < 3; c++) rgba[o + c] = ((255 - entry[p + c]!) * k) / 255;
          } else if (baseComponents === 1) rgba.fill(entry[p] ?? 0, o, o + 3);
          else for (let c = 0; c < 3; c++) rgba[o + c] = entry[p + c] ?? 0;
        } else if (components === 3) for (let c = 0; c < 3; c++) rgba[o + c] = (sample(y, x * 3 + c) * 255) / max;
        else if (components === 4) {
          const k = 255 - (sample(y, x * 4 + 3) * 255) / max;
          for (let c = 0; c < 3; c++) rgba[o + c] = ((255 - (sample(y, x * 4 + c) * 255) / max) * k) / 255;
        } else {
          const g = (sample(y, x) * 255) / max;
          rgba.fill(invert ? 255 - g : g, o, o + 3);
        }
      }
    const smask = doc.get(dict.get("SMask"));
    if (isStream(smask) && num(doc.get(smask.dict.get("Width"))) === width && num(doc.get(smask.dict.get("Height"))) === height) {
      const alpha = await doc.decode(smask).catch(() => null);
      const alphaBits = num(doc.get(smask.dict.get("BitsPerComponent")), 8);
      if (alpha && alphaBits === 8) for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = alpha[i] ?? 255;
    }
    return createImageBitmap(new ImageData(rgba, width, height)).catch(() => null);
  }
}
