import { HashSymbol, hash as h, hashString, structuralHash } from "./internal.ts";

export const symbol = HashSymbol;
export interface Hash {
  [HashSymbol](): number;
}
export const hash = h;
export const string = hashString;
export const number = (n: number) => h(n);
export const structure = <A extends object>(o: A) => structuralHash(o);
export const combine = (b: number) => (a: number) => (a * 31 + b) | 0;
export const optimize = (n: number) => (n & 0xbfffffff) | ((n >>> 1) & 0x40000000);
export const random = <A extends object>(self: A): number => h(self);
export const isHash = (u: unknown): u is Hash => typeof u === "object" && u !== null && HashSymbol in u;
