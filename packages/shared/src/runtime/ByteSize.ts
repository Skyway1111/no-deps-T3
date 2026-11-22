export const TypeId: unique symbol = Symbol.for("effect/ByteSize") as never;
export interface ByteSize {
  readonly [TypeId]: typeof TypeId;
  readonly bytes: bigint;
}
export type Input = ByteSize | bigint | number;
const mk = (bytes: bigint): ByteSize => ({ [TypeId]: TypeId, bytes });
export const bytes = (n: bigint | number): ByteSize => mk(BigInt(n));
export const kilobytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1000)));
export const megabytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1e6)));
export const gigabytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1e9)));
export const kibibytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1024)));
export const mebibytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1024 ** 2)));
export const gibibytes = (n: number): ByteSize => mk(BigInt(Math.round(n * 1024 ** 3)));
export const isByteSize = (u: unknown): u is ByteSize => typeof u === "object" && u !== null && TypeId in u;
export const make = (input: Input): ByteSize => (isByteSize(input) ? input : bytes(input));
export const toNumber = (s: Input) => Number(make(s).bytes);
export const format = (s: Input): string => {
  const n = toNumber(s);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1000 && i < units.length - 1) (v /= 1000), i++;
  return `${Number.isInteger(v) ? v : v.toFixed(2)} ${units[i]}`;
};
