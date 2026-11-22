import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const RT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..") + "/";
const map = JSON.parse(readFileSync(RT + "subpathMap.json", "utf8"));
const useEffect = process.env.RUNTIME === "effect";
const from = pathToFileURL(resolvePath(process.env.EFFECT_FROM ?? resolvePath(RT, "../../../contracts"), "package.json")).href;
const isEffectSpec = (s) => s === "effect" || s.startsWith("effect/") || s.startsWith("@effect/");

export async function resolve(spec, ctx, next) {
  if (!isEffectSpec(spec)) return next(spec, ctx);
  if (useEffect) return next(spec, { ...ctx, parentURL: from });
  if (spec in map) return { url: pathToFileURL(RT + map[spec].slice(2)).href, shortCircuit: true };
  let real = "";
  try {
    real = (await next(spec, { ...ctx, parentURL: from })).url;
  } catch {}
  return { url: `stub:${spec}#${encodeURIComponent(real)}`, shortCircuit: true };
}
/** Unmapped modules: every export is a chameleon whose calls return their schema-like argument. */
export async function load(url, ctx, next) {
  if (!url.startsWith("stub:")) return next(url, ctx);
  let names = [];
  try {
    const real = fileURLToPath(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
    if (existsSync(real)) names = [...readFileSync(real, "utf8").matchAll(/export (?:const|function|class) (\w+)|export \{([^}]*)\}|export \* as (\w+)/g)]
      .flatMap((m) => (m[2] ? m[2].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()) : [m[1] ?? m[3]]))
      .filter((n) => n && /^\w+$/.test(n));
  } catch {}
  const source = `const cham = () => new Proxy(function (...a) { return a.find((x) => x && (typeof x === "object" || typeof x === "function") && "~node" in x) ?? cham(); }, { get: (_, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "stub" : cham()) });\n${[...new Set(names)].map((n) => `export const ${n} = cham();`).join("\n")}\nexport default cham();`;
  return { format: "module", source, shortCircuit: true };
}
