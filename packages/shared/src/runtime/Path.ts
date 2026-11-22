import * as Ctx from "./Context.ts";
import * as Layer from "./Layer.ts";
import * as I from "./internal.ts";
import { badArgument, type PlatformError } from "./PlatformError.ts";

export const TypeId: unique symbol = Symbol.for("effect/Path") as never;
export interface ParsedPath {
  readonly root: string;
  readonly dir: string;
  readonly base: string;
  readonly ext: string;
  readonly name: string;
}
export interface PathService {
  readonly [TypeId]?: typeof TypeId;
  readonly sep: string;
  readonly delimiter: string;
  readonly basename: (path: string, suffix?: string) => string;
  readonly dirname: (path: string) => string;
  readonly extname: (path: string) => string;
  readonly format: (p: Partial<ParsedPath>) => string;
  readonly fromFileUrl: (url: URL) => I.Effect<string, PlatformError>;
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: ReadonlyArray<string>) => string;
  readonly normalize: (path: string) => string;
  readonly parse: (path: string) => ParsedPath;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...paths: ReadonlyArray<string>) => string;
  readonly toFileUrl: (path: string) => I.Effect<URL, PlatformError>;
  readonly toNamespacedPath: (path: string) => string;
}
export class Path extends Ctx.Service<Path, PathService>()("effect/Path") {}

const normalizeArray = (parts: ReadonlyArray<string>, allowAbove: boolean) => {
  const out: Array<string> = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (allowAbove) out.push("..");
    } else out.push(p);
  }
  return out;
};
const cwd = () => (typeof process !== "undefined" && process.cwd ? process.cwd() : "/");
/** Pure-JS POSIX implementation (browser safe). */
export const posix: PathService = {
  [TypeId]: TypeId,
  sep: "/",
  delimiter: ":",
  isAbsolute: (p) => p.startsWith("/"),
  normalize(p) {
    if (!p) return ".";
    const abs = p.startsWith("/");
    const trailing = p.endsWith("/");
    let s = normalizeArray(p.split("/"), !abs).join("/");
    if (!s && !abs) s = ".";
    if (s && trailing) s += "/";
    return (abs ? "/" : "") + s;
  },
  join: (...ps) => posix.normalize(ps.filter(Boolean).join("/") || "."),
  resolve(...ps) {
    let resolved = "";
    for (let i = ps.length - 1; i >= -1 && !resolved.startsWith("/"); i--) {
      const p = i >= 0 ? ps[i]! : cwd();
      if (p) resolved = `${p}/${resolved}`;
    }
    const s = normalizeArray(resolved.split("/"), false).join("/");
    return `/${s}`;
  },
  relative(from, to) {
    const f = posix.resolve(from).split("/").filter(Boolean);
    const t = posix.resolve(to).split("/").filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    return [...Array(f.length - i).fill(".."), ...t.slice(i)].join("/");
  },
  dirname(p) {
    if (!p) return ".";
    const s = p.replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i);
  },
  basename(p, suffix) {
    const b = p.replace(/\/+$/, "").split("/").pop() ?? "";
    return suffix && b.endsWith(suffix) && b !== suffix ? b.slice(0, -suffix.length) : b;
  },
  extname(p) {
    const b = posix.basename(p);
    const i = b.lastIndexOf(".");
    return i <= 0 ? "" : b.slice(i);
  },
  parse(p) {
    const root = p.startsWith("/") ? "/" : "";
    const base = posix.basename(p);
    const ext = posix.extname(p);
    const dir = posix.dirname(p);
    return { root, dir: dir === "." && !p.includes("/") ? "" : dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
  format: (p) => {
    const dir = p.dir ?? p.root ?? "";
    const base = p.base ?? `${p.name ?? ""}${p.ext ?? ""}`;
    return dir ? (dir === p.root ? `${dir}${base}` : `${dir}/${base}`) : base;
  },
  toNamespacedPath: (p) => p,
  fromFileUrl: (url) => I.make(() => (url.protocol === "file:" ? decodeURIComponent(url.pathname) : I.failWith(I.causeFail(badArgument({ module: "Path", method: "fromFileUrl", description: "URL must be of scheme file" }))))),
  toFileUrl: (p) => I.make(() => new URL(`file://${encodeURI(posix.resolve(p)).replace(/[?#]/g, encodeURIComponent)}`)),
};
export const layer: Layer.Layer<Path> = Layer.succeed(Path, posix);
