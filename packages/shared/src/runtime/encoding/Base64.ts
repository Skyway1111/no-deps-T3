import * as R from "../Result.ts";
import { EncodingError } from "./EncodingError.ts";

const enc = new TextEncoder();
const hasBuffer = typeof Buffer !== "undefined";
export const encode = (input: Uint8Array | string): string => {
  const b = typeof input === "string" ? enc.encode(input) : input;
  if (hasBuffer) return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
};
export const decode = (str: string): R.Result<Uint8Array, EncodingError> => {
  const clean = str.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return R.fail(new EncodingError({ kind: "Decode", module: "Base64", input: str, message: "Invalid base64 string" }));
  if (hasBuffer) return R.succeed(new Uint8Array(Buffer.from(clean, "base64")));
  return R.succeed(Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)));
};
export const decodeString = (str: string): R.Result<string, EncodingError> => R.map(decode(str), (b) => new TextDecoder().decode(b));
