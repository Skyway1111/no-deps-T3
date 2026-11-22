import { dual, EqualSymbol, HashSymbol, PipeProto, hash, type Pipeable } from "./internal.ts";
import * as O from "./Option.ts";

export const TypeId: unique symbol = Symbol.for("effect/Duration") as never;
export type DurationValue = { _tag: "Millis"; millis: number } | { _tag: "Nanos"; nanos: bigint } | { _tag: "Infinity" } | { _tag: "NegativeInfinity" };
/** Stored as a single float of milliseconds (Infinity allowed); `value` is derived for compatibility. */
export interface Duration extends Pipeable {
  readonly [TypeId]: typeof TypeId;
  readonly millis: number;
  readonly value: DurationValue;
}
export type Unit = "nano" | "nanos" | "micro" | "micros" | "milli" | "millis" | "second" | "seconds" | "minute" | "minutes" | "hour" | "hours" | "day" | "days" | "week" | "weeks";
export interface DurationObject {
  readonly weeks?: number; readonly days?: number; readonly hours?: number; readonly minutes?: number;
  readonly seconds?: number; readonly milliseconds?: number; readonly microseconds?: number; readonly nanoseconds?: number;
}
export type Input = Duration | number | bigint | readonly [seconds: number, nanos: number] | `${number} ${Unit}` | "Infinity" | "-Infinity" | DurationObject;

const proto = {
  ...PipeProto,
  [TypeId]: TypeId,
  get value(): DurationValue {
    const m = (this as unknown as Duration).millis;
    return m === Infinity ? { _tag: "Infinity" } : m === -Infinity ? { _tag: "NegativeInfinity" } : { _tag: "Millis", millis: m };
  },
  [EqualSymbol](this: Duration, that: unknown) {
    return isDuration(that) && that.millis === this.millis;
  },
  [HashSymbol](this: Duration) {
    return hash(this.millis);
  },
  toJSON(this: Duration) {
    return this.millis === Infinity ? { _id: "Duration", _tag: "Infinity" } : { _id: "Duration", _tag: "Millis", millis: this.millis };
  },
  toString(this: Duration) {
    return format(this);
  },
};
const mk = (millis: number): Duration => {
  const d = Object.create(proto);
  d.millis = millis;
  return d;
};
export const isDuration = (u: unknown): u is Duration => typeof u === "object" && u !== null && TypeId in u;
const unitMs: Record<string, number> = {
  nano: 1e-6, nanos: 1e-6, micro: 1e-3, micros: 1e-3, milli: 1, millis: 1, second: 1e3, seconds: 1e3,
  minute: 6e4, minutes: 6e4, hour: 36e5, hours: 36e5, day: 864e5, days: 864e5, week: 6048e5, weeks: 6048e5,
};
export const fromInput = (input: Input): O.Option<Duration> => {
  if (isDuration(input)) return O.some(input);
  if (typeof input === "number") return O.some(mk(input));
  if (typeof input === "bigint") return O.some(mk(Number(input) / 1e6));
  if (Array.isArray(input)) return O.some(mk(input[0] * 1e3 + input[1] / 1e6));
  if (typeof input === "string") {
    if (input === "Infinity") return O.some(infinity);
    if (input === "-Infinity") return O.some(negativeInfinity);
    const m = /^(-?\d+(?:\.\d+)?)\s+(\w+)$/.exec(input);
    const u = m && unitMs[m[2]!];
    return u === undefined || u === null ? O.none() : O.some(mk(Number(m![1]) * u));
  }
  if (typeof input === "object" && input !== null) {
    const o = input as DurationObject;
    return O.some(mk((o.weeks ?? 0) * 6048e5 + (o.days ?? 0) * 864e5 + (o.hours ?? 0) * 36e5 + (o.minutes ?? 0) * 6e4 +
      (o.seconds ?? 0) * 1e3 + (o.milliseconds ?? 0) + (o.microseconds ?? 0) / 1e3 + (o.nanoseconds ?? 0) / 1e6));
  }
  return O.none();
};
export const fromInputUnsafe = (input: Input): Duration => {
  const o = fromInput(input);
  if (o._tag === "None") throw new Error(`Invalid Input: ${String(input)}`);
  return o.value;
};
/** Fast path used by the runtime: milliseconds of any Input. */
export const toMillis = (input: Input): number => (typeof input === "number" ? input : fromInputUnsafe(input).millis);
export const zero = mk(0);
export const infinity = mk(Infinity);
export const negativeInfinity = mk(-Infinity);
export const nanos = (n: bigint): Duration => mk(Number(n) / 1e6);
export const micros = (n: bigint): Duration => mk(Number(n) / 1e3);
export const millis = (n: number): Duration => mk(n);
export const seconds = (n: number): Duration => mk(n * 1e3);
export const minutes = (n: number): Duration => mk(n * 6e4);
export const hours = (n: number): Duration => mk(n * 36e5);
export const days = (n: number): Duration => mk(n * 864e5);
export const weeks = (n: number): Duration => mk(n * 6048e5);
export const toSeconds = (d: Input) => toMillis(d) / 1e3;
export const toMinutes = (d: Input) => toMillis(d) / 6e4;
export const toHours = (d: Input) => toMillis(d) / 36e5;
export const toDays = (d: Input) => toMillis(d) / 864e5;
export const toWeeks = (d: Input) => toMillis(d) / 6048e5;
export const toMicros = (d: Input) => BigInt(Math.round(toMillis(d) * 1e3));
export const toNanosUnsafe = (d: Input): bigint => {
  const m = toMillis(d);
  if (!Number.isFinite(m)) throw new Error("Cannot convert infinite duration to nanos");
  return BigInt(Math.round(m * 1e6));
};
export const toNanos = (d: Input): O.Option<bigint> => (Number.isFinite(toMillis(d)) ? O.some(toNanosUnsafe(d)) : O.none());
export const toHrTime = (d: Input): [number, number] => {
  const m = toMillis(d);
  return [Math.floor(m / 1e3), Math.round((m % 1e3) * 1e6)];
};
export const isFinite = (d: Input) => Number.isFinite(toMillis(d));
export const isZero = (d: Input) => toMillis(d) === 0;
export const isNegative = (d: Input) => toMillis(d) < 0;
export const isPositive = (d: Input) => toMillis(d) > 0;
export const abs = (d: Input) => mk(Math.abs(toMillis(d)));
export const negate = (d: Input) => mk(-toMillis(d));
type Bin<R> = { (that: Input): (self: Input) => R; (self: Input, that: Input): R };
const bin = <R>(f: (a: number, b: number) => R): Bin<R> => dual(2, (a: Input, b: Input) => f(toMillis(a), toMillis(b)));
export const sum: Bin<Duration> = bin((a, b) => mk(a + b));
export const subtract: Bin<Duration> = bin((a, b) => mk(a - b));
export const min: Bin<Duration> = bin((a, b) => mk(Math.min(a, b)));
export const max: Bin<Duration> = bin((a, b) => mk(Math.max(a, b)));
export const isLessThan: Bin<boolean> = bin((a, b) => a < b);
export const isLessThanOrEqualTo: Bin<boolean> = bin((a, b) => a <= b);
export const isGreaterThan: Bin<boolean> = bin((a, b) => a > b);
export const isGreaterThanOrEqualTo: Bin<boolean> = bin((a, b) => a >= b);
export const equals: Bin<boolean> = bin((a, b) => a === b);
export const times: { (n: number): (self: Input) => Duration; (self: Input, n: number): Duration } = dual(2, (d: Input, n: number) => mk(toMillis(d) * n));
export const divide: { (n: number): (self: Input) => O.Option<Duration>; (self: Input, n: number): O.Option<Duration> } = dual(2, (d: Input, n: number) =>
  n === 0 || !Number.isFinite(n) ? O.none() : O.some(mk(toMillis(d) / n)));
export const divideUnsafe: { (n: number): (self: Input) => Duration; (self: Input, n: number): Duration } = dual(2, (d: Input, n: number) => mk(toMillis(d) / n));
export const clamp: { (o: { minimum: Input; maximum: Input }): (self: Input) => Duration; (self: Input, o: { minimum: Input; maximum: Input }): Duration } =
  dual(2, (d: Input, o: { minimum: Input; maximum: Input }) => mk(Math.min(Math.max(toMillis(d), toMillis(o.minimum)), toMillis(o.maximum))));
export const between: { (o: { minimum: Input; maximum: Input }): (self: Input) => boolean; (self: Input, o: { minimum: Input; maximum: Input }): boolean } =
  dual(2, (d: Input, o: { minimum: Input; maximum: Input }) => toMillis(d) >= toMillis(o.minimum) && toMillis(d) <= toMillis(o.maximum));
export const Order = (a: Duration, b: Duration): -1 | 0 | 1 => (a.millis < b.millis ? -1 : a.millis > b.millis ? 1 : 0);
export const Equivalence = (a: Duration, b: Duration) => a.millis === b.millis;
export const match: {
  <A, B>(o: { onMillis: (m: number) => A; onNanos: (n: bigint) => B; onInfinity?: () => A }): (self: Input) => A | B;
  <A, B>(self: Input, o: { onMillis: (m: number) => A; onNanos: (n: bigint) => B; onInfinity?: () => A }): A | B;
} = dual(2, (d: Input, o: any) => {
  const m = toMillis(d);
  return m === Infinity && o.onInfinity ? o.onInfinity() : o.onMillis(m);
});
export const parts = (d: Input) => {
  const m = toMillis(d);
  if (!Number.isFinite(m)) return { days: m, hours: m, minutes: m, seconds: m, millis: m, nanos: m };
  const a = Math.abs(m);
  return {
    days: Math.floor(a / 864e5), hours: Math.floor(a / 36e5) % 24, minutes: Math.floor(a / 6e4) % 60,
    seconds: Math.floor(a / 1e3) % 60, millis: Math.floor(a) % 1e3, nanos: Math.round((a % 1) * 1e6),
  };
};
export const format = (d: Input): string => {
  const m = toMillis(d);
  if (m === Infinity) return "Infinity";
  if (m === -Infinity) return "-Infinity";
  if (m === 0) return "0";
  const p = parts(m);
  const out: Array<string> = [];
  if (p.days) out.push(`${p.days}d`);
  if (p.hours) out.push(`${p.hours}h`);
  if (p.minutes) out.push(`${p.minutes}m`);
  if (p.seconds) out.push(`${p.seconds}s`);
  if (p.millis) out.push(`${p.millis}ms`);
  if (p.nanos) out.push(`${p.nanos}ns`);
  return (m < 0 ? "-" : "") + out.join(" ");
};
export const formatIso = (d: Input): string => {
  const p = parts(d);
  const s = p.seconds + p.millis / 1e3;
  return `P${p.days ? `${p.days}D` : ""}T${p.hours ? `${p.hours}H` : ""}${p.minutes ? `${p.minutes}M` : ""}${s || (!p.days && !p.hours && !p.minutes) ? `${s}S` : ""}`;
};
