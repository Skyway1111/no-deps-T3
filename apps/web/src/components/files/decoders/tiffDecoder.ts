import type { PreviewFailureCode } from "../previewFailureMessages";

/** A decoder failure the preview window can translate. */
export class DecodeError extends Error {
  readonly code: PreviewFailureCode;
  constructor(code: PreviewFailureCode) {
    super(code);
    this.code = code;
  }
}

export const MAX_IMAGE_PIXELS = 32_000_000;
export function checkImageSize(width: number, height: number) {
  if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width > MAX_IMAGE_PIXELS / height)
    throw new DecodeError("image-too-large");
}

export type TiffIfd = {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number;
  readonly samplesPerPixel: number;
  readonly photometric: number;
  readonly compression: number;
  readonly predictor: number;
  readonly planar: number;
  readonly orientation: number;
  readonly extraSamples: readonly number[];
  readonly palette: Uint16Array | undefined;
  readonly sampleFormat: number;
  /** Strip or tile chunks, with the size of the image region each covers. */
  readonly chunks: readonly { offset: number; length: number }[];
  readonly chunkWidth: number;
  readonly chunkHeight: number;
  readonly tiled: boolean;
};

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];

/** Reads the first image's directory, bounding every count and offset by the file. */
export function readTiff(buffer: ArrayBuffer): TiffIfd {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8) throw new DecodeError("tiff-metadata-invalid");
  const order = view.getUint16(0);
  const le = order === 0x4949;
  if ((order !== 0x4949 && order !== 0x4d4d) || view.getUint16(2, le) !== 42) throw new DecodeError("tiff-metadata-invalid");
  const ifd = view.getUint32(4, le);
  if (ifd < 8 || ifd + 2 > buffer.byteLength) throw new DecodeError("tiff-metadata-invalid");
  const count = view.getUint16(ifd, le);
  if (count > 2048 || ifd + 2 + count * 12 > buffer.byteLength) throw new DecodeError("tiff-metadata-truncated");
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const values = view.getUint32(entry + 4, le);
    const width = TYPE_SIZE[type];
    if (!width) throw new DecodeError("tiff-metadata-type");
    if (values > 1 << 20) throw new DecodeError("tiff-metadata-truncated");
    const length = values * width;
    const start = length > 4 ? view.getUint32(entry + 8, le) : entry + 8;
    if (start + length > buffer.byteLength) throw new DecodeError("tiff-metadata-truncated");
    // Only numeric tags the decoder reads; strings and rationals are skipped.
    if (![1, 3, 4, 6, 8, 9].includes(type)) continue;
    const read = (k: number) => {
      const at = start + k * width;
      return type === 3 ? view.getUint16(at, le) : type === 8 ? view.getInt16(at, le) : type === 4 ? view.getUint32(at, le) : type === 9 ? view.getInt32(at, le) : type === 6 ? view.getInt8(at) : view.getUint8(at);
    };
    tags.set(tag, Array.from({ length: values }, (_, k) => read(k)));
  }
  const one = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;
  const width = one(256, 0);
  const height = one(257, 0);
  checkImageSize(width, height);
  const bitsPerSample = one(258, 1);
  const samplesPerPixel = one(277, 1);
  if ((tags.get(258) ?? []).some((bits) => bits !== bitsPerSample)) throw new DecodeError("tiff-color-format");
  const tiled = tags.has(324);
  const offsets = tags.get(tiled ? 324 : 273) ?? [];
  const lengths = tags.get(tiled ? 325 : 279) ?? [];
  if (!offsets.length || offsets.length > 65536 || lengths.length !== offsets.length) throw new DecodeError("tiff-strip-layout");
  const chunks = offsets.map((offset, i) => {
    const length = lengths[i]!;
    if (offset < 0 || length < 0 || offset + length > buffer.byteLength) throw new DecodeError("tiff-strip-invalid");
    return { offset, length };
  });
  const colorMap = tags.get(320);
  return {
    width,
    height,
    bitsPerSample,
    samplesPerPixel,
    photometric: one(262, samplesPerPixel >= 3 ? 2 : 1),
    compression: one(259, 1),
    predictor: one(317, 1),
    planar: one(284, 1),
    orientation: one(274, 1),
    extraSamples: tags.get(338) ?? [],
    palette: colorMap ? Uint16Array.from(colorMap) : undefined,
    sampleFormat: one(339, 1),
    chunks,
    chunkWidth: tiled ? one(322, 0) : width,
    chunkHeight: tiled ? one(323, 0) : Math.min(one(278, height), height),
    tiled,
  };
}

/** TIFF LZW (MSB-first, early change), writing at most `limit` bytes. */
export function lzwDecode(input: Uint8Array, limit: number) {
  const out = new Uint8Array(limit);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    length[i] = 1;
  }
  let bits = 9;
  let next = 258;
  let previous = -1;
  let written = 0;
  let bitPos = 0;
  const total = input.length * 8;
  const emit = (code: number) => {
    const size = length[code]!;
    const end = Math.min(written + size, limit);
    for (let k = size - 1, c = code; k >= 0; k--, c = prefix[c]!) if (written + k < end) out[written + k] = suffix[c]!;
    written = end;
  };
  while (bitPos + bits <= total && written < limit) {
    let code = 0;
    for (let i = 0; i < bits; i++, bitPos++) code = (code << 1) | ((input[bitPos >> 3]! >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = -1;
      continue;
    }
    if (previous < 0) {
      if (code > 255) throw new DecodeError("tiff-lzw-invalid");
      emit(code);
      previous = code;
      continue;
    }
    if (code > next || next >= 4096) throw new DecodeError("tiff-lzw-invalid");
    // The new entry is the previous string plus the first byte of the current (or, for KwKwK, previous) string.
    let first = code === next ? previous : code;
    while (length[first]! > 1) first = prefix[first]!;
    prefix[next] = previous;
    suffix[next] = suffix[first]!;
    length[next] = length[previous]! + 1;
    next++;
    emit(code);
    previous = code;
    if (next + 1 >= 1 << bits && bits < 12) bits++;
  }
  return out.subarray(0, written);
}

export function packBitsDecode(input: Uint8Array, limit: number) {
  const out = new Uint8Array(limit);
  let written = 0;
  for (let i = 0; i < input.length && written < limit; ) {
    const n = (input[i++]! << 24) >> 24;
    if (n >= 0) {
      const count = Math.min(n + 1, limit - written, input.length - i);
      out.set(input.subarray(i, i + count), written);
      written += count;
      i += n + 1;
    } else if (n !== -128) {
      const count = Math.min(1 - n, limit - written);
      out.fill(input[i++] ?? 0, written, written + count);
      written += count;
    }
  }
  return out.subarray(0, written);
}

async function inflate(input: Uint8Array, limit: number) {
  const reader = new Blob([input as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const out = new Uint8Array(limit);
  let written = 0;
  try {
    while (written < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, limit - written);
      out.set(value.subarray(0, take), written);
      written += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, written);
}

async function decompress(ifd: TiffIfd, input: Uint8Array, limit: number) {
  switch (ifd.compression) {
    case 1:
      return input.slice(0, limit);
    case 5:
      return lzwDecode(input, limit);
    case 8:
    case 32946:
      return inflate(input, limit);
    case 32773:
      return packBitsDecode(input, limit);
    default:
      throw new DecodeError("tiff-compression");
  }
}

/** Decodes the first image to straight RGBA, applying predictors, palettes, alpha and orientation. */
export async function decodeTiff(buffer: ArrayBuffer) {
  const ifd = readTiff(buffer);
  const { width, height, bitsPerSample: bps, samplesPerPixel: spp, photometric } = ifd;
  if (![1, 2, 4, 8, 16].includes(bps) || ifd.sampleFormat > 2 || ![0, 1, 2, 3, 5].includes(photometric) || spp < 1 || spp > 5)
    throw new DecodeError("tiff-color-format");
  if (ifd.predictor !== 1 && ifd.predictor !== 2) throw new DecodeError("tiff-compression");
  if (ifd.tiled && (bps < 8 || !ifd.chunkWidth || !ifd.chunkHeight)) throw new DecodeError("tiff-strip-layout");
  const planar = ifd.planar === 2 && spp > 1;
  const planes = planar ? spp : 1;
  const perPlane = planar ? 1 : spp;
  const le = new DataView(buffer).getUint16(0) === 0x4949;
  const rowBytes = Math.ceil((width * perPlane * bps) / 8);
  const raw = Array.from({ length: planes }, () => new Uint8Array(rowBytes * height));
  const across = Math.ceil(width / ifd.chunkWidth);
  const down = Math.ceil(height / ifd.chunkHeight);
  const perPlaneChunks = across * down;
  if (ifd.chunks.length < perPlaneChunks * planes) throw new DecodeError("tiff-strip-layout");
  const chunkRowBytes = Math.ceil((ifd.chunkWidth * perPlane * bps) / 8);
  const chunkLimit = chunkRowBytes * ifd.chunkHeight;
  let expanded = 0;
  for (let plane = 0; plane < planes; plane++)
    for (let index = 0; index < perPlaneChunks; index++) {
      const { offset, length } = ifd.chunks[plane * perPlaneChunks + index]!;
      expanded += chunkLimit;
      if (expanded > 256 * 1024 * 1024) throw new DecodeError("tiff-data-too-large");
      const data = await decompress(ifd, new Uint8Array(buffer, offset, length), chunkLimit);
      const tx = index % across;
      const ty = Math.floor(index / across);
      const rows = Math.min(ifd.chunkHeight, height - ty * ifd.chunkHeight);
      for (let r = 0; r < rows; r++) {
        const row = data.subarray(r * chunkRowBytes, (r + 1) * chunkRowBytes);
        if (ifd.predictor === 2) undoPredictor(row, perPlane, bps, le);
        const y = ty * ifd.chunkHeight + r;
        const start = y * rowBytes + (tx * chunkRowBytes);
        const take = Math.min(row.length, rowBytes - tx * chunkRowBytes);
        if (take > 0) raw[plane]!.set(row.subarray(0, take), start);
      }
    }
  // Sample reader over the decoded planes.
  const sample = (x: number, y: number, s: number) => {
    const plane = planar ? s : 0;
    const index = planar ? x : x * spp + s;
    const data = raw[plane]!;
    const base = y * rowBytes;
    if (bps === 8) return data[base + index]!;
    if (bps === 16) {
      const at = base + index * 2;
      return (le ? data[at + 1]! : data[at]!) | 0;
    }
    const bit = index * bps;
    const byte = data[base + (bit >> 3)]!;
    return (byte >> (8 - bps - (bit & 7))) & ((1 << bps) - 1);
  };
  const toByte = bps === 16 || bps === 8 ? (v: number) => v : (v: number) => Math.round((v * 255) / ((1 << bps) - 1));
  const colors = photometric === 2 ? 3 : photometric === 5 ? 4 : 1;
  const alphaSample = spp > colors ? colors : -1;
  const premultiplied = ifd.extraSamples[0] === 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const palette = ifd.palette;
  if (photometric === 3 && (!palette || palette.length < 3 * (1 << bps))) throw new DecodeError("tiff-color-format");
  // Common 8-bit chunky gray and RGB(A) copy bytes straight through; rows hold `spp` bytes per pixel, unpadded.
  if (bps === 8 && !planar && (photometric === 1 || photometric === 2) && !(premultiplied && alphaSample >= 0)) {
    const data = raw[0]!;
    const rgb = photometric === 2;
    for (let p = 0, i = 0, o = 0; p < width * height; p++, i += spp, o += 4) {
      rgba[o] = data[i]!;
      rgba[o + 1] = data[rgb ? i + 1 : i]!;
      rgba[o + 2] = data[rgb ? i + 2 : i]!;
      rgba[o + 3] = alphaSample >= 0 ? data[i + alphaSample]! : 255;
    }
    return { ...orient(rgba, width, height, ifd.orientation), alpha: alphaSample >= 0 };
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (photometric === 3) {
        const v = sample(x, y, 0);
        const n = 1 << bps;
        rgba[o] = palette![v]! >> 8;
        rgba[o + 1] = palette![n + v]! >> 8;
        rgba[o + 2] = palette![2 * n + v]! >> 8;
      } else if (photometric === 2) {
        rgba[o] = toByte(sample(x, y, 0));
        rgba[o + 1] = toByte(sample(x, y, 1));
        rgba[o + 2] = toByte(sample(x, y, 2));
      } else if (photometric === 5) {
        const k = 255 - toByte(sample(x, y, 3));
        rgba[o] = ((255 - toByte(sample(x, y, 0))) * k) / 255;
        rgba[o + 1] = ((255 - toByte(sample(x, y, 1))) * k) / 255;
        rgba[o + 2] = ((255 - toByte(sample(x, y, 2))) * k) / 255;
      } else {
        const g = toByte(sample(x, y, 0));
        rgba.fill(photometric === 0 ? 255 - g : g, o, o + 3);
      }
      const a = alphaSample >= 0 ? toByte(sample(x, y, alphaSample)) : 255;
      rgba[o + 3] = a;
      if (premultiplied && a && a < 255) for (let c = 0; c < 3; c++) rgba[o + c] = (rgba[o + c]! * 255) / a;
    }
  return { ...orient(rgba, width, height, ifd.orientation), alpha: alphaSample >= 0 };
}

function undoPredictor(row: Uint8Array, samples: number, bps: number, le: boolean) {
  if (bps === 8) for (let i = samples; i < row.length; i++) row[i] = (row[i]! + row[i - samples]!) & 255;
  else if (bps === 16) {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
    for (let i = samples * 2; i + 1 < row.length; i += 2)
      view.setUint16(i, (view.getUint16(i, le) + view.getUint16(i - samples * 2, le)) & 0xffff, le);
  }
}

/** Applies EXIF-style orientation 1–8 to an RGBA buffer. */
function orient(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, orientation: number) {
  if (orientation <= 1 || orientation > 8) return { width, height, data: rgba };
  const swap = orientation >= 5;
  const [w, h] = swap ? [height, width] : [width, height];
  const out = new Uint8ClampedArray(rgba.length);
  const source = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const target = new Uint32Array(out.buffer);
  // Pixel (x, y) lands at start + x * dx + y * dy in the oriented image.
  const [start, dx, dy] = (
    {
      2: [width - 1, -1, w],
      3: [(height - 1) * w + width - 1, -1, -w],
      4: [(height - 1) * w, 1, -w],
      5: [0, w, 1],
      6: [height - 1, w, -1],
      7: [(width - 1) * w + height - 1, -w, -1],
      8: [(width - 1) * w, -w, 1],
    } as Record<number, [number, number, number]>
  )[orientation]!;
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0, at = start + y * dy; x < width; x++, i++, at += dx) target[at] = source[i]!;
  return { width: w, height: h, data: out };
}
