import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as Layer from "../Layer.ts";
import { TaggedError } from "../errors.ts";

export class CryptoError extends TaggedError("CryptoError")<{ readonly message: string; readonly cause?: unknown }> {}
export interface Algorithm {
  readonly _tag: "MacAlgorithm";
  readonly hash: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  readonly length: number;
}
const alg = (hash: Algorithm["hash"], length: number): Algorithm => ({ _tag: "MacAlgorithm", hash, length });
export const hmacSha1 = alg("SHA-1", 20);
export const hmacSha256 = alg("SHA-256", 32);
export const hmacSha384 = alg("SHA-384", 48);
export const hmacSha512 = alg("SHA-512", 64);
export interface Key<A extends Algorithm = Algorithm> {
  readonly _tag: "MacKey";
  readonly algorithm: A;
  readonly cryptoKey: CryptoKey;
  readonly bytes: Uint8Array;
}
export const isKey = (u: unknown): u is Key => typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "MacKey";
const promise = <A>(f: () => Promise<A>): I.Effect<A, CryptoError> =>
  I.make((fib) => I.interruptibleWait<A>(fib, (res, rej) => {
    f().then(res, (e) => rej(new I.Failure(I.causeFail(new CryptoError({ message: e instanceof Error ? e.message : String(e), cause: e })))));
  }));
export const key = <A extends Algorithm>(algorithm: A, bytes: Uint8Array): I.Effect<Key<A>, CryptoError> =>
  promise(async () => ({
    _tag: "MacKey" as const, algorithm, bytes,
    cryptoKey: await globalThis.crypto.subtle.importKey("raw", bytes as BufferSource, { name: "HMAC", hash: algorithm.hash }, false, ["sign", "verify"]),
  }));
export const fromCryptoKey = <A extends Algorithm>(algorithm: A, cryptoKey: CryptoKey): Key<A> => ({ _tag: "MacKey", algorithm, cryptoKey, bytes: new Uint8Array() });
export const toBytes = (k: Key): Uint8Array => k.bytes;
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};
export interface MacService {
  readonly generateKey: <A extends Algorithm>(algorithm: A) => I.Effect<Key<A>, CryptoError>;
  readonly sign: (key: Key, data: Uint8Array) => I.Effect<Uint8Array, CryptoError>;
  readonly verify: (key: Key, tag: Uint8Array, data: Uint8Array) => I.Effect<boolean, CryptoError>;
}
export class Mac extends Ctx.Service<Mac, MacService>()("effect/crypto/Mac") {}
export const webCrypto: MacService = {
  generateKey: (a) => key(a, globalThis.crypto.getRandomValues(new Uint8Array(a.length))),
  sign: (k, data) => promise(async () => new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", k.cryptoKey, data as BufferSource))),
  verify: (k, tag, data) => promise(() => globalThis.crypto.subtle.verify("HMAC", k.cryptoKey, tag as BufferSource, data as BufferSource)),
};
export const layerWebCrypto: Layer.Layer<Mac> = Layer.succeed(Mac, webCrypto);
