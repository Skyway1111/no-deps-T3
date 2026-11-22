import * as NodeCrypto from "node:crypto";
import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";
import * as Digest from "../crypto/Digest.ts";
import * as SecureRandom from "../crypto/SecureRandom.ts";
import * as Mac from "../crypto/Mac.ts";

/** Node's sync hashing beats WebCrypto's promise round-trip for small inputs. */
export const digest: Digest.DigestService = Digest.make((a, data) => I.make(() => new Uint8Array(NodeCrypto.createHash(a.node).update(data).digest())));
export const secureRandom: SecureRandom.SecureRandomService = SecureRandom.make((n) => new Uint8Array(NodeCrypto.randomBytes(n)));
export const layerDigest: Layer.Layer<Digest.Digest> = Layer.succeed(Digest.Digest, digest);
export const layerSecureRandom: Layer.Layer<SecureRandom.SecureRandom> = Layer.succeed(SecureRandom.SecureRandom, secureRandom);
export const layerMac: Layer.Layer<Mac.Mac> = Mac.layerWebCrypto;
export const layer = Layer.mergeAll(layerDigest, layerSecureRandom, layerMac);
