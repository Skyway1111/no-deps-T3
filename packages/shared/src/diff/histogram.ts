export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface StructuredPatch {
  oldFileName: string;
  newFileName: string;
  oldHeader: string | undefined;
  newHeader: string | undefined;
  hunks: StructuredPatchHunk[];
}

export interface DiffOptions {
  /** Added plus removed tokens allowed before the diff is abandoned. */
  readonly maxEditLength?: number;
  /** Milliseconds allowed before the diff is abandoned. */
  readonly timeout?: number;
}

export interface Change {
  readonly value: string;
  readonly count: number;
  readonly added?: true;
  readonly removed?: true;
}

// Up to this many edits, Myers is cheaper than interning and matches jsdiff exactly.
const MYERS_EDITS = 256;
// Minimal diffs stay exact up to this many edits; Myers' O(D²) trace would reach GiBs past it.
const MINIMAL_MYERS_EDITS = 2048;
// Tokens repeated more often than this within a region are never anchors (git's cap).
const MAX_CHAIN = 64;
// Bounds an anchorless region's O(D²) Myers; past it the region is replaced whole.
const FALLBACK_EDITS = 2048;

interface Run {
  readonly op: 0 | 1 | 2; // equal | removed | added
  readonly start: number; // index into the old tokens, or the new ones for added runs
  readonly count: number;
}

/**
 * Diffs token lists into runs, removals before additions; undefined when over budget.
 * Myers handles small diffs; larger ones split on rare shared tokens (histogram diff).
 */
function diffRuns(
  a: readonly string[],
  b: readonly string[],
  { maxEditLength = Infinity, timeout = Infinity }: DiffOptions,
  minimal = false,
): Run[] | undefined {
  const deadline = Date.now() + timeout;
  // match[i] = j + 1 when a[i] pairs with b[j].
  const match = new Int32Array(a.length);
  // Myers' first snake takes the common prefix anyway; skipping it keeps its arrays small.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) match[lo++] = lo;
  const cap = Math.min(maxEditLength, minimal ? MINIMAL_MYERS_EDITS : MYERS_EDITS);
  if (!myers(a, lo, a.length, b, lo, b.length, match, cap, deadline)) {
    // Histogram trims the suffix first too, so doing it before interning changes nothing.
    let aHi = a.length;
    let bHi = b.length;
    while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) match[--aHi] = bHi--;
    if (
      cap === maxEditLength ||
      expired(deadline) ||
      !histogram(a, lo, aHi, b, lo, bHi, match, maxEditLength, deadline)
    )
      return undefined;
  }

  const runs: Run[] = [];
  let edits = 0;
  const push = (op: Run["op"], start: number, end: number) => {
    if (end > start) runs.push({ op, start, count: end - start });
    if (op !== 0) edits += end - start;
  };
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    const i0 = i;
    const j0 = j;
    while (i < a.length && match[i] === 0) i++;
    push(1, i0, i);
    j = i < a.length ? match[i]! - 1 : b.length;
    push(2, j0, j);
    const e0 = i;
    while (i < a.length && match[i] === j + 1) (i++, j++);
    push(0, e0, i);
  }
  return edits > maxEditLength ? undefined : runs;
}

const expired = (deadline: number) => deadline !== Infinity && Date.now() > deadline;

/** Histogram diff of `a[aLo, aHi)` against `b[bLo, bHi)`; tokens outside are never read. */
function histogram(
  a: readonly string[],
  aLo0: number,
  aHi0: number,
  b: readonly string[],
  bLo0: number,
  bHi0: number,
  match: Int32Array,
  maxEditLength: number,
  deadline: number,
): boolean {
  const ids = new Map<string, number>();
  const intern = (tokens: readonly string[], lo: number, hi: number) => {
    // Indexed like the full lists so `match` needs no offsets; only [lo, hi) is filled.
    const out = new Int32Array(hi);
    for (let i = lo; i < hi; i++) {
      const token = tokens[i]!;
      let id = ids.get(token);
      if (id === undefined) ids.set(token, (id = ids.size));
      out[i] = id;
    }
    return out;
  };
  const ai = intern(a, aLo0, aHi0);
  const bi = intern(b, bLo0, bHi0);
  const head = new Int32Array(ids.size).fill(-1);
  const count = new Int32Array(ids.size);
  const next = new Int32Array(ai.length);
  const regions = [aLo0, aHi0, bLo0, bHi0];

  while (regions.length > 0) {
    let bHi = regions.pop()!;
    let bLo = regions.pop()!;
    let aHi = regions.pop()!;
    let aLo = regions.pop()!;
    while (aLo < aHi && bLo < bHi && ai[aLo] === bi[bLo]) match[aLo++] = ++bLo;
    while (aLo < aHi && bLo < bHi && ai[aHi - 1] === bi[bHi - 1]) match[--aHi] = bHi--;
    if (aLo === aHi || bLo === bHi) continue;
    if (expired(deadline)) return false;

    for (let i = aHi - 1; i >= aLo; i--) {
      const t = ai[i]!;
      next[i] = head[t]!;
      head[t] = i;
      count[t]!++;
    }
    let common = false;
    let bestCount = MAX_CHAIN + 1;
    let bestLen = 0;
    let bestA = 0;
    let bestB = 0;
    for (let j = bLo; j < bHi;) {
      const t = bi[j]!;
      let nextJ = j + 1;
      if (count[t]! > 0) common = true;
      if (count[t]! <= bestCount) {
        for (let i = head[t]!; i !== -1; i = next[i]!) {
          let as = i;
          let bs = j;
          let ae = i + 1;
          let be = j + 1;
          let runCount = count[t]!;
          while (as > aLo && bs > bLo && ai[as - 1] === bi[bs - 1]) {
            runCount = Math.min(runCount, count[ai[--as]!]!);
            bs--;
          }
          while (ae < aHi && be < bHi && ai[ae] === bi[be]) {
            runCount = Math.min(runCount, count[ai[ae++]!]!);
            be++;
          }
          if (runCount < bestCount || (runCount === bestCount && ae - as > bestLen)) {
            bestCount = runCount;
            bestLen = ae - as;
            bestA = as;
            bestB = bs;
          }
          if (be > nextJ) nextJ = be;
        }
      }
      j = nextJ;
    }
    for (let i = aLo; i < aHi; i++) {
      head[ai[i]!] = -1;
      count[ai[i]!] = 0;
    }

    if (bestLen > 0) {
      for (let k = 0; k < bestLen; k++) match[bestA + k] = bestB + k + 1;
      regions.push(aLo, bestA, bLo, bestB, bestA + bestLen, aHi, bestB + bestLen, bHi);
    } else if (common) {
      const cap = Math.min(maxEditLength, FALLBACK_EDITS);
      if (!myers(ai, aLo, aHi, bi, bLo, bHi, match, cap, deadline) && expired(deadline))
        return false;
    }
  }
  return true;
}

/** Greedy Myers over one region, writing `match` only on success; O(D²) memory. */
function myers<T>(
  a: ArrayLike<T>,
  aLo: number,
  aHi: number,
  b: ArrayLike<T>,
  bLo: number,
  bHi: number,
  match: Int32Array,
  maxEditLength: number,
  deadline: number,
): boolean {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const max = Math.min(n + m, maxEditLength);
  const v = new Int32Array(2 * max + 3);
  const off = max + 1;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (expired(deadline)) return false;
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) (x++, y++);
      v[off + k] = x;
      if (x < n || y < m) continue;
      // Walk back through each step's frontier (trace[d] holds diagonals -d..d).
      for (let dd = d; dd >= 0; dd--) {
        const kk = x - y;
        const prev = trace[dd - 1];
        const down =
          prev !== undefined && (kk === -dd || (kk !== dd && prev[kk + dd - 2]! < prev[kk + dd]!));
        const px = prev === undefined ? 0 : down ? prev[kk + dd]! : prev[kk + dd - 2]! + 1;
        while (x > px) match[aLo + --x] = bLo + --y + 1;
        if (prev === undefined) continue;
        x = down ? px : px - 1;
        y = x - (down ? kk + 1 : kk - 1);
      }
      return true;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return false;
}

/** Lines with their own `\n` or `\r\n`, like jsdiff. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start) + 1 || text.length;
    lines.push(text.slice(start, end));
    start = end;
  }
  return lines;
}

export function structuredPatch(
  oldFileName: string,
  newFileName: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
  options: DiffOptions & { readonly context?: number } = {},
): StructuredPatch | undefined {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  const runs = diffRuns(a, b, options);
  if (runs === undefined) return undefined;
  const context = options.context ?? 4;
  const hunks: StructuredPatchHunk[] = [];
  const out = (prefix: string, line: string, lines: string[]) =>
    line.endsWith("\n")
      ? lines.push(prefix + line.slice(0, -1))
      : lines.push(prefix + line, "\\ No newline at end of file");
  let hunk: StructuredPatchHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  runs.forEach((run, index) => {
    if (run.op !== 0) {
      if (hunk === undefined) {
        const lead = index === 0 ? 0 : Math.min(context, runs[index - 1]!.count);
        hunk = {
          oldStart: oldLine - lead + 1,
          oldLines: lead,
          newStart: newLine - lead + 1,
          newLines: lead,
          lines: [],
        };
        for (let i = oldLine - lead; i < oldLine; i++) out(" ", a[i]!, hunk.lines);
      }
      const lines = run.op === 1 ? a : b;
      for (let i = run.start; i < run.start + run.count; i++)
        out(run.op === 1 ? "-" : "+", lines[i]!, hunk.lines);
      if (run.op === 1) ((oldLine += run.count), (hunk.oldLines += run.count));
      else ((newLine += run.count), (hunk.newLines += run.count));
      return;
    }
    if (hunk !== undefined) {
      const keep =
        run.count <= context * 2 && index < runs.length - 1
          ? run.count
          : Math.min(run.count, context);
      for (let i = oldLine; i < oldLine + keep; i++) out(" ", a[i]!, hunk.lines);
      hunk.oldLines += keep;
      hunk.newLines += keep;
      if (keep !== run.count || index === runs.length - 1) (hunks.push(hunk), (hunk = undefined));
    }
    oldLine += run.count;
    newLine += run.count;
  });
  if (hunk !== undefined) hunks.push(hunk);
  return { oldFileName, newFileName, oldHeader, newHeader, hunks };
}

/** Unified diff with `---`/`+++` file headers (jsdiff's `FILE_HEADERS_ONLY`). */
export function formatPatch(patch: StructuredPatch): string {
  const tab = (header: string | undefined) => (header === undefined ? "" : `\t${header}`);
  // An empty side starts before line 1.
  const start = (line: number, count: number) => `${count === 0 ? line - 1 : line},${count}`;
  const out = [
    `--- ${patch.oldFileName}${tab(patch.oldHeader)}`,
    `+++ ${patch.newFileName}${tab(patch.newHeader)}`,
  ];
  for (const h of patch.hunks) {
    out.push(
      `@@ -${start(h.oldStart, h.oldLines)} +${start(h.newStart, h.newLines)} @@`,
      ...h.lines,
    );
  }
  return `${out.join("\n")}\n`;
}

const WORD_CHARS =
  "a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
const WORD_TOKEN = new RegExp(`(\\r?\\n)|[${WORD_CHARS}]+|[^\\S\\n\\r]+|[^${WORD_CHARS}]`, "gu");

/** jsdiff-compatible word diff where whitespace runs and newlines are their own tokens. */
export function diffWordsWithSpace(oldStr: string, newStr: string): Change[] {
  const a = oldStr.match(WORD_TOKEN) ?? [];
  const b = newStr.match(WORD_TOKEN) ?? [];
  return diffRuns(a, b, {}, true)!.map(({ op, start, count }) => {
    const value = (op === 2 ? b : a).slice(start, start + count).join("");
    return op === 0
      ? { value, count }
      : op === 1
        ? { value, count, removed: true }
        : { value, count, added: true };
  });
}
