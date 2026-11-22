import { DecodeError } from "./tiffDecoder";

type Box = { type: string; start: number; end: number };
export type HeifProperty = { type: string; start: number; end: number };
export type HeifItem = { id: number; type: string; data: Uint8Array; properties: HeifProperty[] };
export type HeifImage = {
  readonly brand: string;
  readonly width: number;
  readonly height: number;
  /** Clockwise quarter turns to display. */
  readonly rotation: 0 | 90 | 180 | 270;
  /** 0 flips left-right, 1 flips top-bottom. */
  readonly mirror: 0 | 1 | undefined;
  readonly displayP3: boolean;
  readonly primary: HeifItem;
  /** Coded tiles in raster order: the primary itself unless it is a grid. */
  readonly tiles: readonly HeifItem[];
  readonly grid: { rows: number; columns: number } | undefined;
  /** The WebCodecs codec string and decoder configuration of the coded tiles. */
  readonly codec: string | undefined;
  readonly config: Uint8Array | undefined;
  readonly thumbnail: HeifItem | undefined;
  readonly exif: Uint8Array | undefined;
};

const fourcc = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function children(view: DataView, start: number, end: number, budget: { boxes: number }): Box[] {
  const out: Box[] = [];
  for (let offset = start; offset + 8 <= end; ) {
    if (++budget.boxes > 4096) throw new DecodeError("image-metadata-too-large");
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new DecodeError("heif-metadata-invalid");
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw new DecodeError("heif-metadata-invalid");
    out.push({ type: fourcc(view, offset + 4), start: offset + header, end: offset + size });
    offset += size;
  }
  return out;
}

/** Reads the ISOBMFF item structure of a HEIF/HEIC/AVIF still image. */
export function parseHeif(buffer: ArrayBuffer): HeifImage {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const budget = { boxes: 0 };
  const top = children(view, 0, buffer.byteLength, budget);
  const ftyp = top.find((b) => b.type === "ftyp");
  const meta = top.find((b) => b.type === "meta");
  if (!ftyp || !meta) throw new DecodeError("heif-metadata-invalid");
  const boxes = children(view, meta.start + 4, meta.end, budget);
  const find = (type: string) => boxes.find((b) => b.type === type);
  let reader = 0;
  const u = (bits: number) => {
    const value = bits === 0 ? 0 : bits === 8 ? view.getUint8(reader) : bits === 16 ? view.getUint16(reader) : bits === 32 ? view.getUint32(reader) : Number(view.getBigUint64(reader));
    reader += bits / 8;
    return value;
  };
  const pitm = find("pitm");
  if (!pitm) throw new DecodeError("heif-metadata-invalid");
  reader = pitm.start;
  const primaryId = u(8) === 0 ? (reader += 3, u(16)) : (reader += 3, u(32));
  // Items.
  const types = new Map<number, string>();
  const iinf = find("iinf");
  if (iinf) {
    reader = iinf.start;
    const version = u(8);
    reader += 3;
    reader += version === 0 ? 2 : 4;
    for (const infe of children(view, reader, iinf.end, budget).filter((b) => b.type === "infe")) {
      reader = infe.start;
      const v = u(8);
      reader += 3;
      if (v < 2) continue;
      const id = v === 2 ? u(16) : u(32);
      reader += 2;
      types.set(id, fourcc(view, reader));
    }
  }
  const idat = find("idat");
  const data = new Map<number, Uint8Array>();
  const iloc = find("iloc");
  if (iloc) {
    reader = iloc.start;
    const version = u(8);
    reader += 3;
    const sizes = u(16);
    const [offsetSize, lengthSize, baseSize, indexSize] = [(sizes >> 12) & 15, (sizes >> 8) & 15, (sizes >> 4) & 15, version ? sizes & 15 : 0].map((n) => n * 8) as [number, number, number, number];
    const count = version < 2 ? u(16) : u(32);
    for (let i = 0; i < count; i++) {
      const id = version < 2 ? u(16) : u(32);
      const method = version ? u(16) & 15 : 0;
      reader += 2;
      const base = u(baseSize);
      const extents = u(16);
      const parts: Uint8Array[] = [];
      for (let e = 0; e < extents; e++) {
        u(indexSize);
        const offset = u(offsetSize);
        const length = u(lengthSize);
        const source = method === 1 ? (idat ? bytes.subarray(idat.start, idat.end) : new Uint8Array()) : bytes;
        const start = base + offset;
        const end = length ? start + length : source.length;
        if (method > 1 || end > source.length) throw new DecodeError("heif-metadata-invalid");
        parts.push(source.subarray(start, end));
      }
      data.set(id, parts.length === 1 ? parts[0]! : concat(parts));
    }
  }
  // Properties and their associations.
  const iprp = find("iprp");
  const ipco = iprp ? children(view, iprp.start, iprp.end, budget).find((b) => b.type === "ipco") : undefined;
  const ipma = iprp ? children(view, iprp.start, iprp.end, budget).filter((b) => b.type === "ipma") : [];
  const properties = ipco ? children(view, ipco.start, ipco.end, budget) : [];
  const associations = new Map<number, HeifProperty[]>();
  for (const box of ipma) {
    reader = box.start;
    const version = u(8);
    const flags = (u(8) << 16) | u(16);
    const count = u(32);
    for (let i = 0; i < count; i++) {
      const id = version < 1 ? u(16) : u(32);
      const n = u(8);
      const list: HeifProperty[] = [];
      for (let k = 0; k < n; k++) {
        const index = flags & 1 ? u(16) & 0x7fff : u(8) & 0x7f;
        const property = properties[index - 1];
        if (property) list.push(property);
      }
      associations.set(id, list);
    }
  }
  // References: grid tiles and thumbnails.
  const references = new Map<string, Map<number, number[]>>();
  const iref = find("iref");
  if (iref) {
    reader = iref.start;
    const version = u(8);
    reader += 3;
    for (const box of children(view, reader, iref.end, budget)) {
      reader = box.start;
      const from = version ? u(32) : u(16);
      const count = u(16);
      const to = Array.from({ length: count }, () => (version ? u(32) : u(16)));
      const map = references.get(box.type) ?? new Map<number, number[]>();
      map.set(from, to);
      references.set(box.type, map);
    }
  }
  const item = (id: number): HeifItem => ({ id, type: types.get(id) ?? "", data: data.get(id) ?? new Uint8Array(), properties: associations.get(id) ?? [] });
  const primary = item(primaryId);
  const property = (target: HeifItem, type: string) => target.properties.find((p) => p.type === type);
  const ispe = property(primary, "ispe");
  if (!ispe || ispe.end - ispe.start < 12) throw new DecodeError("heif-no-dimensions");
  const width = view.getUint32(ispe.start + 4);
  const height = view.getUint32(ispe.start + 8);
  if (!width || !height) throw new DecodeError("heif-dimensions-invalid");
  let grid: HeifImage["grid"];
  let tiles = [primary];
  if (primary.type === "grid") {
    const d = primary.data;
    if (d.length < 8) throw new DecodeError("heif-metadata-invalid");
    grid = { rows: d[2]! + 1, columns: d[3]! + 1 };
    tiles = (references.get("dimg")?.get(primaryId) ?? []).map(item);
    if (tiles.length !== grid.rows * grid.columns) throw new DecodeError("heif-metadata-invalid");
  }
  const irot = property(primary, "irot");
  const imir = property(primary, "imir");
  const coded = tiles[0]!;
  const hvcC = property(coded, "hvcC");
  const av1C = property(coded, "av1C");
  const config = hvcC ? bytes.slice(hvcC.start, hvcC.end) : av1C ? bytes.slice(av1C.start, av1C.end) : undefined;
  const thumbId = [...(references.get("thmb") ?? [])].find(([, to]) => to.includes(primaryId))?.[0];
  const exifId = [...(references.get("cdsc") ?? [])].find(([from, to]) => types.get(from) === "Exif" && to.includes(primaryId))?.[0];
  const colr = property(primary, "colr") ?? property(coded, "colr");
  return {
    brand: fourcc(view, ftyp.start),
    width,
    height,
    rotation: irot ? ((((4 - (view.getUint8(irot.start) & 3)) % 4) * 90) as 0 | 90 | 180 | 270) : 0,
    mirror: imir ? ((view.getUint8(imir.start) & 1) as 0 | 1) : undefined,
    displayP3: colr ? colorIsDisplayP3(view, colr) : false,
    primary,
    tiles,
    grid,
    codec: hvcC ? hevcCodec(bytes.subarray(hvcC.start, hvcC.end)) : av1C ? av1Codec(bytes.subarray(av1C.start, av1C.end)) : undefined,
    config,
    thumbnail: thumbId === undefined ? undefined : item(thumbId),
    exif: exifId === undefined ? undefined : data.get(exifId),
  };
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** ISO/IEC 14496-15 annex E codec parameters from an HEVCDecoderConfigurationRecord. */
export function hevcCodec(record: Uint8Array) {
  const space = ["", "A", "B", "C"][record[1]! >> 6]!;
  const tier = record[1]! & 0x20 ? "H" : "L";
  const profile = record[1]! & 0x1f;
  let flags = ((record[2]! << 24) | (record[3]! << 16) | (record[4]! << 8) | record[5]!) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++, flags >>>= 1) reversed = ((reversed << 1) | (flags & 1)) >>> 0;
  const constraints = Array.from(record.subarray(6, 12));
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  return [`hvc1`, `${space}${profile}`, reversed.toString(16).toUpperCase(), `${tier}${record[12]}`, ...constraints.map((b) => b.toString(16).toUpperCase())].join(".");
}

function av1Codec(record: Uint8Array) {
  const profile = record[1]! >> 5;
  const level = record[1]! & 31;
  const tier = record[2]! & 0x80 ? "H" : "M";
  const depth = record[2]! & 0x40 ? (profile === 2 && record[2]! & 0x20 ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}

// D50-adapted Display P3 primaries, as an ICC profile's rXYZ, gXYZ and bXYZ tags carry them.
const DISPLAY_P3_ICC_PRIMARIES = [
  [0x7258595a, 0.5151, 0.2412, -0.0011],
  [0x6758595a, 0.292, 0.6922, 0.0419],
  [0x6258595a, 0.1571, 0.0666, 0.7841],
] as const;

/** `colr` is an nclx code point (12 is Display P3) or an embedded ICC profile. */
function colorIsDisplayP3(view: DataView, box: HeifProperty) {
  if (box.start + 6 > box.end) return false;
  const kind = view.getUint32(box.start);
  if (kind === 0x6e636c78) return view.getUint16(box.start + 4) === 12;
  return (kind === 0x70726f66 || kind === 0x72494343) && iccProfileIsDisplayP3(view, box.start + 4, box.end);
}

export function iccProfileIsDisplayP3(view: DataView, start: number, end: number): boolean {
  if (start + 132 > end) return false;
  const tagCount = Math.min(view.getUint32(start + 128), Math.floor((end - start - 132) / 12));
  let matched = 0;
  for (let index = 0; index < tagCount; index++) {
    const entry = start + 132 + index * 12;
    const primary = DISPLAY_P3_ICC_PRIMARIES.find(([signature]) => signature === view.getUint32(entry));
    if (!primary) continue;
    const tag = start + view.getUint32(entry + 4);
    if (tag < start || tag + 20 > end || view.getUint32(tag) !== 0x58595a20) return false;
    for (let axis = 0; axis < 3; axis++)
      if (Math.abs(view.getInt32(tag + 8 + axis * 4) / 65536 - primary[axis + 1]!) > 0.005) return false;
    matched++;
  }
  return matched === DISPLAY_P3_ICC_PRIMARIES.length;
}

/** The largest JPEG embedded in an Exif payload: the camera's preview thumbnail. */
export function exifThumbnail(exif: Uint8Array) {
  // The last end-of-image marker closes the first start that precedes it: one pass each way.
  let end = exif.length - 2;
  while (end > 0 && !(exif[end] === 0xff && exif[end + 1] === 0xd9)) end--;
  for (let start = 0; start + 3 < exif.length && start < end; start++)
    if (exif[start] === 0xff && exif[start + 1] === 0xd8 && exif[start + 2] === 0xff) return exif.subarray(start, end + 2);
  return undefined;
}

async function decodeTiles(image: HeifImage) {
  if (!image.codec || !image.config || typeof VideoDecoder === "undefined") return undefined;
  const config = { codec: image.codec, description: image.config, optimizeForLatency: true };
  if (!(await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported) return undefined;
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d")!;
  const columns = image.grid?.columns ?? 1;
  let decoded = 0;
  let failure: unknown;
  // Each tile is drawn and released as it arrives, so at most one decoded frame is alive at a time.
  const decoder = new VideoDecoder({
    output: (frame) => {
      const index = frame.timestamp;
      context.drawImage(frame, (index % columns) * frame.displayWidth, Math.floor(index / columns) * frame.displayHeight);
      frame.close();
      decoded++;
    },
    error: (cause) => (failure = cause),
  });
  try {
    decoder.configure(config);
    image.tiles.forEach((tile, index) => decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: index, data: tile.data })));
    await decoder.flush();
    if (failure || decoded !== image.tiles.length) throw failure ?? new DecodeError("image-decode-failed");
    return canvas;
  } catch (cause) {
    canvas.width = canvas.height = 0;
    throw cause;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
}

function orientCanvas(source: OffscreenCanvas, image: HeifImage) {
  if (image.rotation === 0 && image.mirror === undefined) return source.transferToImageBitmap();
  const swap = image.rotation === 90 || image.rotation === 270;
  const canvas = new OffscreenCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const context = canvas.getContext("2d")!;
  context.translate(canvas.width / 2, canvas.height / 2);
  if (image.mirror !== undefined) context.scale(image.mirror === 0 ? -1 : 1, image.mirror === 1 ? -1 : 1);
  context.rotate((image.rotation * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  source.width = source.height = 0;
  return canvas.transferToImageBitmap();
}

/**
 * Decodes the primary image: the browser's own HEIF support first, then WebCodecs over the coded tiles,
 * then the embedded JPEG thumbnail. `native` is false where color profiles were not applied.
 */
export async function decodeHeif(buffer: ArrayBuffer, image = parseHeif(buffer)): Promise<{ bitmap: ImageBitmap; native: boolean; image: HeifImage }> {
  const native = await createImageBitmap(new Blob([buffer], { type: "image/heic" })).catch(() => undefined);
  if (native) return { bitmap: native, native: true, image };
  const tiles = await decodeTiles(image).catch(() => undefined);
  if (tiles) return { bitmap: orientCanvas(tiles, image), native: false, image };
  const jpeg = image.thumbnail?.type === "jpeg" ? image.thumbnail.data : image.exif ? exifThumbnail(image.exif) : undefined;
  if (jpeg) {
    const bitmap = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).catch(() => undefined);
    if (bitmap) return { bitmap, native: false, image };
  }
  throw new DecodeError("image-decoding-unavailable");
}
