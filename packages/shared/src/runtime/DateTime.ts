import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as D from "./Duration.ts";
import * as Ctx from "./Context.ts";
import { Clock } from "./Clock.ts";

export const TypeId: unique symbol = Symbol.for("effect/DateTime") as never;
export const TimeZoneTypeId: unique symbol = Symbol.for("effect/DateTime/TimeZone") as never;
export type TimeZone = TimeZone.Offset | TimeZone.Named;
export declare namespace TimeZone {
  interface Offset { readonly [TimeZoneTypeId]: typeof TimeZoneTypeId; readonly _tag: "Offset"; readonly offset: number }
  interface Named { readonly [TimeZoneTypeId]: typeof TimeZoneTypeId; readonly _tag: "Named"; readonly id: string; readonly format: Intl.DateTimeFormat }
}
export interface Parts { readonly millis: number; readonly seconds: number; readonly minutes: number; readonly hours: number; readonly day: number; readonly month: number; readonly year: number }
export interface PartsWithWeekday extends Parts { readonly weekDay: number }
export interface PartsForMath { readonly millis: number; readonly seconds: number; readonly minutes: number; readonly hours: number; readonly days: number; readonly weeks: number; readonly months: number; readonly years: number }
export interface Utc extends I.Pipeable { readonly [TypeId]: typeof TypeId; readonly _tag: "Utc"; readonly epochMilliseconds: number }
export interface Zoned extends I.Pipeable { readonly [TypeId]: typeof TypeId; readonly _tag: "Zoned"; readonly epochMilliseconds: number; readonly zone: TimeZone }
export type DateTime = Utc | Zoned;
export declare namespace DateTime {
  type Input = DateTime | Partial<Parts> | Date | number | string;
  type PreserveZone<A extends Input> = A extends Zoned ? Zoned : Utc;
  type Parts = import("./DateTime.ts").Parts;
  type PartsForMath = import("./DateTime.ts").PartsForMath;
  type PartsWithWeekday = import("./DateTime.ts").PartsWithWeekday;
}

const proto = {
  ...I.PipeProto,
  [TypeId]: TypeId,
  [I.EqualSymbol](this: DateTime, that: unknown) {
    return isDateTime(that) && that.epochMilliseconds === this.epochMilliseconds;
  },
  [I.HashSymbol](this: DateTime) {
    return I.hash(this.epochMilliseconds);
  },
  toJSON(this: DateTime) {
    return new Date(this.epochMilliseconds).toJSON();
  },
  toString(this: DateTime) {
    return this._tag === "Utc" ? `DateTime.Utc(${formatIso(this)})` : `DateTime.Zoned(${formatIsoZoned(this)})`;
  },
};
const utc = (ms: number): Utc => {
  const d = Object.create(proto);
  d._tag = "Utc";
  d.epochMilliseconds = ms;
  return d;
};
const zoned = (ms: number, zone: TimeZone): Zoned => {
  const d = Object.create(proto);
  d._tag = "Zoned";
  d.epochMilliseconds = ms;
  d.zone = zone;
  return d;
};
export const isDateTime = (u: unknown): u is DateTime => typeof u === "object" && u !== null && TypeId in u;
export const isUtc = (d: DateTime): d is Utc => d._tag === "Utc";
export const isZoned = (d: DateTime): d is Zoned => d._tag === "Zoned";
export const isTimeZone = (u: unknown): u is TimeZone => typeof u === "object" && u !== null && TimeZoneTypeId in u;
const toMs = (input: DateTime.Input): number => {
  if (isDateTime(input)) return input.epochMilliseconds;
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return input;
  if (typeof input === "string") return new Date(input).getTime();
  const p = input as Partial<Parts>;
  return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hours ?? 0, p.minutes ?? 0, p.seconds ?? 0, p.millis ?? 0);
};
export const makeUnsafe = <A extends DateTime.Input>(input: A): DateTime.PreserveZone<A> => {
  if (isDateTime(input)) return input as never;
  const ms = toMs(input);
  if (Number.isNaN(ms)) throw new globalThis.Error(`Invalid date: ${String(input)}`);
  return utc(ms) as never;
};
export const make = <A extends DateTime.Input>(input: A): O.Option<DateTime.PreserveZone<A>> => {
  try {
    return O.some(makeUnsafe(input));
  } catch {
    return O.none();
  }
};
export const unsafeMake = makeUnsafe;
export const nowUnsafe = (): Utc => utc(Date.now());
export const now: I.Effect<Utc> = I.make((f) => utc((I.lookup(f.context, Clock.key) as Clock).currentTimeMillisUnsafe()));
export const fromDateUnsafe = (d: Date): Utc => makeUnsafe(d);

// ---------- zones ----------
const offsetZone = (offset: number): TimeZone.Offset => ({ [TimeZoneTypeId]: TimeZoneTypeId, _tag: "Offset", offset });
export const zoneMakeOffset = offsetZone;
const namedZone = (id: string): TimeZone.Named => ({
  [TimeZoneTypeId]: TimeZoneTypeId, _tag: "Named", id,
  format: new Intl.DateTimeFormat("en-US", { timeZone: id, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "longOffset" }),
});
export const zoneMakeNamedUnsafe = (id: string): TimeZone.Named => {
  try {
    return namedZone(id);
  } catch {
    throw new globalThis.Error(`Invalid time zone: ${id}`);
  }
};
export const zoneMakeNamed = (id: string): O.Option<TimeZone.Named> => {
  try {
    return O.some(namedZone(id));
  } catch {
    return O.none();
  }
};
export const zoneMakeLocal = (): TimeZone.Named => namedZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
export const zoneFromString = (s: string): O.Option<TimeZone> => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(s);
  if (m) return O.some(offsetZone((m[1] === "-" ? -1 : 1) * (Number(m[2]) * 36e5 + Number(m[3]) * 6e4)));
  return zoneMakeNamed(s);
};
const fmtOffset = (ms: number) => {
  const sign = ms < 0 ? "-" : "+";
  const a = Math.abs(ms);
  return `${sign}${String(Math.floor(a / 36e5)).padStart(2, "0")}:${String(Math.floor((a % 36e5) / 6e4)).padStart(2, "0")}`;
};
export const zoneToString = (z: TimeZone): string => (z._tag === "Offset" ? fmtOffset(z.offset) : z.id);
/** Offset of `zone` at instant `ms`, in milliseconds. */
const zoneOffset = (zone: TimeZone, ms: number): number => {
  if (zone._tag === "Offset") return zone.offset;
  const name = zone.format.formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 36e5 + Number(m[3] ?? 0) * 6e4) : 0;
};
export const makeZonedUnsafe = (input: DateTime.Input, options?: { readonly timeZone?: number | string | TimeZone; readonly adjustForTimeZone?: boolean }): Zoned => {
  const tz = options?.timeZone;
  const zone = tz === undefined ? zoneMakeLocal() : typeof tz === "number" ? offsetZone(tz) : typeof tz === "string" ? O.getOrThrow(zoneFromString(tz)) : tz;
  let ms = toMs(input);
  if (options?.adjustForTimeZone) ms -= zoneOffset(zone, ms);
  return zoned(ms, zone);
};
export const makeZoned = (input: DateTime.Input, options?: Parameters<typeof makeZonedUnsafe>[1]): O.Option<Zoned> => {
  try {
    return O.some(makeZonedUnsafe(input, options));
  } catch {
    return O.none();
  }
};
export const setZone: { (zone: TimeZone): (self: DateTime) => Zoned; (self: DateTime, zone: TimeZone): Zoned } = I.dual(2, (self: DateTime, zone: TimeZone) => zoned(self.epochMilliseconds, zone));
export const setZoneOffset: { (offset: number): (self: DateTime) => Zoned; (self: DateTime, offset: number): Zoned } = I.dual(2, (self: DateTime, o: number) => zoned(self.epochMilliseconds, offsetZone(o)));
export const toUtc = (self: DateTime): Utc => (self._tag === "Utc" ? self : utc(self.epochMilliseconds));
export const CurrentTimeZone = Ctx.Service<TimeZone, TimeZone>("effect/DateTime/CurrentTimeZone");
export const withCurrentZone: { (zone: TimeZone): <A, E, R>(self: I.Effect<A, E, R>) => I.Effect<A, E, Exclude<R, TimeZone>>; <A, E, R>(self: I.Effect<A, E, R>, zone: TimeZone): I.Effect<A, E, Exclude<R, TimeZone>> } =
  I.dual(2, (self: I.Effect<any, any, any>, zone: TimeZone) => I.make((f) => {
    const prev = f.context;
    f.context = I.contextAdd(prev, CurrentTimeZone.key, zone);
    return I.settle(() => I.exec(self, f), (a) => ((f.context = prev), a), (e) => ((f.context = prev), I.failWith(I.toCause(e))));
  }));
export const withCurrentZoneLocal = <A, E, R>(self: I.Effect<A, E, R>): I.Effect<A, E, Exclude<R, TimeZone>> => withCurrentZone(self, zoneMakeLocal());
export const nowInCurrentZone: I.Effect<Zoned, never, TimeZone> = I.make((f) => I.chain(I.exec(CurrentTimeZone, f), (z) => zoned(Date.now(), z)));

// ---------- conversion ----------
export const toEpochMillis = (self: DateTime): number => self.epochMilliseconds;
export const toDateUtc = (self: DateTime): Date => new Date(self.epochMilliseconds);
/** The wall-clock time in the zone, encoded as a UTC Date. */
export const toDate = (self: DateTime): Date => (self._tag === "Utc" ? new Date(self.epochMilliseconds) : new Date(self.epochMilliseconds + zoneOffset(self.zone, self.epochMilliseconds)));
export const zonedOffset = (self: Zoned): number => zoneOffset(self.zone, self.epochMilliseconds);
const partsOf = (d: Date): PartsWithWeekday => ({
  millis: d.getUTCMilliseconds(), seconds: d.getUTCSeconds(), minutes: d.getUTCMinutes(), hours: d.getUTCHours(),
  day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear(), weekDay: d.getUTCDay(),
});
export const toPartsUtc = (self: DateTime): PartsWithWeekday => partsOf(toDateUtc(self));
export const toParts = (self: DateTime): PartsWithWeekday => partsOf(toDate(self));
export const getPartUtc: { (part: keyof PartsWithWeekday): (self: DateTime) => number; (self: DateTime, part: keyof PartsWithWeekday): number } = I.dual(2, (self: DateTime, p: keyof PartsWithWeekday) => toPartsUtc(self)[p]);
export const getPart: { (part: keyof PartsWithWeekday): (self: DateTime) => number; (self: DateTime, part: keyof PartsWithWeekday): number } = I.dual(2, (self: DateTime, p: keyof PartsWithWeekday) => toParts(self)[p]);
const withWall = <A extends DateTime>(self: A, f: (wall: Date) => void): A => {
  const off = self._tag === "Zoned" ? zoneOffset(self.zone, self.epochMilliseconds) : 0;
  const wall = new Date(self.epochMilliseconds + off);
  f(wall);
  const ms = wall.getTime() - off;
  return (self._tag === "Utc" ? utc(ms) : zoned(ms, self.zone)) as A;
};
export const setParts: { (parts: Partial<Parts>): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, parts: Partial<Parts>): A } =
  I.dual(2, (self: DateTime, p: Partial<Parts>) => withWall(self, (w) => {
    if (p.year !== undefined) w.setUTCFullYear(p.year);
    if (p.month !== undefined) w.setUTCMonth(p.month - 1);
    if (p.day !== undefined) w.setUTCDate(p.day);
    if (p.hours !== undefined) w.setUTCHours(p.hours);
    if (p.minutes !== undefined) w.setUTCMinutes(p.minutes);
    if (p.seconds !== undefined) w.setUTCSeconds(p.seconds);
    if (p.millis !== undefined) w.setUTCMilliseconds(p.millis);
  }));
export const setPartsUtc = setParts;

// ---------- math ----------
export const add: { (parts: Partial<PartsForMath>): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, parts: Partial<PartsForMath>): A } =
  I.dual(2, (self: DateTime, p: Partial<PartsForMath>) => {
    const fixed = (p.millis ?? 0) + (p.seconds ?? 0) * 1e3 + (p.minutes ?? 0) * 6e4 + (p.hours ?? 0) * 36e5;
    const moved = p.days || p.weeks || p.months || p.years
      ? withWall(self, (w) => {
        if (p.years) w.setUTCFullYear(w.getUTCFullYear() + p.years);
        if (p.months) w.setUTCMonth(w.getUTCMonth() + p.months);
        if (p.weeks || p.days) w.setUTCDate(w.getUTCDate() + (p.weeks ?? 0) * 7 + (p.days ?? 0));
      })
      : self;
    return fixed ? (moved._tag === "Utc" ? utc(moved.epochMilliseconds + fixed) : zoned(moved.epochMilliseconds + fixed, moved.zone)) : moved;
  });
const negate = (p: Partial<PartsForMath>): Partial<PartsForMath> => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, -(v as number)]));
export const subtract: { (parts: Partial<PartsForMath>): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, parts: Partial<PartsForMath>): A } =
  I.dual(2, (self: DateTime, p: Partial<PartsForMath>) => add(self, negate(p)));
export const addDuration: { (d: D.Input): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, d: D.Input): A } =
  I.dual(2, (self: DateTime, d: D.Input) => add(self, { millis: D.toMillis(d) }));
export const subtractDuration: { (d: D.Input): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, d: D.Input): A } =
  I.dual(2, (self: DateTime, d: D.Input) => add(self, { millis: -D.toMillis(d) }));
export const distance: { (other: DateTime): (self: DateTime) => D.Duration; (self: DateTime, other: DateTime): D.Duration } =
  I.dual(2, (self: DateTime, other: DateTime) => D.millis(other.epochMilliseconds - self.epochMilliseconds));
export const distanceDuration = distance;
const startUnits = { second: 1e3, minute: 6e4, hour: 36e5 } as const;
export const startOf: { (part: "second" | "minute" | "hour" | "day" | "month" | "year"): <A extends DateTime>(self: A) => A; <A extends DateTime>(self: A, part: "second" | "minute" | "hour" | "day" | "month" | "year"): A } =
  I.dual(2, (self: DateTime, part: string) => withWall(self, (w) => {
    if (part in startUnits) return void w.setTime(Math.floor(w.getTime() / startUnits[part as keyof typeof startUnits]) * startUnits[part as keyof typeof startUnits]);
    w.setUTCHours(0, 0, 0, 0);
    if (part === "month" || part === "year") w.setUTCDate(1);
    if (part === "year") w.setUTCMonth(0);
  }));

// ---------- comparison ----------
type Cmp = { (that: DateTime): (self: DateTime) => boolean; (self: DateTime, that: DateTime): boolean };
const cmp = (f: (a: number, b: number) => boolean): Cmp => I.dual(2, (a: DateTime, b: DateTime) => f(a.epochMilliseconds, b.epochMilliseconds));
export const isGreaterThan = cmp((a, b) => a > b);
export const isGreaterThanOrEqualTo = cmp((a, b) => a >= b);
export const isLessThan = cmp((a, b) => a < b);
export const isLessThanOrEqualTo = cmp((a, b) => a <= b);
export const Order = (a: DateTime, b: DateTime): -1 | 0 | 1 => (a.epochMilliseconds < b.epochMilliseconds ? -1 : a.epochMilliseconds > b.epochMilliseconds ? 1 : 0);
export const Equivalence = (a: DateTime, b: DateTime) => a.epochMilliseconds === b.epochMilliseconds;
export const min: { <A extends DateTime>(that: A): <B extends DateTime>(self: B) => A | B; <A extends DateTime, B extends DateTime>(self: A, that: B): A | B } = I.dual(2, (a: DateTime, b: DateTime) => (a.epochMilliseconds <= b.epochMilliseconds ? a : b));
export const max: { <A extends DateTime>(that: A): <B extends DateTime>(self: B) => A | B; <A extends DateTime, B extends DateTime>(self: A, that: B): A | B } = I.dual(2, (a: DateTime, b: DateTime) => (a.epochMilliseconds >= b.epochMilliseconds ? a : b));
export const between: { (o: { minimum: DateTime; maximum: DateTime }): (self: DateTime) => boolean; (self: DateTime, o: { minimum: DateTime; maximum: DateTime }): boolean } =
  I.dual(2, (s: DateTime, o: { minimum: DateTime; maximum: DateTime }) => s.epochMilliseconds >= o.minimum.epochMilliseconds && s.epochMilliseconds <= o.maximum.epochMilliseconds);
export const isFuture = (self: DateTime): I.Effect<boolean> => I.make((f) => I.chain(I.exec(now, f), (n) => self.epochMilliseconds > n.epochMilliseconds));
export const isPast = (self: DateTime): I.Effect<boolean> => I.make((f) => I.chain(I.exec(now, f), (n) => self.epochMilliseconds < n.epochMilliseconds));

// ---------- formatting ----------
export const formatIso = (self: DateTime): string => new Date(self.epochMilliseconds).toISOString();
export const formatIsoDate = (self: DateTime): string => toDate(self).toISOString().slice(0, 10);
export const formatIsoDateUtc = (self: DateTime): string => formatIso(self).slice(0, 10);
export const formatIsoOffset = (self: DateTime): string => {
  const off = self._tag === "Zoned" ? zoneOffset(self.zone, self.epochMilliseconds) : 0;
  return `${new Date(self.epochMilliseconds + off).toISOString().slice(0, -1)}${off === 0 ? "Z" : fmtOffset(off)}`;
};
export const formatIsoZoned = (self: Zoned): string => (self.zone._tag === "Offset" ? formatIsoOffset(self) : `${formatIsoOffset(self)}[${self.zone.id}]`);
export const format: { (options?: Intl.DateTimeFormatOptions & { readonly locale?: string }): (self: DateTime) => string; (self: DateTime, options?: Intl.DateTimeFormatOptions & { readonly locale?: string }): string } =
  I.dual((args) => isDateTime(args[0]), (self: DateTime, o?: Intl.DateTimeFormatOptions & { locale?: string }) =>
    new Intl.DateTimeFormat(o?.locale, { timeZone: self._tag === "Zoned" && self.zone._tag === "Named" ? self.zone.id : "UTC", ...o }).format(self.epochMilliseconds));
export const formatUtc = format;
