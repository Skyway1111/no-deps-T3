import * as Ctx from "../Context.ts";
import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";

export type UuidGenerator = () => I.Effect<string>;
export interface SecureRandomService {
  readonly randomBytes: (size: number) => I.Effect<Uint8Array>;
  readonly intBetween: (min: number, max: number, options?: { readonly halfOpen?: boolean }) => I.Effect<number>;
  readonly shuffle: <A>(elements: Iterable<A>) => I.Effect<Array<A>>;
  readonly uuidV4: UuidGenerator;
  readonly uuidV7: UuidGenerator;
  readonly ulid: I.Effect<string>;
}
export class SecureRandom extends Ctx.Service<SecureRandom, SecureRandomService>()("effect/crypto/SecureRandom") {}
const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const fmtUuid = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < 16; i++) s += (i === 4 || i === 6 || i === 8 || i === 10 ? "-" : "") + hex[b[i]!];
  return s;
};
export const uuidV4Unsafe = (randomBytes: (n: number) => Uint8Array): string => {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return fmtUuid(b);
};
export const uuidV7Unsafe = (randomBytes: (n: number) => Uint8Array, now = Date.now()): string => {
  const b = randomBytes(16);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return fmtUuid(b);
};
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ulidUnsafe = (randomBytes: (n: number) => Uint8Array, now = Date.now()): string => {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  const r = randomBytes(16);
  for (let i = 0; i < 16; i++) t += CROCKFORD[r[i]! % 32];
  return t;
};
export const randomBytesUnsafe = (size: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(size));
const intBetweenWith = (randomBytes: (n: number) => Uint8Array, min: number, max: number, halfOpen = true): number => {
  const hi = halfOpen ? max : max + 1;
  const range = hi - min;
  if (range <= 0) return min;
  const b = randomBytes(4);
  const n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return min + (n % range);
};
export const make = (randomBytes: (size: number) => Uint8Array): SecureRandomService => ({
  randomBytes: (n) => I.make(() => randomBytes(n)),
  intBetween: (min, max, o) => I.make(() => intBetweenWith(randomBytes, min, max, o?.halfOpen ?? true)),
  shuffle: <A>(els: Iterable<A>) => I.make(() => {
    const a = [...els];
    for (let i = a.length - 1; i > 0; i--) {
      const j = intBetweenWith(randomBytes, 0, i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }),
  uuidV4: () => I.make(() => uuidV4Unsafe(randomBytes)),
  uuidV7: () => I.make(() => uuidV7Unsafe(randomBytes)),
  ulid: I.make(() => ulidUnsafe(randomBytes)),
});
export const webCrypto: SecureRandomService = make(randomBytesUnsafe);
export const layerWebCrypto: Layer.Layer<SecureRandom> = Layer.succeed(SecureRandom, webCrypto);
