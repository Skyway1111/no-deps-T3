import * as I from "./internal.ts";
import * as O from "./Option.ts";
import * as Red from "./Redacted.ts";
import * as D from "./Duration.ts";
import { ConfigProvider as ProviderRef, type ConfigProvider, type Path } from "./ConfigProvider.ts";
import { TaggedError } from "./errors.ts";
import type { LogLevel as LL } from "./References.ts";
import * as Schema from "./Schema.ts";

export const TypeId: unique symbol = Symbol.for("effect/Config") as never;
export class ConfigError extends TaggedError("ConfigError")<{ message: string; path: ReadonlyArray<string | number>; missing: boolean }> {}
export interface Config<out T> extends I.Effect<T, ConfigError> {
  readonly [TypeId]: typeof TypeId;
  readonly parse: (provider: ConfigProvider) => I.Effect<T, ConfigError>;
}
export declare namespace Config {
  type Success<C> = C extends Config<infer T> ? T : never;
}
export type Success<C> = Config.Success<C>;
/** Internal reader: raw lookup → T, throwing ConfigError via Failure. */
type Read<T> = (provider: ConfigProvider, f: I.Fiber) => I.Step<T>;
const proto = {
  ...I.YieldableProto,
  [TypeId]: TypeId,
  [I.RUN](this: { read: Read<unknown> }, f: I.Fiber) {
    return this.read(I.lookup(f.context, ProviderRef.key) as ConfigProvider, f);
  },
};
const mk = <T>(read: Read<T>): Config<T> => {
  const c = Object.create(proto);
  c.read = read;
  c.parse = (p: ConfigProvider) => I.make((f) => read(p, f));
  return c;
};
export const isConfig = (u: unknown): u is Config<unknown> => typeof u === "object" && u !== null && TypeId in u;
const missing = (path: Path): never => I.failWith(I.causeFail(new ConfigError({ message: `Expected ${path.join(".")} to exist`, path, missing: true })));
const invalid = (path: Path, msg: string): never => I.failWith(I.causeFail(new ConfigError({ message: `${path.join(".")}: ${msg}`, path, missing: false })));
const isMissing = (e: unknown) => {
  const c = I.toCause(e);
  const fl = c.reasons.find((r) => r._tag === "Fail") as I.Fail<unknown> | undefined;
  return fl?.error instanceof ConfigError && fl.error.missing;
};
const primitive = <T>(name: string | undefined, parse: (raw: unknown, path: Path) => T): Config<T> =>
  mk((p, f) => {
    const path = name === undefined ? [] : [name];
    return I.chain(I.exec(p.load(path), f), (raw) => (raw === undefined ? missing(path) : parse(raw, path)));
  });
const str = (raw: unknown, path: Path): string => (typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? globalThis.String(raw) : invalid(path, "expected a string"));
export const String = (name?: string): Config<string> => primitive(name, str);
export const NonEmptyString = (name?: string): Config<string> => primitive(name, (r, p) => {
  const s = str(r, p);
  return s.length ? s : invalid(p, "expected a non-empty string");
});
export const Number = (name?: string): Config<number> => primitive(name, (r, p) => {
  const n = typeof r === "number" ? r : globalThis.Number(str(r, p));
  return globalThis.Number.isNaN(n) ? invalid(p, "expected a number") : n;
});
export const Finite = (name?: string): Config<number> => map(Number(name), (n) => n);
export const Int = (name?: string): Config<number> => primitive(name, (r, p) => {
  const n = typeof r === "number" ? r : globalThis.Number(str(r, p));
  return globalThis.Number.isInteger(n) ? n : invalid(p, "expected an integer");
});
export const Port = (name?: string): Config<number> => primitive(name, (r, p) => {
  const n = typeof r === "number" ? r : globalThis.Number(str(r, p));
  return globalThis.Number.isInteger(n) && n >= 1 && n <= 65535 ? n : invalid(p, "expected a port number");
});
const truthy = new Set(["true", "1", "yes", "on", "y"]);
const falsy = new Set(["false", "0", "no", "off", "n"]);
export const Boolean = (name?: string): Config<boolean> => primitive(name, (r, p) => {
  if (typeof r === "boolean") return r;
  const s = str(r, p).toLowerCase();
  return truthy.has(s) ? true : falsy.has(s) ? false : invalid(p, "expected a boolean");
});
export const URL = (name?: string): Config<globalThis.URL> => primitive(name, (r, p) => {
  try {
    return new globalThis.URL(str(r, p));
  } catch {
    return invalid(p, "expected a URL");
  }
});
export const Redacted = (name?: string): Config<Red.Redacted<string>> => map(String(name), (s) => Red.make(s));
export const Duration = (name?: string): Config<D.Duration> => primitive(name, (r, p) => {
  const o = D.fromInput(str(r, p) as D.Input);
  return o._tag === "Some" ? o.value : invalid(p, "expected a duration");
});
export const Literals = <const Ls extends ReadonlyArray<string | number | boolean | null>>(literals: Ls, name?: string): Config<Ls[number]> =>
  primitive(name, (r, p) => {
    const hit = literals.find((l) => l === r || globalThis.String(l) === r);
    return hit !== undefined ? hit : invalid(p, `expected one of ${literals.join(", ")}`);
  });
export const Literal = <const L extends string | number | boolean | null>(literal: L, name?: string): Config<L> => Literals([literal], name);
const levels: ReadonlyArray<LL> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"];
export const LogLevel = (name?: string): Config<LL> => primitive(name, (r, p) => {
  const s = str(r, p).toLowerCase();
  return levels.find((l) => l.toLowerCase() === s || (l === "Warn" && s === "warning")) ?? invalid(p, "expected a log level");
});
/** Decode with a Schema codec; the raw value is a string (env) or structured (fromUnknown). */
export function schema<S extends Schema.Top>(codec: S, path?: string | Path): Config<S["Type"]> {
  const p0: Path = path === undefined ? [] : typeof path === "string" ? [path] : path;
  const decode = Schema.decodeUnknownEffect(codec);
  return mk((p, f) =>
    I.chain(I.exec(p.load(p0), f), (raw) => {
      if (raw === undefined) return missing(p0);
      return I.settle(() => I.exec(decode(raw), f), (v) => v, (e) => {
        const c = I.toCause(e);
        const fl = c.reasons.find((r) => r._tag === "Fail") as I.Fail<{ message?: string }> | undefined;
        return invalid(p0, fl?.error?.message ?? I.prettyCause(c));
      });
    }));
}
export const succeed = <T>(value: T): Config<T> => mk(() => value);
export const fail = (message: string): Config<never> => mk(() => invalid([], message));
export const option = <T>(self: Config<T>): Config<O.Option<T>> =>
  mk((p, f) => I.settle(() => (self as unknown as { read: Read<T> }).read(p, f), O.some, (e) => (isMissing(e) ? O.none() : I.failWith(I.toCause(e)))));
export const withDefault: {
  <const A2>(def: A2): <A>(self: Config<A>) => Config<A | A2>;
  <A, const A2>(self: Config<A>, def: A2): Config<A | A2>;
} = I.dual(2, <A, A2>(self: Config<A>, def: A2): Config<A | A2> =>
  mk((p, f) => I.settle(() => (self as unknown as { read: Read<A> }).read(p, f), (a): A | A2 => a, (e): A | A2 => (isMissing(e) ? def : I.failWith(I.toCause(e))))));
export const orElse: {
  <B>(that: () => Config<B>): <A>(self: Config<A>) => Config<A | B>;
  <A, B>(self: Config<A>, that: () => Config<B>): Config<A | B>;
} = I.dual(2, <A, B>(self: Config<A>, that: () => Config<B>): Config<A | B> =>
  mk((p, f) => I.settle(() => (self as unknown as { read: Read<A> }).read(p, f), (a): I.Step<A | B> => a, (): I.Step<A | B> => (that() as unknown as { read: Read<B> }).read(p, f))));
export const map: {
  <A, B>(f: (a: A) => B): (self: Config<A>) => Config<B>;
  <A, B>(self: Config<A>, f: (a: A) => B): Config<B>;
} = I.dual(2, <A, B>(self: Config<A>, g: (a: A) => B): Config<B> => mk((p, f) => I.chain((self as unknown as { read: Read<A> }).read(p, f), g)));
export const mapEffect: {
  <A, B, E, R>(f: (a: A) => I.Effect<B, E, R>): (self: Config<A>) => Config<B>;
  <A, B, E, R>(self: Config<A>, f: (a: A) => I.Effect<B, E, R>): Config<B>;
} = I.dual(2, <A, B>(self: Config<A>, g: (a: A) => I.Effect<B, any, any>): Config<B> =>
  mk((p, f) => I.chain((self as unknown as { read: Read<A> }).read(p, f), (a) => I.exec(g(a), f))));
export const mapOrFail = mapEffect;
export const all = <const T extends ReadonlyArray<Config<any>> | Record<string, Config<any>>>(configs: T): Config<{ -readonly [K in keyof T]: T[K] extends Config<infer A> ? A : never }> =>
  mk((p, f) => {
    const keys = Object.keys(configs);
    const out: any = globalThis.Array.isArray(configs) ? [] : {};
    let i = 0;
    const loop = (): I.Step<any> => {
      while (i < keys.length) {
        const k = keys[i++]!;
        const r = ((configs as any)[k] as { read: Read<unknown> }).read(p, f);
        if (r instanceof I.Async) return I.chain(r, (v) => ((out[k] = v), loop()));
        out[k] = r;
      }
      return out;
    };
    return loop();
  });
export const nested: {
  (name: string): <A>(self: Config<A>) => Config<A>;
  <A>(self: Config<A>, name: string): Config<A>;
} = I.dual(2, <A>(self: Config<A>, name: string): Config<A> => mk((p, f) => (self as unknown as { read: Read<A> }).read(p.mapInput((path) => [name, ...path]), f)));
export const Record = <T>(value: Config<T> | undefined, name?: string): Config<Readonly<Record<string, T>>> =>
  mk<Readonly<Record<string, T>>>((p, f) => {
    const path = name === undefined ? [] : [name];
    return I.chain(I.exec(p.load(path), f), (raw) => {
      if (raw === undefined) return missing(path);
      if (typeof raw === "string") return Object.fromEntries(raw.split(",").filter(Boolean).map((kv) => kv.split("=").map((s) => s.trim()) as [string, string])) as Record<string, T>;
      return raw as Record<string, T>;
    });
  });
export const Array = <T>(value: Config<T>, name?: string): Config<ReadonlyArray<T>> =>
  mk((p, f) => {
    const path = name === undefined ? [] : [name];
    return I.chain(I.exec(p.load(path), f), (raw) => {
      if (raw === undefined) return missing(path);
      const items = typeof raw === "string" ? raw.split(",") : (raw as ReadonlyArray<unknown>);
      return items.map((x) => x) as ReadonlyArray<T>;
    });
  });
export const unwrap = <T>(wrapped: { readonly [K in keyof T]: Config<T[K]> }): Config<T> => all(wrapped as never) as never;
