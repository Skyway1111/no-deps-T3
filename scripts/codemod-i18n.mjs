#!/usr/bin/env node
// Moves gt-react / gt-react-native / gt-i18n imports onto @t3tools/shared/i18n. Idempotent.
// Usage: node scripts/codemod-i18n.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");
const TARGETS = {
  "gt-react": "@t3tools/shared/i18n/react",
  "gt-react-native": "@t3tools/shared/i18n/react",
  "gt-i18n": "@t3tools/shared/i18n",
  "gt-i18n/types": "@t3tools/shared/i18n",
};
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo", ".turbo", ".git"]);
const ENGINE = path.join(ROOT, "packages/shared/src/i18n");
// The mobile Vitest config shims gt-react-native by name; it is deleted, not rewritten.
const SKIP_FILE = /(^|\/)vite\.config\.[cm]?[jt]s$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const SPECIFIER = /(["'])(gt-(?:react-native|react|i18n)(?:\/[\w-]+)?)\1/g;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && full !== ENGINE) yield* walk(full);
    } else if (SOURCE.test(entry.name) && !SKIP_FILE.test(full)) yield full;
  }
}

function exportedNames(file) {
  const src = fs.readFileSync(path.join(ENGINE, file), "utf8");
  const names = new Set();
  for (const [, name] of src.matchAll(/^export (?:const|function|class|type|interface) (\w+)/gm)) names.add(name);
  for (const [, list] of src.matchAll(/^export (?:type )?\{([^}]*)\}/gm))
    for (const item of list.split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1);
      if (name) names.add(name);
    }
  if (/^export \* from "\.\/core\.ts"/m.test(src)) for (const name of exportedNames("core.ts")) names.add(name);
  return names;
}
const EXPORTS = {
  "@t3tools/shared/i18n": exportedNames("core.ts"),
  "@t3tools/shared/i18n/react": exportedNames("react.ts"),
};

const NAMED_IMPORT = /^import (type )?\{([^}]*)\} from "([^"]+)";\n/gm;
const specifiersOf = (typeOnly, list) =>
  list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (typeOnly && !s.startsWith("type ") ? `type ${s}` : s));

// Collapses named imports that now share a target (gt-i18n + gt-i18n/types) into the first.
function mergeImports(src, targets) {
  let merges = 0;
  for (const target of targets) {
    const statements = [...src.matchAll(NAMED_IMPORT)].filter((m) => m[3] === target);
    if (statements.length < 2) continue;
    const specifiers = [...new Set(statements.flatMap((m) => specifiersOf(m[1], m[2])))];
    const allTypes = specifiers.every((s) => s.startsWith("type "));
    const list = allTypes ? specifiers.map((s) => s.slice(5)) : specifiers;
    const merged = `import ${allTypes ? "type " : ""}{ ${list.join(", ")} } from "${target}";\n`;
    const [first, ...rest] = statements;
    for (const m of rest.reverse()) src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    src = src.slice(0, first.index) + merged + src.slice(first.index + first[0].length);
    merges += rest.length;
  }
  return { src, merges };
}

const counts = Object.fromEntries(Object.keys(TARGETS).map((k) => [k, 0]));
const changed = [];
const unmapped = [];
const unknownNames = [];
let merged = 0;

for (const file of ["apps", "packages"].flatMap((dir) => [...walk(path.join(ROOT, dir))])) {
  const before = fs.readFileSync(file, "utf8");
  if (!before.includes("gt-")) continue;
  const rel = path.relative(ROOT, file);
  const touched = new Set();
  let after = before.replace(SPECIFIER, (match, quote, spec, offset) => {
    const target = TARGETS[spec];
    if (!target) {
      unmapped.push(`${rel}:${before.slice(0, offset).split("\n").length} ${spec}`);
      return match;
    }
    counts[spec]++;
    touched.add(target);
    return `${quote}${target}${quote}`;
  });
  if (after === before) continue;
  const result = mergeImports(after, touched);
  after = result.src;
  merged += result.merges;
  for (const m of after.matchAll(/import (?:type )?\{([^}]*)\} from ["'](@t3tools\/shared\/i18n(?:\/react)?)["']/g))
    for (const s of m[1].split(",")) {
      const name = s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name && !EXPORTS[m[2]].has(name)) unknownNames.push(`${rel}: ${name} (from ${m[2]})`);
    }
  changed.push(rel);
  if (!DRY) fs.writeFileSync(file, after);
}

const byArea = {};
for (const rel of changed) {
  const area = rel.split("/").slice(0, 2).join("/");
  byArea[area] = (byArea[area] ?? 0) + 1;
}
console.log(`${DRY ? "[dry run] would rewrite" : "Rewrote"} ${changed.length} files`);
console.log("  by area:", byArea);
console.log("  specifiers:", counts, `(total ${Object.values(counts).reduce((a, b) => a + b, 0)})`);
console.log(`  merged duplicate imports: ${merged}`);
if (unmapped.length) console.log(`  unmapped (left as-is):\n    ${unmapped.join("\n    ")}`);
if (unknownNames.length) console.log(`  names the new modules do not export:\n    ${unknownNames.join("\n    ")}`);
if (!DRY && changed.length) console.log("Run the formatter: merged imports are written on one line.");
process.exitCode = unknownNames.length || unmapped.length ? 1 : 0;
