import * as R from "../Result.ts";
import { EncodingError } from "./EncodingError.ts";

const enc = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export const encode = (input: Uint8Array | string): string => {
  const b = typeof input === "string" ? enc.encode(input) : input;
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!];
  return s;
};
export const decode = (str: string): R.Result<Uint8Array, EncodingError> => {
  if (str.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(str)) return R.fail(new EncodingError({ kind: "Decode", module: "Hex", input: str, message: "Invalid hex string" }));
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
  return R.succeed(out);
};
export const decodeString = (str: string): R.Result<string, EncodingError> => R.map(decode(str), (b) => new TextDecoder().decode(b));
