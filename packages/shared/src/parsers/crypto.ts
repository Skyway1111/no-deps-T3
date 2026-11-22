// Sync digests and P-256 verification for code that runs on every surface: WebCrypto is async
// and React Native has none, so these are pure TypeScript.

export interface Hash {
  update(data: Uint8Array): Hash;
  digest(): Uint8Array<ArrayBuffer>;
}

/** Compresses every 64-byte block in `[offset, end)` of `view` into `state`. */
type Compress = (state: Int32Array, view: DataView, offset: number, end: number) => void;

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

// Hashing is synchronous, so one padding scratch serves every call.
const TAIL = new Uint8Array(128);
const TAIL_VIEW = viewOf(TAIL);

function finish(
  state: Int32Array,
  compress: Compress,
  le: boolean,
  tail: Uint8Array,
  length: number,
) {
  const n = tail.length;
  const end = n < 56 ? 64 : 128;
  TAIL.set(tail);
  TAIL.fill(0, n, end);
  TAIL[n] = 0x80;
  const bits = length * 8;
  TAIL_VIEW.setUint32(le ? end - 8 : end - 4, bits >>> 0, le);
  TAIL_VIEW.setUint32(le ? end - 4 : end - 8, Math.floor(bits / 2 ** 32), le);
  compress(state, TAIL_VIEW, 0, end);
  const out = new Uint8Array(state.length * 4);
  for (let i = 0; i < out.length; i++) out[i] = state[i >> 2]! >>> (8 * (le ? i & 3 : 3 - (i & 3)));
  return out;
}

class MerkleDamgard implements Hash {
  private readonly state: Int32Array;
  private readonly compress: Compress;
  private readonly le: boolean;
  private readonly block = new Uint8Array(64);
  private readonly blockView = viewOf(this.block);
  private buffered = 0;
  private length = 0;

  constructor(init: Int32Array, compress: Compress, le: boolean) {
    this.state = init.slice();
    this.compress = compress;
    this.le = le;
  }

  update(data: Uint8Array): this {
    const { block, state } = this;
    this.length += data.length;
    let offset = 0;
    if (this.buffered > 0) {
      offset = Math.min(64 - this.buffered, data.length);
      block.set(data.subarray(0, offset), this.buffered);
      this.buffered += offset;
      if (this.buffered < 64) return this;
      this.compress(state, this.blockView, 0, 64);
    }
    const full = offset + ((data.length - offset) & ~63);
    if (full > offset) this.compress(state, viewOf(data), offset, full);
    block.set(data.subarray(full));
    this.buffered = data.length - full;
    return this;
  }

  digest() {
    const { state, compress, le, block, buffered, length } = this;
    return finish(state, compress, le, block.subarray(0, buffered), length);
  }
}

const PRIMES = (() => {
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  return primes;
})();
const frac32 = (x: number) => ((x % 1) * 2 ** 32) | 0;
const SHA256_K = Int32Array.from(PRIMES, (p) => frac32(Math.cbrt(p)));
const SHA256_W = new Int32Array(64);
// Small enough for V8 to inline into the unrolled rounds.
const S0 = (x: number) =>
  ((x >>> 2) | (x << 30)) ^ ((x >>> 13) | (x << 19)) ^ ((x >>> 22) | (x << 10));
const S1 = (x: number) =>
  ((x >>> 6) | (x << 26)) ^ ((x >>> 11) | (x << 21)) ^ ((x >>> 25) | (x << 7));
const s0 = (x: number) => ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
const s1 = (x: number) => ((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10);

const sha256Compress: Compress = (s, view, offset, end) => {
  const w = SHA256_W;
  const k = SHA256_K;
  let a = s[0]!,
    b = s[1]!,
    c = s[2]!,
    d = s[3]!,
    e = s[4]!,
    f = s[5]!,
    g = s[6]!,
    h = s[7]!;
  for (; offset < end; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) w[i] = s0(w[i - 15]!) + s1(w[i - 2]!) + w[i - 7]! + w[i - 16]!;
    const a0 = a,
      b0 = b,
      c0 = c,
      d0 = d,
      e0 = e,
      f0 = f,
      g0 = g,
      h0 = h;
    // Four rounds per pass with the registers renamed, then a half rotation.
    for (let i = 0; i < 64; i += 4) {
      h = (h + S1(e) + (g ^ (e & (f ^ g))) + k[i]! + w[i]!) | 0;
      d = (d + h) | 0;
      h = (h + S0(a) + ((a & b) ^ (c & (a ^ b)))) | 0;
      g = (g + S1(d) + (f ^ (d & (e ^ f))) + k[i + 1]! + w[i + 1]!) | 0;
      c = (c + g) | 0;
      g = (g + S0(h) + ((h & a) ^ (b & (h ^ a)))) | 0;
      f = (f + S1(c) + (e ^ (c & (d ^ e))) + k[i + 2]! + w[i + 2]!) | 0;
      b = (b + f) | 0;
      f = (f + S0(g) + ((g & h) ^ (a & (g ^ h)))) | 0;
      e = (e + S1(b) + (d ^ (b & (c ^ d))) + k[i + 3]! + w[i + 3]!) | 0;
      a = (a + e) | 0;
      e = (e + S0(f) + ((f & g) ^ (h & (f ^ g)))) | 0;
      let t = a;
      a = e;
      e = t;
      t = b;
      b = f;
      f = t;
      t = c;
      c = g;
      g = t;
      t = d;
      d = h;
      h = t;
    }
    a = (a + a0) | 0;
    b = (b + b0) | 0;
    c = (c + c0) | 0;
    d = (d + d0) | 0;
    e = (e + e0) | 0;
    f = (f + f0) | 0;
    g = (g + g0) | 0;
    h = (h + h0) | 0;
  }
  s[0] = a;
  s[1] = b;
  s[2] = c;
  s[3] = d;
  s[4] = e;
  s[5] = f;
  s[6] = g;
  s[7] = h;
};

const SHA1_W = new Int32Array(80);

const sha1Compress: Compress = (s, view, offset, end) => {
  const w = SHA1_W;
  for (; offset < end; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = s[0]!,
      b = s[1]!,
      c = s[2]!,
      d = s[3]!,
      e = s[4]!;
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20
          ? ((b & c) | (~b & d)) + 0x5a827999
          : i < 40
            ? (b ^ c ^ d) + 0x6ed9eba1
            : i < 60
              ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc
              : (b ^ c ^ d) + 0xca62c1d6;
      const t = (rotl(a, 5) + f + e + w[i]!) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    s[0]! += a;
    s[1]! += b;
    s[2]! += c;
    s[3]! += d;
    s[4]! += e;
  }
};

const MD5_K = Int32Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0,
);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_M = new Int32Array(16);

const md5Compress: Compress = (s, view, offset, end) => {
  const m = MD5_M;
  for (; offset < end; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(offset + i * 4, true);
    let a = s[0]!,
      b = s[1]!,
      c = s[2]!,
      d = s[3]!;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f =
        round === 0
          ? (b & c) | (~b & d)
          : round === 1
            ? (d & b) | (~d & c)
            : round === 2
              ? b ^ c ^ d
              : c ^ (b | ~d);
      const g =
        round === 0
          ? i
          : round === 1
            ? (5 * i + 1) & 15
            : round === 2
              ? (3 * i + 5) & 15
              : (7 * i) & 15;
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i]! + m[g]!) | 0, MD5_S[(round << 2) | (i & 3)]!)) | 0;
      a = t;
    }
    s[0]! += a;
    s[1]! += b;
    s[2]! += c;
    s[3]! += d;
  }
};

const hasher = (init: Int32Array, compress: Compress, le: boolean) =>
  Object.assign(
    (data: Uint8Array) => {
      const state = init.slice();
      const full = data.length & ~63;
      if (full) compress(state, viewOf(data), 0, full);
      return finish(state, compress, le, data.subarray(full), data.length);
    },
    { create: (): Hash => new MerkleDamgard(init, compress, le) },
  );

const MD_INIT = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0);

export const sha256 = hasher(
  Int32Array.from(PRIMES.slice(0, 8), (p) => frac32(Math.sqrt(p))),
  sha256Compress,
  false,
);
export const sha1 = hasher(MD_INIT, sha1Compress, false);
export const md5 = hasher(MD_INIT.subarray(0, 4), md5Compress, true);

export const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// P-256 (secp256r1) over Jacobian coordinates; a = -3.
const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G: Point = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  1n,
];
type Point = readonly [x: bigint, y: bigint, z: bigint];

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function invert(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return mod(s0, m);
}

function double([x, y, z]: Point): Point {
  if (!z || !y) return [0n, 1n, 0n];
  const delta = (z * z) % P;
  const gamma = (y * y) % P;
  const beta = (x * gamma) % P;
  const alpha = (3n * (x - delta) * (x + delta)) % P;
  const x3 = mod(alpha * alpha - 8n * beta);
  return [
    x3,
    mod(alpha * (4n * beta - x3) - 8n * gamma * gamma),
    mod((y + z) ** 2n - gamma - delta),
  ];
}

function add(p: Point, q: Point): Point {
  if (!p[2]) return q;
  if (!q[2]) return p;
  const z1z1 = (p[2] * p[2]) % P;
  const z2z2 = (q[2] * q[2]) % P;
  const u1 = (p[0] * z2z2) % P;
  const u2 = (q[0] * z1z1) % P;
  const s1 = (p[1] * q[2] * z2z2) % P;
  const s2 = (q[1] * p[2] * z1z1) % P;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  if (!h) return r ? [0n, 1n, 0n] : double(p);
  const hh = (h * h) % P;
  const hhh = (h * hh) % P;
  const v = (u1 * hh) % P;
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), (p[2] * q[2] * h) % P];
}

const toBigInt = (bytes: Uint8Array) => BigInt(`0x${bytesToHex(bytes)}`);

/** ECDSA P-256 over a precomputed 32-byte digest, with a 64-byte r‖s signature (either S). */
export function verifyP256(
  signature: Uint8Array,
  digest: Uint8Array,
  x: Uint8Array,
  y: Uint8Array,
) {
  if (signature.length !== 64 || digest.length !== 32 || x.length !== 32 || y.length !== 32)
    return false;
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32));
  const qx = toBigInt(x);
  const qy = toBigInt(y);
  if (!r || !s || r >= N || s >= N || qx >= P || qy >= P) return false;
  if (mod(qy * qy - qx * qx * qx + 3n * qx - B)) return false;
  const w = invert(s, N);
  const u1 = (toBigInt(digest) * w) % N;
  const u2 = (r * w) % N;
  const q: Point = [qx, qy, 1n];
  const both = add(G, q);
  let acc: Point = [0n, 1n, 0n];
  for (let bit = 255n; bit >= 0n; bit--) {
    acc = double(acc);
    const pick = Number(((u1 >> bit) & 1n) | (((u2 >> bit) & 1n) << 1n));
    if (pick) acc = add(acc, pick === 1 ? G : pick === 2 ? q : both);
  }
  if (!acc[2]) return false;
  const zInv = invert(acc[2], P);
  return mod(acc[0] * zInv * zInv) % N === r;
}
