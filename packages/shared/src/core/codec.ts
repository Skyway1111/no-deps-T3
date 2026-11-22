/**
 * Zero-dependency runtime codec/validator + compact binary/JSON wire framing.
 *
 * Binary frame layout (6-byte header, big-endian):
 *   [0]     magic byte 0x54 ('T' - never a valid JSON start byte)
 *   [1]     FrameTag (Json=1, Utf8=2, Binary=3, Batch=4, Ping=5, Pong=6)
 *   [2..5]  uint32 payload byte length
 *   [6..N]  payload bytes
 */

export const WIRE_FRAME_QUERY_PARAM = "wireFrame";
export const WIRE_FRAME_MAGIC = 0x54;
export const WIRE_FRAME_HEADER_BYTES = 6;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export const FrameTag = {
  Json: 0x01,
  Utf8: 0x02,
  Binary: 0x03,
  Batch: 0x04,
  Ping: 0x05,
  Pong: 0x06,
} as const;

export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag];

const VALID_FRAME_TAGS = new Set<number>(Object.values(FrameTag));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WireFrameError extends Error {
  readonly code: "invalid_magic" | "invalid_tag" | "truncated" | "limit_exceeded";

  constructor(
    code: "invalid_magic" | "invalid_tag" | "truncated" | "limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "WireFrameError";
    this.code = code;
  }
}

export interface DecodedFrame {
  readonly format: "binary" | "json";
  readonly tag: FrameTag;
  readonly payload: Uint8Array | string;
}

export function isBinaryFrame(input: Uint8Array | string): input is Uint8Array {
  return (
    input instanceof Uint8Array &&
    input.byteLength >= WIRE_FRAME_HEADER_BYTES &&
    input[0] === WIRE_FRAME_MAGIC
  );
}

function payloadToBytes(tag: FrameTag, payload: unknown): Uint8Array {
  if (payload === undefined) return new Uint8Array(0);
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return textEncoder.encode(payload);
  if (tag === FrameTag.Json) return textEncoder.encode(JSON.stringify(payload));
  throw new TypeError("Unsupported frame payload type");
}

function writeHeader(buf: Uint8Array, offset: number, tag: FrameTag, len: number): void {
  buf[offset] = WIRE_FRAME_MAGIC;
  buf[offset + 1] = tag;
  buf[offset + 2] = (len >>> 24) & 0xff;
  buf[offset + 3] = (len >>> 16) & 0xff;
  buf[offset + 4] = (len >>> 8) & 0xff;
  buf[offset + 5] = len & 0xff;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

export function encodeFrame(tag: FrameTag, payload?: string | Uint8Array | unknown): Uint8Array {
  if (typeof payload === "string") {
    // Fast single-allocation UTF-8 encode for typical ASCII-dominant JSON RPC frames.
    const maxBytes = payload.length * 3;
    const out = new Uint8Array(WIRE_FRAME_HEADER_BYTES + maxBytes);
    const { written } = textEncoder.encodeInto(payload, out.subarray(WIRE_FRAME_HEADER_BYTES));
    writeHeader(out, 0, tag, written);
    return out.subarray(0, WIRE_FRAME_HEADER_BYTES + written);
  }
  const bytes = payloadToBytes(tag, payload);
  const out = new Uint8Array(WIRE_FRAME_HEADER_BYTES + bytes.byteLength);
  writeHeader(out, 0, tag, bytes.byteLength);
  if (bytes.byteLength > 0) out.set(bytes, WIRE_FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(
  input: Uint8Array | string,
  options?: { readonly maxBytes?: number; readonly decodeText?: boolean },
): DecodedFrame {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (typeof input === "string") {
    return { format: "json", tag: FrameTag.Json, payload: input };
  }
  if (!isBinaryFrame(input)) {
    if (input.byteLength > maxBytes) {
      throw new WireFrameError("limit_exceeded", `Frame exceeds maxBytes (${maxBytes})`);
    }
    return {
      format: "json",
      tag: FrameTag.Json,
      payload: options?.decodeText ? textDecoder.decode(input) : input,
    };
  }
  const tag = input[1]!;
  if (!VALID_FRAME_TAGS.has(tag)) {
    throw new WireFrameError("invalid_tag", `Unknown wire frame tag: 0x${tag.toString(16)}`);
  }
  const len = readUint32BE(input, 2);
  if (len > maxBytes) {
    throw new WireFrameError("limit_exceeded", `Frame payload (${len}) exceeds maxBytes (${maxBytes})`);
  }
  if (input.byteLength < WIRE_FRAME_HEADER_BYTES + len) {
    throw new WireFrameError(
      "truncated",
      `Truncated wire frame: expected ${WIRE_FRAME_HEADER_BYTES + len} bytes, got ${input.byteLength}`,
    );
  }
  const slice = input.subarray(WIRE_FRAME_HEADER_BYTES, WIRE_FRAME_HEADER_BYTES + len);
  const typedTag = tag as FrameTag;
  const payload =
    options?.decodeText && (typedTag === FrameTag.Json || typedTag === FrameTag.Utf8)
      ? textDecoder.decode(slice)
      : slice;
  return { format: "binary", tag: typedTag, payload };
}

export function encodeBatch(
  frames: ReadonlyArray<{ readonly tag: FrameTag; readonly payload?: string | Uint8Array | unknown }>,
): Uint8Array {
  const encoded: Array<{ readonly tag: FrameTag; readonly bytes: Uint8Array }> = [];
  let totalPayloadBytes = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const bytes = payloadToBytes(frame.tag, frame.payload);
    encoded.push({ tag: frame.tag, bytes });
    totalPayloadBytes += 5 + bytes.byteLength;
  }
  const out = new Uint8Array(WIRE_FRAME_HEADER_BYTES + totalPayloadBytes);
  writeHeader(out, 0, FrameTag.Batch, totalPayloadBytes);
  let offset = WIRE_FRAME_HEADER_BYTES;
  for (let i = 0; i < encoded.length; i++) {
    const item = encoded[i]!;
    const len = item.bytes.byteLength;
    out[offset] = item.tag;
    out[offset + 1] = (len >>> 24) & 0xff;
    out[offset + 2] = (len >>> 16) & 0xff;
    out[offset + 3] = (len >>> 8) & 0xff;
    out[offset + 4] = len & 0xff;
    offset += 5;
    if (len > 0) {
      out.set(item.bytes, offset);
      offset += len;
    }
  }
  return out;
}

export function decodeBatch(
  input: Uint8Array,
  options?: { readonly maxBytes?: number; readonly decodeText?: boolean },
): ReadonlyArray<DecodedFrame> {
  const outer = decodeFrame(input, options);
  if (outer.tag !== FrameTag.Batch || typeof outer.payload === "string") {
    return [outer];
  }
  const body = outer.payload;
  const out: Array<DecodedFrame> = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (offset + 5 > body.byteLength) {
      throw new WireFrameError("truncated", "Truncated batch sub-frame header");
    }
    const tag = body[offset]!;
    if (!VALID_FRAME_TAGS.has(tag)) {
      throw new WireFrameError("invalid_tag", `Unknown batch sub-frame tag: 0x${tag.toString(16)}`);
    }
    const len = readUint32BE(body, offset + 1);
    offset += 5;
    if (offset + len > body.byteLength) {
      throw new WireFrameError("truncated", "Truncated batch sub-frame payload");
    }
    const slice = body.subarray(offset, offset + len);
    offset += len;
    const typedTag = tag as FrameTag;
    const payload =
      options?.decodeText && (typedTag === FrameTag.Json || typedTag === FrameTag.Utf8)
        ? textDecoder.decode(slice)
        : slice;
    out.push({ format: "binary", tag: typedTag, payload });
  }
  return out;
}

export function encodeWireChunk(chunk: string | Uint8Array): Uint8Array {
  return encodeFrame(typeof chunk === "string" ? FrameTag.Json : FrameTag.Binary, chunk);
}

export function encodeWireChunks(chunks: Iterable<string | Uint8Array>): Uint8Array | null {
  const list = Array.isArray(chunks) ? (chunks as ReadonlyArray<string | Uint8Array>) : Array.from(chunks);
  if (list.length === 0) return null;
  if (list.length === 1) return encodeWireChunk(list[0]!);
  return encodeBatch(
    list.map((chunk) => ({
      tag: typeof chunk === "string" ? FrameTag.Json : FrameTag.Binary,
      payload: chunk,
    })),
  );
}

export function decodeWireChunks<T extends ReadonlyArray<string | Uint8Array>>(chunks: T): T {
  let hasBinary = false;
  for (let i = 0; i < chunks.length; i++) {
    if (isBinaryFrame(chunks[i]!)) {
      hasBinary = true;
      break;
    }
  }
  if (!hasBinary) return chunks;
  const out: Array<string | Uint8Array> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (typeof chunk === "string" || !isBinaryFrame(chunk)) {
      out.push(chunk);
      continue;
    }
    const decoded = decodeFrame(chunk, { decodeText: true });
    if (decoded.tag === FrameTag.Batch) {
      for (const sub of decodeBatch(chunk, { decodeText: true })) out.push(sub.payload);
    } else {
      out.push(decoded.payload);
    }
  }
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Zero-dependency runtime codec / validator (replaces Zod on hot paths)
// ---------------------------------------------------------------------------

export class CodecError extends Error {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${path}: ${message}`);
    this.name = "CodecError";
    this.path = path;
  }
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CodecError };

export interface Codec<T> {
  readonly name: string;
  readonly check: (value: unknown) => value is T;
  readonly decode: (value: unknown, path?: string) => T;
  readonly safeDecode: (value: unknown) => DecodeResult<T>;
}

export type Infer<C extends Codec<unknown>> = C extends Codec<infer T> ? T : never;

function makeCodec<T>(
  name: string,
  check: (value: unknown) => value is T,
  decode?: (value: unknown, path: string) => T,
): Codec<T> {
  const runDecode =
    decode ??
    ((value: unknown, path: string): T => {
      if (check(value)) return value;
      throw new CodecError(`Expected ${name}`, path);
    });
  return {
    name,
    check,
    decode: (value, path = "$") => runDecode(value, path),
    safeDecode: (value) => {
      try {
        return { ok: true, value: runDecode(value, "$") };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof CodecError ? error : new CodecError(String(error)),
        };
      }
    },
  };
}

export const c = {
  string: makeCodec<string>("string", (v): v is string => typeof v === "string"),
  number: makeCodec<number>("number", (v): v is number => typeof v === "number" && !Number.isNaN(v)),
  finiteNumber: makeCodec<number>(
    "finite number",
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  ),
  integer: makeCodec<number>(
    "integer",
    (v): v is number => typeof v === "number" && Number.isSafeInteger(v),
  ),
  boolean: makeCodec<boolean>("boolean", (v): v is boolean => typeof v === "boolean"),
  null_: makeCodec<null>("null", (v): v is null => v === null),
  unknown: makeCodec<unknown>("unknown", (_v): _v is unknown => true),
  bytes: makeCodec<Uint8Array>("Uint8Array", (v): v is Uint8Array => v instanceof Uint8Array),

  literal<const T extends string | number | boolean>(expected: T): Codec<T> {
    return makeCodec<T>(JSON.stringify(expected), (v): v is T => v === expected);
  },

  literals<const T extends readonly (string | number | boolean)[]>(
    ...values: T
  ): Codec<T[number]> {
    const allowed = new Set<unknown>(values);
    return makeCodec<T[number]>(
      values.map((v) => JSON.stringify(v)).join(" | "),
      (v): v is T[number] => allowed.has(v),
    );
  },

  optional<T>(inner: Codec<T>): Codec<T | undefined> {
    return makeCodec<T | undefined>(
      `${inner.name} | undefined`,
      (v): v is T | undefined => v === undefined || inner.check(v),
      (v, path) => (v === undefined ? undefined : inner.decode(v, path)),
    );
  },

  nullable<T>(inner: Codec<T>): Codec<T | null> {
    return makeCodec<T | null>(
      `${inner.name} | null`,
      (v): v is T | null => v === null || inner.check(v),
      (v, path) => (v === null ? null : inner.decode(v, path)),
    );
  },

  array<T>(item: Codec<T>): Codec<Array<T>> {
    return makeCodec<Array<T>>(
      `${item.name}[]`,
      (v): v is Array<T> => Array.isArray(v) && v.every(item.check),
      (v, path) => {
        if (!Array.isArray(v)) throw new CodecError("Expected array", path);
        const out = new Array<T>(v.length);
        for (let i = 0; i < v.length; i++) {
          out[i] = item.decode(v[i], `${path}[${i}]`);
        }
        return out;
      },
    );
  },

  record<T>(value: Codec<T>): Codec<Record<string, T>> {
    return makeCodec<Record<string, T>>(
      `Record<string, ${value.name}>`,
      (v): v is Record<string, T> => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
        for (const entry of Object.values(v as Record<string, unknown>)) {
          if (!value.check(entry)) return false;
        }
        return true;
      },
      (v, path) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new CodecError("Expected object", path);
        }
        const src = v as Record<string, unknown>;
        const out: Record<string, T> = {};
        for (const key of Object.keys(src)) {
          out[key] = value.decode(src[key], `${path}.${key}`);
        }
        return out;
      },
    );
  },

  object<Shape extends Record<string, Codec<unknown>>>(
    shape: Shape,
  ): Codec<{ [K in keyof Shape]: Infer<Shape[K]> }> {
    const entries = Object.entries(shape);
    type Out = { [K in keyof Shape]: Infer<Shape[K]> };
    return makeCodec<Out>(
      "object",
      (v): v is Out => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
        const obj = v as Record<string, unknown>;
        for (let i = 0; i < entries.length; i++) {
          const [key, codec] = entries[i]!;
          if (!codec.check(obj[key])) return false;
        }
        return true;
      },
      (v, path) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          throw new CodecError("Expected object", path);
        }
        const src = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (let i = 0; i < entries.length; i++) {
          const [key, codec] = entries[i]!;
          const decoded = codec.decode(src[key], `${path}.${key}`);
          if (decoded !== undefined || Object.hasOwn(src, key)) {
            out[key] = decoded;
          }
        }
        return out as Out;
      },
    );
  },

  union<const Codecs extends readonly [Codec<unknown>, ...Codec<unknown>[]]>(
    ...codecs: Codecs
  ): Codec<Infer<Codecs[number]>> {
    type Out = Infer<Codecs[number]>;
    return makeCodec<Out>(
      codecs.map((item) => item.name).join(" | "),
      (v): v is Out => codecs.some((item) => item.check(v)),
      (v, path) => {
        for (let i = 0; i < codecs.length; i++) {
          const res = codecs[i]!.safeDecode(v);
          if (res.ok) return res.value as Out;
        }
        throw new CodecError(
          `Expected one of ${codecs.map((item) => item.name).join(" | ")}`,
          path,
        );
      },
    );
  },

  discriminatedUnion<
    TagKey extends string,
    Variants extends Record<string, Codec<unknown>>,
  >(
    tagKey: TagKey,
    variants: Variants,
  ): Codec<Infer<Variants[keyof Variants]>> {
    type Out = Infer<Variants[keyof Variants]>;
    return makeCodec<Out>(
      `union(${tagKey})`,
      (v): v is Out => {
        if (typeof v !== "object" || v === null) return false;
        const tag = (v as Record<string, unknown>)[tagKey];
        if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) return false;
        return variants[tag]!.check(v);
      },
      (v, path) => {
        if (typeof v !== "object" || v === null) {
          throw new CodecError("Expected object", path);
        }
        const tag = (v as Record<string, unknown>)[tagKey];
        if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) {
          throw new CodecError(`Unexpected discriminant "${String(tag)}"`, `${path}.${tagKey}`);
        }
        return variants[tag]!.decode(v, path) as Out;
      },
    );
  },

  refine<T>(inner: Codec<T>, predicate: (value: T) => boolean, message: string): Codec<T> {
    return makeCodec<T>(
      inner.name,
      (v): v is T => inner.check(v) && predicate(v),
      (v, path) => {
        const decoded = inner.decode(v, path);
        if (!predicate(decoded)) throw new CodecError(message, path);
        return decoded;
      },
    );
  },
};
