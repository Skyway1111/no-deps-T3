// Zero-dependency ZIP reader & STORE writer. Small entries inflate synchronously; large ones stream.
import { inflateRaw } from "./inflateRaw.ts";

export interface NativeZipEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly date: Date;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export interface ZipStreamOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxBytes?: number | undefined;
  readonly onChunk?: ((chunk: Uint8Array<ArrayBuffer>) => void) | undefined;
}

export interface NativeZipOpenOptions {
  readonly maxEntries?: number | undefined;
  readonly rejectZip64?: boolean | undefined;
}

export interface ZipArchiveEntry {
  async(type: "string"): Promise<string>;
  async(type: "uint8array"): Promise<Uint8Array<ArrayBuffer>>;
  async(type: "base64"): Promise<string>;
}

/** Structural read interface shared by MemoryZipArchive and legacy JSZip instances in tests. */
export interface ZipArchiveReadable {
  file(path: string): ZipArchiveEntry | null;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const FEED_CHUNK_BYTES = 64 * 1024;
// Sync inflate bound: Web Streams setup dominates below this; above it, streaming bounds memory.
const SYNC_INFLATE_MAX_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const decodeDosDate = (time: number, date: number) =>
  new Date(
    Date.UTC(
      ((date >> 9) & 0x7f) + 1980,
      ((date >> 5) & 0x0f) - 1,
      date & 0x1f,
      (time >> 11) & 0x1f,
      (time >> 5) & 0x3f,
      (time & 0x1f) * 2,
    ),
  );

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let off = 0; off < bytes.length; off += 8192) {
    bin += String.fromCharCode(...bytes.subarray(off, off + 8192));
  }
  return btoa(bin);
}

function readZip64Extra(view: DataView, start: number, len: number, needU: boolean, needC: boolean, needOff: boolean) {
  let c = start;
  const end = start + len;
  while (c + 4 <= end) {
    const id = view.getUint16(c, true);
    const sz = view.getUint16(c + 2, true);
    c += 4;
    if (c + sz > end) break;
    if (id === 0x0001) {
      let p = c;
      const out: { u?: number; c?: number; off?: number } = {};
      if (needU && p + 8 <= c + sz) { out.u = Number(view.getBigUint64(p, true)); p += 8; }
      if (needC && p + 8 <= c + sz) { out.c = Number(view.getBigUint64(p, true)); p += 8; }
      if (needOff && p + 8 <= c + sz) out.off = Number(view.getBigUint64(p, true));
      return out;
    }
    c += sz;
  }
  return {};
}

export class NativeZipReader {
  readonly entries: ReadonlyArray<NativeZipEntry>;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly byName = new Map<string, NativeZipEntry>();

  constructor(input: ArrayBuffer | Uint8Array, options: NativeZipOpenOptions = {}) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);

    const minEocd = Math.max(0, this.bytes.byteLength - 65_557);
    let eocd = -1;
    for (let off = this.bytes.byteLength - 22; off >= minEocd; off--) {
      if (this.view.getUint32(off, true) === SIG_EOCD && off + 22 + this.view.getUint16(off + 20, true) === this.bytes.byteLength) {
        eocd = off;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a valid ZIP archive: missing EOCD");

    let cdSize = this.view.getUint32(eocd + 12, true);
    let cdOffset = this.view.getUint32(eocd + 16, true);
    let cdEnd = eocd;
    if (this.view.getUint16(eocd + 10, true) === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      if (options.rejectZip64) throw new Error("Unsupported ZIP64 archive");
      const loc = eocd - 20;
      const rec = loc - 56;
      if (rec < 0 || this.view.getUint32(loc, true) !== SIG_ZIP64_LOCATOR || this.view.getUint32(rec, true) !== SIG_ZIP64_EOCD) {
        throw new Error("Invalid ZIP64 end of central directory");
      }
      cdSize = Number(this.view.getBigUint64(rec + 40, true));
      cdOffset = Number(this.view.getBigUint64(rec + 48, true));
      cdEnd = rec;
    }
    if (cdOffset + cdSize > cdEnd || cdOffset + cdSize > this.bytes.byteLength) {
      throw new Error("Invalid ZIP central directory bounds");
    }

    const parsed: NativeZipEntry[] = [];
    const maxEntries = options.maxEntries ?? Infinity;
    const limit = cdOffset + cdSize;
    for (let cur = cdOffset; cur < limit; ) {
      if (cur + 46 > limit || this.view.getUint32(cur, true) !== SIG_CENTRAL) throw new Error("Invalid ZIP central directory entry");
      if (parsed.length >= maxEntries) throw new Error(`ZIP archive exceeds maximum entry limit (${maxEntries})`);
      if ((this.view.getUint16(cur + 8, true) & 1) !== 0) throw new Error("Encrypted ZIP entries are not supported");
      const compressionMethod = this.view.getUint16(cur + 10, true);
      const date = decodeDosDate(this.view.getUint16(cur + 12, true), this.view.getUint16(cur + 14, true));
      const entryCrc = this.view.getUint32(cur + 16, true);
      let compressedSize = this.view.getUint32(cur + 20, true);
      let uncompressedSize = this.view.getUint32(cur + 24, true);
      const nameLen = this.view.getUint16(cur + 28, true);
      const extraLen = this.view.getUint16(cur + 30, true);
      const commentLen = this.view.getUint16(cur + 32, true);
      const extAttrs = this.view.getUint32(cur + 38, true);
      let localHeaderOffset = this.view.getUint32(cur + 42, true);
      const next = cur + 46 + nameLen + extraLen + commentLen;
      if (next > limit) throw new Error("Truncated ZIP central directory entry");

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        if (options.rejectZip64) throw new Error("Unsupported ZIP64 entry metadata");
        const z = readZip64Extra(this.view, cur + 46 + nameLen, extraLen, uncompressedSize === 0xffffffff, compressedSize === 0xffffffff, localHeaderOffset === 0xffffffff);
        if (z.u !== undefined) uncompressedSize = z.u;
        if (z.c !== undefined) compressedSize = z.c;
        if (z.off !== undefined) localHeaderOffset = z.off;
      }
      const name = utf8Decoder.decode(this.bytes.subarray(cur + 46, cur + 46 + nameLen));
      const entry: NativeZipEntry = {
        name,
        directory: name.endsWith("/") || (extAttrs & 0x10) !== 0,
        date,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        crc32: entryCrc,
        localHeaderOffset,
      };
      parsed.push(entry);
      this.byName.set(name, entry);
      cur = next;
    }
    this.entries = parsed;
  }

  getEntry(name: string) {
    return this.byName.get(name);
  }

  async streamEntry(entry: NativeZipEntry, options: ZipStreamOptions = {}): Promise<void> {
    const { signal, maxBytes = Infinity, onChunk } = options;
    signal?.throwIfAborted();
    if (entry.directory) return;
    const off = entry.localHeaderOffset;
    if (off + 30 > this.bytes.byteLength || this.view.getUint32(off, true) !== SIG_LOCAL) {
      throw new Error(`Invalid local file header for ZIP entry: ${entry.name}`);
    }
    const dataStart = off + 30 + this.view.getUint16(off + 26, true) + this.view.getUint16(off + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.bytes.byteLength) throw new Error(`Truncated ZIP entry data: ${entry.name}`);
    const emit = (bytes: Uint8Array<ArrayBuffer>) => {
      for (let i = 0; i < bytes.byteLength; i += FEED_CHUNK_BYTES) {
        signal?.throwIfAborted();
        const chunk = bytes.subarray(i, Math.min(i + FEED_CHUNK_BYTES, bytes.byteLength));
        if (i + chunk.byteLength > maxBytes) throw new Error(`ZIP entry exceeds size limit: ${entry.name}`);
        onChunk?.(chunk);
      }
    };

    if (entry.compressionMethod === 0) return emit(this.bytes.slice(dataStart, dataEnd));
    if (entry.compressionMethod !== 8) throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`);
    if (entry.uncompressedSize <= SYNC_INFLATE_MAX_BYTES) {
      let inflated: Uint8Array<ArrayBuffer> | undefined;
      try {
        inflated = inflateRaw(this.bytes.subarray(dataStart, dataEnd), entry.uncompressedSize, SYNC_INFLATE_MAX_BYTES);
      } catch (error) {
        // Understated size: fall through to streaming, which enforces maxBytes chunk by chunk.
        if (!(error instanceof RangeError)) throw error;
      }
      if (inflated) return emit(inflated);
    }
    const compressed = this.bytes.slice(dataStart, dataEnd) as Uint8Array<ArrayBuffer>;

    let feed = 0;
    const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(ctrl) {
        if (feed >= compressed.byteLength) { ctrl.close(); return; }
        const end = Math.min(feed + FEED_CHUNK_BYTES, compressed.byteLength);
        ctrl.enqueue(compressed.subarray(feed, end));
        feed = end;
      },
    })
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    let emitted = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value as Uint8Array<ArrayBuffer>;
        if ((emitted += chunk.byteLength) > maxBytes) throw new Error(`ZIP entry exceeds size limit: ${entry.name}`);
        onChunk?.(chunk);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async readBytes(entryOrName: NativeZipEntry | string, options: Omit<ZipStreamOptions, "onChunk"> = {}): Promise<Uint8Array<ArrayBuffer>> {
    const entry = typeof entryOrName === "string" ? this.byName.get(entryOrName) : entryOrName;
    if (!entry) throw new Error(`ZIP entry not found: ${String(entryOrName)}`);
    if (entry.directory) return new Uint8Array(0);
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    await this.streamEntry(entry, { ...options, onChunk(c) { chunks.push(c); total += c.byteLength; } });
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return out;
  }

  async readText(entryOrName: NativeZipEntry | string, options: Omit<ZipStreamOptions, "onChunk"> = {}) {
    return utf8Decoder.decode(await this.readBytes(entryOrName, options));
  }
}

export const openZip = (input: ArrayBuffer | Uint8Array, options?: NativeZipOpenOptions) =>
  new NativeZipReader(input, options);

/** Mutable in-memory ZIP container that reads parts and serializes uncompressed (STORE) ZIPs. */
export class MemoryZipArchive implements ZipArchiveReadable {
  private readonly files = new Map<string, Uint8Array<ArrayBuffer>>();

  file(path: string): ZipArchiveEntry | null;
  file(path: string, content: string | Uint8Array): this;
  file(path: string, content?: string | Uint8Array): ZipArchiveEntry | null | this {
    if (content !== undefined) {
      this.files.set(
        path,
        (typeof content === "string" ? utf8Encoder.encode(content) : content.slice()) as Uint8Array<ArrayBuffer>,
      );
      return this;
    }
    const bytes = this.files.get(path);
    if (!bytes) return null;
    return {
      async(type: "string" | "uint8array" | "base64"): Promise<any> {
        return Promise.resolve(type === "string" ? utf8Decoder.decode(bytes) : type === "base64" ? bytesToBase64(bytes) : bytes);
      },
    };
  }

  remove(path: string) {
    this.files.delete(path);
  }

  toStoredZip(date = new Date()): ArrayBuffer {
    const yr = Math.max(1980, Math.min(2107, date.getUTCFullYear())) - 1980;
    const dosDate = (yr << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const items: Array<{ name: Uint8Array; data: Uint8Array; crc: number; off: number }> = [];
    let localTotal = 0;
    let cdTotal = 0;
    for (const [k, data] of this.files) {
      const name = utf8Encoder.encode(k);
      items.push({ name, data, crc: crc32(data), off: localTotal });
      localTotal += 30 + name.byteLength + data.byteLength;
      cdTotal += 46 + name.byteLength;
    }
    const out = new Uint8Array(localTotal + cdTotal + 22);
    const view = new DataView(out.buffer);
    let o = 0;
    for (const it of items) {
      const nl = it.name.byteLength;
      const sz = it.data.byteLength;
      view.setUint32(o, SIG_LOCAL, true);
      view.setUint16(o + 4, 20, true);
      view.setUint16(o + 6, 0x0800, true);
      view.setUint16(o + 10, dosTime, true);
      view.setUint16(o + 12, dosDate, true);
      view.setUint32(o + 14, it.crc, true);
      view.setUint32(o + 18, sz, true);
      view.setUint32(o + 22, sz, true);
      view.setUint16(o + 26, nl, true);
      out.set(it.name, o + 30);
      out.set(it.data, o + 30 + nl);
      o += 30 + nl + sz;
    }
    const cdStart = o;
    for (const it of items) {
      const nl = it.name.byteLength;
      const sz = it.data.byteLength;
      view.setUint32(o, SIG_CENTRAL, true);
      view.setUint16(o + 4, 20, true);
      view.setUint16(o + 6, 20, true);
      view.setUint16(o + 8, 0x0800, true);
      view.setUint16(o + 12, dosTime, true);
      view.setUint16(o + 14, dosDate, true);
      view.setUint32(o + 16, it.crc, true);
      view.setUint32(o + 20, sz, true);
      view.setUint32(o + 24, sz, true);
      view.setUint16(o + 28, nl, true);
      view.setUint32(o + 42, it.off, true);
      out.set(it.name, o + 46);
      o += 46 + nl;
    }
    view.setUint32(o, SIG_EOCD, true);
    view.setUint16(o + 8, items.length, true);
    view.setUint16(o + 10, items.length, true);
    view.setUint32(o + 12, cdTotal, true);
    view.setUint32(o + 16, cdStart, true);
    return out.buffer;
  }
}
