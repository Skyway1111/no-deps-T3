import * as R from "../Result.ts";
import * as B64 from "./Base64.ts";
import { EncodingError } from "./EncodingError.ts";

export const encode = (input: Uint8Array | string): string => B64.encode(input).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
export const decode = (str: string): R.Result<Uint8Array, EncodingError> => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(str)) return R.fail(new EncodingError({ kind: "Decode", module: "Base64Url", input: str, message: "Invalid base64url string" }));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return B64.decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
};
export const decodeString = (str: string): R.Result<string, EncodingError> => R.map(decode(str), (b) => new TextDecoder().decode(b));
