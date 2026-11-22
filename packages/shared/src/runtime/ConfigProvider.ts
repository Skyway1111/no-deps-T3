import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";
import * as Layer from "./Layer.ts";
import { TaggedError } from "./errors.ts";

export type Path = ReadonlyArray<string | number>;
export class SourceError extends TaggedError("SourceError")<{ message: string; cause?: unknown }> {}
/** `load(path)` returns the raw value (string, object, array) or undefined. */
export interface ConfigProvider extends I.Pipeable {
  readonly load: (path: Path) => I.Effect<unknown, SourceError>;
  readonly mapInput: (f: (path: Path) => Path) => ConfigProvider;
}
export const make = (get: (path: Path) => unknown): ConfigProvider => {
  const p: ConfigProvider = {
    load: (path) => I.make(() => get(path)),
    mapInput: (f) => make((path) => get(f(path))),
    pipe() {
      return I.pipeArgs(this, arguments);
    },
  };
  return p;
};
export const fromEnv = (options?: { readonly env?: Record<string, string | undefined>; readonly preserveEmptyStrings?: boolean }): ConfigProvider =>
  make((path) => {
    const env = options?.env ?? (typeof process !== "undefined" ? process.env : {});
    const v = env[path.join("_")];
    return v === "" && !options?.preserveEmptyStrings ? undefined : v;
  });
export const fromEnvRecord = (env: Record<string, string>) => fromEnv({ env });
export const fromUnknown = (root: unknown, options?: { readonly preserveEmptyStrings?: boolean }): ConfigProvider =>
  make((path) => {
    let cur: unknown = root;
    for (const k of path) {
      if (typeof cur !== "object" || cur === null) return undefined;
      cur = (cur as Record<string | number, unknown>)[k];
    }
    return cur === "" && !options?.preserveEmptyStrings ? undefined : cur;
  });
export const orElse = (self: ConfigProvider, that: ConfigProvider): ConfigProvider => ({
    load: (path) => I.make((f) => I.chain(I.exec(self.load(path), f), (v) => (v === undefined ? I.exec(that.load(path), f) : v))),
    mapInput: (fn) => orElse(self.mapInput(fn), that.mapInput(fn)),
    pipe() {
      return I.pipeArgs(this, arguments);
    },
  });
export const nested = (prefix: string) => (self: ConfigProvider): ConfigProvider => self.mapInput((p) => [prefix, ...p]);
export const constantCase = (self: ConfigProvider): ConfigProvider =>
  self.mapInput((p) => p.map((k) => (typeof k === "string" ? k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() : k)));
export const ConfigProvider = Ctx.Reference<ConfigProvider>("effect/ConfigProvider", { defaultValue: () => fromEnv() });
const resolve = <E, R>(p: ConfigProvider | I.Effect<ConfigProvider, E, R>, f: I.Fiber): I.Step<ConfigProvider> =>
  I.isEffect(p) ? I.exec(p, f) : (p as ConfigProvider);
export const layer = <E = never, R = never>(self: ConfigProvider | I.Effect<ConfigProvider, E, R>): Layer.Layer<never, E, R> =>
  Layer.fromBuild((_, __, f) => I.chain(resolve(self, f), (p) => I.makeContext(new Map([[ConfigProvider.key, p]])))) as never;
export const layerAdd = <E = never, R = never>(self: ConfigProvider | I.Effect<ConfigProvider, E, R>, options?: { readonly asPrimary?: boolean }): Layer.Layer<never, E, R> =>
  Layer.fromBuild((_, __, f) =>
    I.chain(resolve(self, f), (p) => {
      const cur = I.lookup(f.context, ConfigProvider.key) as ConfigProvider;
      return I.makeContext(new Map([[ConfigProvider.key, options?.asPrimary ? orElse(p, cur) : orElse(cur, p)]]));
    })) as never;
