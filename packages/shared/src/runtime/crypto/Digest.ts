import * as I from "../internal.ts";
import * as Ctx from "../Context.ts";
import * as Layer from "../Layer.ts";
import * as Hex from "../encoding/Hex.ts";

export interface Algorithm {
  readonly _tag: "Algorithm";
  readonly name: "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
  readonly node: string;
}
const alg = (name: Algorithm["name"], node: string): Algorithm => ({ _tag: "Algorithm", name, node });
export const md5 = alg("MD5", "md5");
export const sha1 = alg("SHA-1", "sha1");
export const sha256 = alg("SHA-256", "sha256");
export const sha384 = alg("SHA-384", "sha384");
export const sha512 = alg("SHA-512", "sha512");
export interface DigestService {
  readonly digest: (algorithm: Algorithm, data: Uint8Array) => I.Effect<Uint8Array>;
  readonly digestHex: (algorithm: Algorithm, data: Uint8Array) => I.Effect<string>;
}
export class Digest extends Ctx.Service<Digest, DigestService>()("effect/crypto/Digest") {}
export const make = (digest: (algorithm: Algorithm, data: Uint8Array) => I.Effect<Uint8Array>): DigestService => ({
  digest,
  digestHex: (a, d) => I.make((f) => I.chain(I.exec(digest(a, d), f), Hex.encode)),
});
/** WebCrypto digests (MD5 is not available in WebCrypto). */
export const webCrypto: DigestService = make((a, data) =>
  I.make((f) => I.interruptibleWait<Uint8Array>(f, (res, rej) => {
    globalThis.crypto.subtle.digest(a.name, data as BufferSource).then((b) => res(new Uint8Array(b)), (e) => rej(new I.Failure(I.causeDie(e))));
  })));
export const layerWebCrypto: Layer.Layer<Digest> = Layer.succeed(Digest, webCrypto);
